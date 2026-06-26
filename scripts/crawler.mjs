#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const IMAGE_KIND_KEYWORDS = {
  floorplan: [/間取り/, /間取/, /平面図/, /プラン/, /madori/i, /floor.?plan/i, /layout/i, /plan/i],
  exterior: [/外観/, /外装/, /建物外/, /外部/, /exterior/i, /facade/i, /appearance/i],
  interior: [/内観/, /室内/, /リビング/, /キッチン/, /寝室/, /interior/i, /living/i, /kitchen/i, /bedroom/i],
  sitePlan: [/配置/, /区画/, /敷地/, /site.?plan/i, /plot/i, /land/i]
};

const RELEVANT_URL_KEYWORDS = [
  /新築/,
  /建売/,
  /分譲/,
  /戸建/,
  /住宅/,
  /物件/,
  /間取り/,
  /施工事例/,
  /モデルハウス/,
  /house/i,
  /home/i,
  /estate/i,
  /property/i,
  /plan/i,
  /works/i
];

class StopSiteError extends Error {
  constructor(result, message) {
    super(message);
    this.result = result;
  }
}

const args = parseArgs(process.argv.slice(2));
const candidates = [];
const logs = [];

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

async function main() {
  const configPath = args.config ?? "crawler.config.json";
  const outPath = args.out ?? path.join("crawler-output", "latest-crawl.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const global = {
    userAgent: "FloorplanLibraryCrawler/0.1 (+personal low-frequency crawler; respects robots.txt)",
    requestTimeoutSeconds: 30,
    maxPagesPerRun: 25,
    maxImagesPerCandidate: 24,
    imageFetchLimit: 6,
    maxImageBytes: 3 * 1024 * 1024,
    ...(config.global ?? {})
  };

  for (const site of config.sites ?? []) {
    await crawlSite(normalizeSite(site), global);
  }

  const result = {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: "local-crawler",
    candidates,
    logs
  };

  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(result, null, 2), "utf8");
  console.log(`巡回完了: 候補 ${candidates.length}件 / ログ ${logs.length}件`);
  console.log(`出力: ${outPath}`);
}

async function crawlSite(site, global) {
  if (!site.enabled) {
    addLog(site, "-", "停止", "停止中", "サイト設定がOFFのため巡回しません。");
    return;
  }

  if (!site.searchUrl && site.manualUrls.length === 0) {
    addLog(site, "-", "停止", "停止中", "searchUrl または manualUrls が未設定です。");
    return;
  }

  if (site.majorPortal && !site.userAcknowledgedMajorPortal) {
    addLog(
      site,
      site.searchUrl || "-",
      "停止",
      "停止中",
      "大手ポータルは userAcknowledgedMajorPortal: true を明示した場合のみ巡回します。"
    );
    return;
  }

  if (site.majorPortal && site.imageSaveMode === "storeImage") {
    addLog(site, site.searchUrl || "-", "停止", "停止中", "大手ポータルの画像本体保存は許可していません。");
    return;
  }

  const origin = siteOrigin(site);
  const robots = await loadRobots(site, origin, global);
  if (!robots.ok) return;

  let pageBudget = Math.min(site.perRunLimit, global.maxPagesPerRun);
  const queue = [];
  const seen = new Set();
  const addUrl = (url) => {
    const normalized = normalizeUrl(url, origin);
    if (!normalized || seen.has(normalized) || !isSameHost(normalized, origin)) return;
    seen.add(normalized);
    queue.push(normalized);
  };

  site.manualUrls.forEach(addUrl);
  if (site.searchUrl) addUrl(site.searchUrl);

  if (site.crawlMode !== "manualOnly") {
    const sitemapUrls = await loadSitemapUrls(site, origin, robots, global);
    sitemapUrls.filter(looksRelevantUrl).slice(0, pageBudget).forEach(addUrl);
  }

  let requestCount = 0;
  while (queue.length && pageBudget > 0) {
    const url = queue.shift();
    if (!isAllowedByRobots(robots.rules, url)) {
      addLog(site, url, "詳細取得", "robots禁止", "robots.txtで禁止されているため取得しません。");
      continue;
    }

    try {
      await politeWait(site, requestCount);
      const html = await fetchText(url, site, global, "詳細取得");
      requestCount += 1;
      pageBudget -= 1;

      if (site.crawlMode !== "manualOnly") {
        extractLinks(html, url).filter(looksRelevantUrl).slice(0, pageBudget).forEach(addUrl);
      }

      const candidate = extractCandidate(html, url, site, global);
      if (candidate) {
        if (shouldFetchImageBodies(site)) {
          await attachPermittedImageBodies(candidate, site, robots, global, () => politeWait(site, requestCount++));
        }
        candidates.push(candidate);
        addLog(site, url, "候補保存", "成功", `${candidate.title} を確認待ち候補として保存しました。`);
      }
    } catch (error) {
      if (error instanceof StopSiteError) {
        addLog(site, url, "停止", error.result, error.message);
        return;
      }
      addLog(site, url, "エラー", "停止中", error instanceof Error ? error.message : String(error));
      return;
    }
  }

  if (pageBudget <= 0) {
    addLog(site, site.searchUrl || origin, "停止", "上限到達", "1回あたりの取得上限に到達しました。");
  }
}

async function loadRobots(site, origin, global) {
  const robotsUrl = new URL("/robots.txt", origin).toString();
  try {
    const response = await fetchWithTimeout(robotsUrl, global);
    if (response.status === 404) {
      addLog(site, robotsUrl, "robots確認", "成功", "robots.txtが見つからないため、明示的な禁止なしとして扱います。");
      return { ok: true, rules: [] };
    }
    if (!response.ok) {
      addLog(site, robotsUrl, "robots確認", "停止中", `robots.txt確認でHTTP ${response.status}`);
      return { ok: false, rules: [] };
    }
    const text = await response.text();
    const rules = parseRobots(text, global.userAgent);
    addLog(site, robotsUrl, "robots確認", "成功", `${rules.length}件のrobotsルールを読み込みました。`);
    return { ok: true, rules };
  } catch (error) {
    addLog(site, robotsUrl, "robots確認", "停止中", `robots.txt確認に失敗したため停止: ${error.message}`);
    return { ok: false, rules: [] };
  }
}

async function loadSitemapUrls(site, origin, robots, global) {
  const sitemapUrl = site.sitemapUrl || new URL("/sitemap.xml", origin).toString();
  if (!isAllowedByRobots(robots.rules, sitemapUrl)) {
    addLog(site, sitemapUrl, "sitemap確認", "robots禁止", "sitemap.xml がrobots.txtで禁止されています。");
    return [];
  }
  try {
    const text = await fetchText(sitemapUrl, site, global, "sitemap確認", { allowNotFound: true });
    if (!text) return [];
    const urls = [...text.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)].map((match) => decodeHtml(match[1].trim()));
    addLog(site, sitemapUrl, "sitemap確認", "成功", `${urls.length}件のURLを検出しました。`);
    return urls;
  } catch (error) {
    if (error instanceof StopSiteError) throw error;
    addLog(site, sitemapUrl, "sitemap確認", "停止中", `sitemap確認をスキップ: ${error.message}`);
    return [];
  }
}

async function fetchText(url, site, global, action, options = {}) {
  const response = await fetchWithTimeout(url, global);
  if (options.allowNotFound && response.status === 404) {
    addLog(site, url, action, "成功", "対象ファイルは見つかりませんでした。");
    return "";
  }
  if (response.status === 403) throw new StopSiteError("403", "403を検出したため、このサイトの巡回を停止します。");
  if (response.status === 429) throw new StopSiteError("429", "429を検出したため、このサイトの巡回を停止します。");
  if (response.status >= 500) throw new StopSiteError("5xx", `${response.status}を検出したため、このサイトの巡回を停止します。`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const text = await response.text();
  const block = detectBlockPage(text);
  if (block) throw new StopSiteError(block.result, block.message);
  addLog(site, response.url || url, action, "成功", `HTMLを取得しました。`);
  return text;
}

async function fetchWithTimeout(url, global) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), global.requestTimeoutSeconds * 1000);
  try {
    return await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": global.userAgent,
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      }
    });
  } finally {
    clearTimeout(timeout);
  }
}

function detectBlockPage(html) {
  const text = stripHtml(html).slice(0, 4000).toLowerCase();
  if (/captcha|recaptcha|認証コード|私はロボットではありません/.test(text)) {
    return { result: "CAPTCHA検出", message: "CAPTCHAらしきページを検出したため停止します。" };
  }
  if (
    /ログインしてください|ログインが必要|ログインして|会員専用|認証が必要|login required|please sign in|sign in required/.test(
      text
    )
  ) {
    return { result: "ログイン要求", message: "ログイン要求ページを検出したため停止します。" };
  }
  if (/access denied|forbidden|アクセス拒否|閲覧できません/.test(text)) {
    return { result: "403", message: "アクセス拒否らしきページを検出したため停止します。" };
  }
  return null;
}

function extractCandidate(html, pageUrl, site, global) {
  const title = firstText([
    getMeta(html, "og:title"),
    getMeta(html, "twitter:title"),
    getTagText(html, "h1"),
    getTagText(html, "title")
  ]);
  const text = normalizeWhitespace(stripHtml(html));
  const images = extractImages(html, pageUrl, global.maxImagesPerCandidate);
  const layout = extractLayout(text);
  const areaSqm = extractArea(text);
  const priceManYen = extractPrice(text);
  const floors = extractFloors(text);
  const entranceDirection = extractEntranceDirection(text);
  const company = extractCompany(text);

  if (!title && !layout && !areaSqm && !priceManYen && images.length === 0) return null;

  return {
    id: `candidate_${hashId(pageUrl)}`,
    title: title || "確認待ち候補",
    listingSource: site.siteName,
    sourceUrl: pageUrl,
    siteId: site.id,
    company,
    priceManYen,
    layout,
    areaSqm,
    tsubo: areaSqm ? Math.round((areaSqm / 3.305785) * 100) / 100 : undefined,
    floors,
    entranceDirection,
    hasFloorplanImage: images.some((image) => image.kind === "floorplan"),
    imageUrlCandidates: images.map((image) => image.url),
    imageCandidates: images,
    fetchedAt: new Date().toISOString(),
    errorInfo: "",
    memo: "ローカル巡回で作成。正式登録前に元ページと画像利用条件を確認してください。"
  };
}

function extractImages(html, pageUrl, limit) {
  const images = [];
  const seen = new Set();
  const ogImage = getMeta(html, "og:image") || getMeta(html, "twitter:image");
  if (ogImage) {
    const url = normalizeUrl(ogImage, pageUrl);
    if (url) {
      seen.add(url);
      images.push({
        id: `image_candidate_${hashId(`${pageUrl}:${url}`)}`,
        kind: classifyImage("", url),
        url,
        alt: "OG画像",
        sourceUrl: pageUrl
      });
    }
  }

  for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
    const attrs = parseAttributes(match[0]);
    const rawUrl = attrs.src || attrs["data-src"] || attrs["data-original"] || attrs["data-lazy"] || firstSrcsetUrl(attrs.srcset);
    const url = normalizeUrl(rawUrl, pageUrl);
    if (!url || seen.has(url) || url.startsWith("data:")) continue;
    seen.add(url);
    const alt = decodeHtml(attrs.alt || attrs.title || "");
    images.push({
      id: `image_candidate_${hashId(`${pageUrl}:${url}`)}`,
      kind: classifyImage(alt, url),
      url,
      alt,
      sourceUrl: pageUrl
    });
    if (images.length >= limit) break;
  }
  return images;
}

async function attachPermittedImageBodies(candidate, site, robots, global, waitBeforeFetch) {
  const targets = candidate.imageCandidates.slice(0, global.imageFetchLimit);
  for (const image of targets) {
    if (!isAllowedByRobots(robots.rules, image.url)) {
      addLog(site, image.url, "画像候補検出", "robots禁止", "画像URLがrobots.txtで禁止されているため本体保存しません。");
      continue;
    }
    try {
      await waitBeforeFetch();
      const response = await fetchWithTimeout(image.url, global);
      if (!response.ok) continue;
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.startsWith("image/")) continue;
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength > global.maxImageBytes) {
        addLog(site, image.url, "画像候補検出", "上限到達", "画像サイズ上限を超えたためURL候補のみ保存します。");
        continue;
      }
      image.dataUrl = `data:${contentType};base64,${buffer.toString("base64")}`;
      addLog(site, image.url, "画像候補検出", "成功", "許可済み巡回として画像本体を保存しました。");
    } catch (error) {
      addLog(site, image.url, "画像候補検出", "停止中", `画像本体保存をスキップ: ${error.message}`);
    }
  }
}

function shouldFetchImageBodies(site) {
  return !site.majorPortal && site.crawlMode === "permitted" && site.imageAutoFetch && site.imageSaveMode === "storeImage";
}

function extractLinks(html, baseUrl) {
  const links = [];
  for (const match of html.matchAll(/<a\b[^>]*href\s*=\s*(["']?)([^"'\s>]+)\1[^>]*>(.*?)<\/a>/gis)) {
    const url = normalizeUrl(decodeHtml(match[2]), baseUrl);
    if (!url || /^(mailto:|tel:|javascript:)/i.test(url)) continue;
    const anchorText = stripHtml(match[3]);
    if (looksRelevantUrl(`${url} ${anchorText}`)) links.push(url);
  }
  return [...new Set(links)];
}

function parseRobots(text, userAgent) {
  const groups = [];
  let current = { agents: [], rules: [] };
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, "").trim();
    if (!line) continue;
    const [rawKey, ...rest] = line.split(":");
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(":").trim();
    if (key === "user-agent") {
      if (current.rules.length > 0) {
        groups.push(current);
        current = { agents: [], rules: [] };
      }
      current.agents.push(value.toLowerCase());
    } else if (key === "allow" || key === "disallow") {
      current.rules.push({ type: key, path: value });
    }
  }
  if (current.agents.length || current.rules.length) groups.push(current);

  const ua = userAgent.toLowerCase();
  const exact = groups.find((group) => group.agents.some((agent) => agent !== "*" && ua.includes(agent)));
  const wildcard = groups.find((group) => group.agents.includes("*"));
  return (exact ?? wildcard)?.rules ?? [];
}

function isAllowedByRobots(rules, targetUrl) {
  if (!rules.length) return true;
  const url = new URL(targetUrl);
  const targetPath = `${url.pathname}${url.search}`;
  let winningRule = null;
  for (const rule of rules) {
    if (rule.path === "" && rule.type === "disallow") continue;
    if (!robotsPathMatches(rule.path, targetPath)) continue;
    if (!winningRule || rule.path.length > winningRule.path.length) winningRule = rule;
  }
  return winningRule ? winningRule.type === "allow" : true;
}

function robotsPathMatches(rulePath, targetPath) {
  if (!rulePath) return false;
  const escaped = rulePath.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$/g, "$");
  return new RegExp(`^${escaped}`).test(targetPath);
}

function extractPrice(text) {
  const match = text.match(/([0-9,]+(?:\.[0-9]+)?)\s*万円/);
  return match ? Number(match[1].replace(/,/g, "")) : undefined;
}

function extractLayout(text) {
  const match = text.match(/\b([2-5]\s*LDK)\b/i);
  if (!match) return "";
  return match[1].replace(/\s+/g, "").toUpperCase();
}

function extractArea(text) {
  const match = text.match(/(?:建物|延床|床)?(?:面積)?\s*([0-9]+(?:\.[0-9]+)?)\s*(?:㎡|m2|m²)/i);
  return match ? Number(match[1]) : undefined;
}

function extractFloors(text) {
  if (/平屋/.test(text)) return "平屋";
  if (/2階建|二階建/.test(text)) return "2階建";
  if (/3階建|三階建/.test(text)) return "3階建";
  return "";
}

function extractEntranceDirection(text) {
  const match = text.match(/玄関.{0,12}(東|西|南|北)/);
  return match?.[1] ?? "";
}

function extractCompany(text) {
  const match = text.match(/(?:会社名|施工会社|販売会社|売主|建築会社)\s*[:：]?\s*([^\s｜|]{2,40})/);
  return match?.[1] ?? "";
}

function classifyImage(alt, url) {
  const haystack = `${alt} ${url}`;
  for (const [kind, patterns] of Object.entries(IMAGE_KIND_KEYWORDS)) {
    if (patterns.some((pattern) => pattern.test(haystack))) return kind;
  }
  return "other";
}

function getMeta(html, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<meta[^>]+(?:property|name)=[\"']${escaped}[\"'][^>]+content=[\"']([^\"']+)[\"'][^>]*>`, "i");
  const reversePattern = new RegExp(`<meta[^>]+content=[\"']([^\"']+)[\"'][^>]+(?:property|name)=[\"']${escaped}[\"'][^>]*>`, "i");
  return decodeHtml(html.match(pattern)?.[1] ?? html.match(reversePattern)?.[1] ?? "");
}

function getTagText(html, tagName) {
  return decodeHtml(stripHtml(html.match(new RegExp(`<${tagName}\\b[^>]*>(.*?)<\\/${tagName}>`, "is"))?.[1] ?? ""));
}

function parseAttributes(tag) {
  const attrs = {};
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    attrs[match[1].toLowerCase()] = decodeHtml(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attrs;
}

function firstSrcsetUrl(srcset) {
  return srcset?.split(",")[0]?.trim().split(/\s+/)[0] ?? "";
}

function firstText(values) {
  return normalizeWhitespace(values.find((value) => normalizeWhitespace(value)) ?? "");
}

function stripHtml(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

function normalizeWhitespace(value) {
  return decodeHtml(value).replace(/\s+/g, " ").trim();
}

function decodeHtml(value) {
  return String(value ?? "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, "/");
}

function normalizeUrl(rawUrl, baseUrl) {
  if (!rawUrl || rawUrl.startsWith("#")) return "";
  try {
    return new URL(rawUrl, baseUrl).toString();
  } catch {
    return "";
  }
}

function looksRelevantUrl(value) {
  return RELEVANT_URL_KEYWORDS.some((pattern) => pattern.test(value));
}

function siteOrigin(site) {
  if (site.searchUrl) return new URL(site.searchUrl).origin;
  if (site.manualUrls.length > 0) return new URL(site.manualUrls[0]).origin;
  return `https://${site.domain}`;
}

function isSameHost(targetUrl, origin) {
  const target = new URL(targetUrl);
  const base = new URL(origin);
  return target.hostname === base.hostname || target.hostname.endsWith(`.${base.hostname}`);
}

async function politeWait(site, requestCount) {
  if (requestCount <= 0) return;
  const maxDelay = args.maxDelaySeconds ? Number(args.maxDelaySeconds) : undefined;
  const seconds = maxDelay === undefined ? site.delaySeconds : Math.min(site.delaySeconds, maxDelay);
  if (seconds > 0) await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

function normalizeSite(site) {
  return {
    id: site.id || `site_${hashId(site.domain || site.siteName || crypto.randomUUID())}`,
    siteName: site.siteName || site.domain || "未設定サイト",
    domain: site.domain || "",
    searchUrl: site.searchUrl || "",
    manualUrls: site.manualUrls ?? [],
    enabled: Boolean(site.enabled),
    userAcknowledgedMajorPortal: Boolean(site.userAcknowledgedMajorPortal),
    crawlMode: site.crawlMode || "manualOnly",
    perRunLimit: Number(site.perRunLimit ?? 3),
    delaySeconds: Number(site.delaySeconds ?? 120),
    sitemapUrl: site.sitemapUrl || "",
    imageAutoFetch: Boolean(site.imageAutoFetch),
    imageSaveMode: site.imageSaveMode || "none",
    majorPortal: Boolean(site.majorPortal)
  };
}

function addLog(site, url, action, result, message) {
  logs.push({
    id: `log_${crypto.randomUUID()}`,
    createdAt: new Date().toISOString(),
    siteName: site.siteName,
    domain: site.domain || safeHostname(url),
    url,
    action,
    result,
    message
  });
  console.log(`[${site.siteName}] ${action} ${result}: ${message}`);
}

function safeHostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "-";
  }
}

function hashId(value) {
  return crypto.createHash("sha1").update(value).digest("hex").slice(0, 16);
}

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      result[key] = true;
    } else {
      result[key] = next;
      i += 1;
    }
  }
  return result;
}
