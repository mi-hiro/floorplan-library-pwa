#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { gunzipSync } from "node:zlib";

const DEFAULT_QUERIES = [
  "*.jp/*madori*",
  "*.jp/*間取り*",
  "*.jp/*floorplan*",
  "*.jp/*floor-plan*",
  "*.jp/*floor_plan*",
  "*.jp/*madori*.jpg",
  "*.jp/*madori*.png",
  "*.jp/*floorplan*.jpg",
  "*.jp/*floorplan*.png",
  "*.jp/*施工事例*間取り*"
];

const DEFAULT_INDEX_IDS = ["CC-MAIN-2026-25", "CC-MAIN-2026-21", "CC-MAIN-2026-18", "CC-MAIN-2026-13"];
const COMMON_CRAWL_INDEX_LIST = "https://index.commoncrawl.org/collinfo.json";
const args = parseArgs(process.argv.slice(2));
const logs = [];

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

async function main() {
  const configPath = args.config ?? "common-crawl.config.json";
  const outPath = args.out ?? path.join("crawler-output", "latest-crawl.json");
  const config = await readOptionalJson(configPath);
  if (config.enabled === false) {
    console.log("Common Crawl collection is disabled in config.");
    return;
  }

  const maxQueriesPerDomain = Number(args.maxQueriesPerDomain ?? config.maxQueriesPerDomain ?? 2);
  const seedQueries = balancedSeedQueries(config.seedUrls ?? [], maxQueriesPerDomain);
  const broadQueries = config.queries?.length ? config.queries : DEFAULT_QUERIES;
  const allQueries = seedQueries.length && !parseBool(config.includeBroadQueries, false) ? seedQueries : [...seedQueries, ...broadQueries];
  const maxQueries = Number(args.maxQueries ?? config.maxQueries ?? 16);
  const queries = allQueries.slice(0, Math.max(1, maxQueries));
  const perQuery = Number(args.perQuery ?? config.perQuery ?? 40);
  const targetCount = Number(args.targetCount ?? config.targetCount ?? 1000);
  const mergeExisting = parseBool(args.mergeExisting ?? config.mergeExisting, true);
  const fetchArchivedPages = parseBool(args.fetchArchivedPages ?? config.fetchArchivedPages, true);
  const maxArchivedPages = Number(args.maxArchivedPages ?? config.maxArchivedPages ?? 40);
  const indexTimeoutMs = Number(args.indexTimeoutSeconds ?? config.indexTimeoutSeconds ?? 15) * 1000;
  const archiveTimeoutMs = Number(args.archiveTimeoutSeconds ?? config.archiveTimeoutSeconds ?? 20) * 1000;
  const indexRetries = Number(args.indexRetries ?? config.indexRetries ?? 1);
  const archiveRetries = Number(args.archiveRetries ?? config.archiveRetries ?? 1);
  const maxIndexes = Number(args.maxIndexes ?? config.maxIndexes ?? 1);
  const looseImageCandidates = parseBool(args.looseImageCandidates ?? config.looseImageCandidates, false);
  const indexIds = (await resolveIndexIds(config.indexIds)).slice(0, Math.max(1, maxIndexes));
  const allowedDomains = new Set((config.allowedDomains ?? []).map((value) => String(value).toLowerCase()));
  const blockedDomains = new Set((config.blockedDomains ?? []).map((value) => String(value).toLowerCase()));

  const rawRecords = [];
  for (const indexId of indexIds) {
    for (const query of queries) {
      if (rawRecords.length >= targetCount * 3) break;
      const records = await fetchIndexRecords(indexId, query, perQuery, indexTimeoutMs, indexRetries);
      rawRecords.push(...records);
    }
  }

  const archivedCandidates = fetchArchivedPages
    ? await collectArchivedCandidates(rawRecords, allowedDomains, blockedDomains, maxArchivedPages, archiveTimeoutMs, archiveRetries, {
        looseImageCandidates
      })
    : [];
  const indexCandidates = rawRecords
    .map((record) => recordToCandidate(record, allowedDomains, blockedDomains))
    .filter((candidate) => candidate?.hasFloorplanImage);
  const candidates = dedupeCandidates(
    [...archivedCandidates, ...indexCandidates]
  ).slice(0, targetCount);

  const result = {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: "local-crawler",
    candidates,
    logs
  };

  if (mergeExisting) {
    const existing = await readOptionalJson(outPath);
    result.candidates = dedupeCandidates([...(existing.candidates ?? []), ...result.candidates]).slice(0, targetCount);
    result.logs = dedupeLogs([...(existing.logs ?? []), ...result.logs]);
  }

  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(result, null, 2), "utf8");
  console.log(`Common Crawl finished: ${result.candidates.length} candidates`);
  console.log(`Output: ${outPath}`);
}

async function resolveIndexIds(configuredIndexIds = []) {
  if (configuredIndexIds.length) return configuredIndexIds;
  try {
    const response = await fetchWithTimeout(COMMON_CRAWL_INDEX_LIST, {}, 30000);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const indexes = await response.json();
    const ids = indexes
      .map((item) => item.id)
      .filter(Boolean)
      .slice(0, 4);
    addLog("Common Crawl", COMMON_CRAWL_INDEX_LIST, "index-list", "success", `${ids.length} indexes`);
    return ids.length ? ids : DEFAULT_INDEX_IDS;
  } catch (error) {
    addLog("Common Crawl", COMMON_CRAWL_INDEX_LIST, "index-list", "skipped", `Using fallback indexes: ${error.message}`);
    return DEFAULT_INDEX_IDS;
  }
}

async function fetchIndexRecords(indexId, query, perQuery, timeoutMs, retries) {
  const url = new URL(`https://index.commoncrawl.org/${indexId}-index`);
  url.searchParams.set("url", query);
  url.searchParams.set("output", "json");
  url.searchParams.set("fl", "url,mime,status,timestamp,digest,filename,offset,length");
  url.searchParams.set("filter", "status:200");
  url.searchParams.set("collapse", "urlkey");
  url.searchParams.set("limit", String(Math.max(1, perQuery)));

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
    const response = await fetchWithTimeout(url, { accept: "application/json" }, timeoutMs);
    if (response.status === 404) {
      addLog("Common Crawl", url.toString(), "index-query", "skipped", `${indexId} not available`);
      return [];
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    const records = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => safeJsonParse(line))
      .filter(Boolean);
    addLog("Common Crawl", url.toString(), "index-query", "success", `${query}: ${records.length} records`);
    return records.map((record) => ({ ...record, indexId, query }));
    } catch (error) {
      if (attempt < retries) {
        addLog("Common Crawl", url.toString(), "index-query", "retry", `${query}: ${error.message}`);
        await wait(1000 * (attempt + 1));
        continue;
      }
      addLog("Common Crawl", url.toString(), "index-query", "skipped", `${query}: ${error.message}`);
      return [];
    }
  }
  return [];
}

async function collectArchivedCandidates(records, allowedDomains, blockedDomains, maxArchivedPages, archiveTimeoutMs, archiveRetries, options = {}) {
  const htmlRecords = dedupeRecords(records)
    .filter((record) => isHtmlRecord(record))
    .filter((record) => recordHasArchiveLocation(record))
    .filter((record) => {
      const url = normalizeUrl(record.url);
      if (!url) return false;
      const hostname = safeHostname(url).toLowerCase();
      if (!hostname || isBlocked(hostname, blockedDomains)) return false;
      if (allowedDomains.size && !isAllowed(hostname, allowedDomains)) return false;
      return looksRelevant(decodeUrlForSignals(url), record.mime);
    })
    .slice(0, Math.max(0, maxArchivedPages));

  const candidates = [];
  for (const record of htmlRecords) {
    const html = await fetchArchivedHtml(record, archiveTimeoutMs, archiveRetries);
    if (!html) continue;
    const candidate = htmlRecordToCandidate(record, html, options);
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

async function fetchArchivedHtml(record, timeoutMs, retries) {
  const warcUrl = `https://data.commoncrawl.org/${record.filename}`;
  const offset = Number(record.offset);
  const length = Number(record.length);
  if (!Number.isFinite(offset) || !Number.isFinite(length) || length <= 0) return "";
  const end = offset + length - 1;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchWithTimeout(
        warcUrl,
        {
          accept: "application/octet-stream",
          range: `bytes=${offset}-${end}`
        },
        timeoutMs
      );
      if (response.status !== 206) throw new Error(`range request returned HTTP ${response.status}`);
      const compressed = Buffer.from(await response.arrayBuffer());
      const warcText = gunzipSync(compressed).toString("utf8");
      const html = extractHttpBodyFromWarc(warcText);
      if (!html) throw new Error("empty archived body");
      addLog("Common Crawl", record.url, "archive-html", "success", `Fetched archived HTML from ${record.indexId}`);
      return html;
    } catch (error) {
      if (attempt < retries) {
        addLog("Common Crawl", record.url, "archive-html", "retry", error.message);
        await wait(1000 * (attempt + 1));
        continue;
      }
      addLog("Common Crawl", record.url, "archive-html", "skipped", error.message);
      return "";
    }
  }
  return "";
}

function htmlRecordToCandidate(record, html, options = {}) {
  const pageUrl = normalizeUrl(record.url);
  if (!pageUrl) return null;
  const title = firstText([
    getMeta(html, "og:title"),
    getMeta(html, "twitter:title"),
    getTagText(html, "h1"),
    getTagText(html, "title"),
    makeTitle(pageUrl, record.query)
  ]);
  const text = normalizeWhitespace(stripHtml(html)).slice(0, 12000);
  const images = extractImagesFromHtml(html, pageUrl, title, text, options).slice(0, 40);
  if (!images.length) return null;

  return {
    id: `candidate_${hashId(`common-crawl-html:${pageUrl}`)}`,
    title,
    listingSource: safeHostname(pageUrl),
    sourceUrl: pageUrl,
    company: safeHostname(pageUrl).replace(/^www\./, ""),
    layout: extractLayout(`${title} ${text} ${pageUrl}`),
    floors: /平屋|hiraya/i.test(`${title} ${text} ${pageUrl}`) ? "平屋" : "",
    entranceDirection: "",
    hasFloorplanImage: true,
    imageUrlCandidates: images.map((image) => image.url),
    imageCandidates: images,
    fetchedAt: new Date().toISOString(),
    errorInfo: "",
    memo: `Common Crawl archived HTML. Query: ${record.query}. Confirm the current source page before saving.`
  };
}

function extractImagesFromHtml(html, pageUrl, title = "", text = "", options = {}) {
  const images = [];
  const seen = new Set();
  const pageFloorplanContext = looksLikeFloorplanPage(`${title} ${text} ${pageUrl}`);
  const looseCandidateContext = Boolean(options.looseImageCandidates) && looksLikeExplicitFloorplanPage(`${title} ${pageUrl}`);
  const addImage = (rawUrl, alt = "", imageOptions = {}) => {
    if (!rawUrl || /^(undefined|null)$/i.test(String(rawUrl))) return;
    const url = normalizeUrl(rawUrl, pageUrl);
    if (!url || seen.has(url) || url.startsWith("data:")) return;
    if (!isImageUrl(url)) return;
    const signal = imageSignalText(alt, url);
    const contextualFloorplan = pageFloorplanContext && looksLikePlanNamedImage(signal);
    const looseReviewCandidate = looseCandidateContext && looksLikeContentImage(url, imageOptions);
    if (!looksLikeFloorplanImage(signal) && !contextualFloorplan && !looseReviewCandidate) return;
    if (looseReviewCandidate && !contextualFloorplan && !looksLikeFloorplanImage(signal) && looksLikeNonFloorplanPhotoSignal(signal)) return;
    if (looksLikeDecorativeOrNonFloorplan(signal)) return;
    seen.add(url);
    images.push({
      id: `image_candidate_${hashId(`${pageUrl}:${url}`)}`,
      kind: "floorplan",
      url,
      alt: normalizeWhitespace(alt || title || "floorplan candidate"),
      sourceUrl: pageUrl,
      ...(looseReviewCandidate && !contextualFloorplan && !looksLikeFloorplanImage(signal)
        ? { needsOllamaReview: true, reviewReason: "page-context" }
        : {}),
      score: scoreImageCandidate(signal, looseReviewCandidate)
    });
  };

  const ogImage = getMeta(html, "og:image") || getMeta(html, "twitter:image");
  if (ogImage) addImage(ogImage, "OG image");

  for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
    const attrs = parseAttributes(match[0]);
    const alt = attrs.alt || attrs.title || attrs["aria-label"] || attrs.class || attrs.id || "";
    const width = Number(attrs.width || 0);
    const height = Number(attrs.height || 0);
    [
      attrs.src,
      attrs["data-src"],
      attrs["data-original"],
      attrs["data-lazy"],
      attrs["data-lazy-src"],
      attrs["data-original-src"],
      attrs["data-bg"],
      attrs["data-background"],
      firstSrcsetUrl(attrs.srcset),
      firstSrcsetUrl(attrs["data-srcset"])
    ].forEach((rawUrl) => addImage(rawUrl, alt, { width, height }));
  }

  for (const match of html.matchAll(/<source\b[^>]*>/gi)) {
    const attrs = parseAttributes(match[0]);
    addImage(firstSrcsetUrl(attrs.srcset || attrs["data-srcset"]), attrs.alt || attrs.title || "");
  }

  for (const match of html.matchAll(/<a\b[^>]*href\s*=\s*(["']?)([^"'\s>]+)\1[^>]*>(.*?)<\/a>/gis)) {
    const href = decodeHtml(match[2]);
    if (!isImageUrl(href)) continue;
    addImage(href, stripHtml(match[3]));
  }

  for (const match of html.matchAll(/url\((["']?)([^"')]+\.(?:png|jpe?g|webp|gif)(?:\?[^"')]+)?)\1\)/gi)) {
    addImage(match[2], "background image");
  }

  return images
    .sort((a, b) => b.score - a.score)
    .map(({ score, ...image }) => image);
}

function extractHttpBodyFromWarc(warcText) {
  const warcSplit = warcText.indexOf("\r\n\r\n");
  const afterWarc = warcSplit >= 0 ? warcText.slice(warcSplit + 4) : warcText;
  const httpSplit = afterWarc.indexOf("\r\n\r\n");
  if (httpSplit < 0) return "";
  return afterWarc.slice(httpSplit + 4);
}

function recordToCandidate(record, allowedDomains, blockedDomains) {
  const url = normalizeUrl(record.url);
  if (!url) return null;
  const hostname = safeHostname(url).toLowerCase();
  if (!hostname || isBlocked(hostname, blockedDomains)) return null;
  if (allowedDomains.size && !isAllowed(hostname, allowedDomains)) return null;

  const decodedUrl = decodeUrlForSignals(url);
  if (!looksRelevant(decodedUrl, record.mime)) return null;
  const imageUrl = isImageUrl(decodedUrl, record.mime) ? url : "";
  const sourceUrl = imageUrl ? inferSourceUrl(url) : url;
  const title = makeTitle(decodedUrl, record.query);
  const layout = extractLayout(decodedUrl);

  return {
    id: `candidate_${hashId(`common-crawl:${sourceUrl}:${imageUrl || url}`)}`,
    title,
    listingSource: hostname,
    sourceUrl,
    company: hostname.replace(/^www\./, ""),
    layout,
    floors: /平屋|hiraya/i.test(decodedUrl) ? "平屋" : "",
    entranceDirection: "",
    hasFloorplanImage: Boolean(imageUrl),
    imageUrlCandidates: imageUrl ? [imageUrl] : [],
    imageCandidates: imageUrl
      ? [
          {
            id: `image_candidate_${hashId(imageUrl)}`,
            kind: "floorplan",
            url: imageUrl,
            alt: title,
            sourceUrl
          }
        ]
      : [],
    fetchedAt: new Date().toISOString(),
    errorInfo: "",
    memo: `Common Crawl index candidate. Query: ${record.query}. Confirm the source page before saving.`
  };
}

function looksRelevant(decodedUrl, mime = "") {
  if (/logo|icon|banner|profile|avatar|staff|map|sns|facebook|instagram|line|youtube|thumbnail|ogp/i.test(decodedUrl)) {
    return false;
  }
  if (/賃貸|マンション|アパート|中古|土地|リフォーム|リノベ|外観|内観|kitchen|living|bedroom/i.test(decodedUrl)) {
    return false;
  }
  if (/間取り図|間取り|間取|平面図|図面|madori|floor.?plan|floor_plan|layout/i.test(decodedUrl)) return true;
  if (/(?:2|3|4|5)ldk|平屋|hiraya|注文住宅|建売|分譲住宅|施工事例|works|case|house-plan|plan/i.test(decodedUrl)) {
    return /image\//i.test(mime) || isImageUrl(decodedUrl, mime) || /madori|間取り|floor|plan/i.test(decodedUrl);
  }
  return false;
}

function makeTitle(decodedUrl, query) {
  const layout = extractLayout(decodedUrl);
  const host = safeHostname(decodedUrl).replace(/^www\./, "");
  const label = layout ? `${layout} ` : "";
  if (/平屋|hiraya/i.test(decodedUrl)) return `${label}floorplan candidate (single-story)`;
  if (/施工事例|works|case/i.test(decodedUrl)) return `${label}floorplan candidate from case page`;
  if (/間取り|madori|floor.?plan|floor_plan|layout/i.test(decodedUrl)) return `${label}floorplan candidate`;
  return `${label}candidate from ${host || query}`;
}

function inferSourceUrl(imageUrl) {
  try {
    const parsed = new URL(imageUrl);
    parsed.search = "";
    parsed.hash = "";
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length > 1) {
      parsed.pathname = `/${parts.slice(0, -1).join("/")}/`;
    }
    return parsed.toString();
  } catch {
    return imageUrl;
  }
}

function seedUrlToIndexQueries(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const hostnames = parsed.hostname.startsWith("www.")
      ? [parsed.hostname, parsed.hostname.replace(/^www\./, "")]
      : [parsed.hostname, `www.${parsed.hostname}`];
    let pathname = parsed.pathname || "/";
    if (!pathname.endsWith("/")) pathname = `${pathname}/`;
    return hostnames.map((hostname) => `${hostname}${pathname}*`);
  } catch {
    return [];
  }
}

function balancedSeedQueries(seedUrls, maxQueriesPerDomain) {
  const byDomain = new Map();
  for (const seedUrl of seedUrls) {
    const hostname = safeHostname(seedUrl).replace(/^www\./, "").toLowerCase();
    if (!hostname || hostname === "-") continue;
    if (!byDomain.has(hostname)) byDomain.set(hostname, []);
    const queries = byDomain.get(hostname);
    for (const query of seedUrlToIndexQueries(seedUrl)) {
      if (!queries.includes(query)) queries.push(query);
    }
  }

  const limited = [...byDomain.entries()].map(([hostname, queries]) => [
    hostname,
    queries.slice(0, Math.max(1, maxQueriesPerDomain))
  ]);
  const output = [];
  const maxDepth = Math.max(0, ...limited.map(([, queries]) => queries.length));
  for (let depth = 0; depth < maxDepth; depth += 1) {
    for (const [, queries] of limited) {
      if (queries[depth]) output.push(queries[depth]);
    }
  }
  return output;
}

function dedupeRecords(records) {
  const seen = new Set();
  return records.filter((record) => {
    const key = record.digest || `${record.url}:${record.filename}:${record.offset}`;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isHtmlRecord(record) {
  return /text\/html|application\/xhtml\+xml/i.test(record.mime || "") || /\.html?(?:[?#].*)?$/i.test(record.url || "");
}

function recordHasArchiveLocation(record) {
  return Boolean(record.filename && record.offset !== undefined && record.length !== undefined);
}

function isImageUrl(value, mime = "") {
  return /^image\//i.test(mime) || /\.(?:png|jpe?g|webp|gif)(?:[?#].*)?$/i.test(value || "");
}

function extractLayout(value) {
  const match = value.match(/\b([2-5]\s*LDK)\b/i);
  return match ? match[1].replace(/\s+/g, "").toUpperCase() : "";
}

function dedupeCandidates(items) {
  const seen = new Set();
  return items.filter((item) => {
    const imageUrl = item.imageCandidates?.[0]?.url || item.imageUrlCandidates?.[0] || "";
    const key = `${item.sourceUrl || ""}:${imageUrl || ""}`;
    if (!key.trim() || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeLogs(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = item.id || `${item.createdAt}:${item.siteName}:${item.url}:${item.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function fetchWithTimeout(url, headers = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "FloorplanLibraryCommonCrawl/0.1 (+personal candidate discovery)",
        ...headers
      }
    });
  } finally {
    clearTimeout(timeout);
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readOptionalJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return {};
  }
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeUrl(rawUrl, baseUrl) {
  try {
    const parsed = new URL(rawUrl, baseUrl);
    if (!/^https?:$/.test(parsed.protocol)) return "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function isAllowed(hostname, domains) {
  return [...domains].some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

function isBlocked(hostname, domains) {
  return [...domains].some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

function decodeUrlForSignals(url) {
  try {
    return decodeURIComponent(url);
  } catch {
    return url;
  }
}

function firstText(values) {
  return normalizeWhitespace(values.find((value) => normalizeWhitespace(value)) ?? "");
}

function getMeta(html, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i");
  const reversePattern = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["'][^>]*>`, "i");
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

function stripHtml(html) {
  return String(html ?? "")
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

function imageSignalText(alt, url, pageText = "") {
  let decodedUrl = url;
  try {
    const parsed = new URL(url);
    decodedUrl = decodeURIComponent(parsed.pathname);
  } catch {
    decodedUrl = decodeUrlForSignals(url);
  }
  return `${alt} ${decodedUrl} ${pageText}`.slice(0, 18000);
}

function looksLikeFloorplanImage(signal) {
  if (/間取り図|間取り|間取|平面図|図面|madori|floor.?plan|floor_plan|layout/i.test(signal)) return true;
  return /(?:[2-5]\s*LDK|平屋|hiraya|[0-9]{2}\s*坪|坪).{0,36}(?:plan|間取り|図面)|(?:plan|間取り|図面).{0,36}(?:[2-5]\s*LDK|平屋|hiraya|[0-9]{2}\s*坪|坪)/i.test(
    signal
  );
}

function looksLikeFloorplanPage(signal) {
  return /間取り図|間取り|間取|平面図|図面|madori|floor.?plan|floor_plan|layout|[2-5]\s*LDK|平屋|hiraya/i.test(signal);
}

function looksLikeExplicitFloorplanPage(signal) {
  return /間取り図|間取り|間取|平面図|図面|madori|floor.?plan|floor_plan|layout|topview|top-view/i.test(signal);
}

function looksLikePlanNamedImage(signal) {
  return /madori|floor.?plan|floor_plan|layout|zumen|drawing|間取り|平面図|図面|(?:^|[/_-])plan[-_]?[0-9]+/i.test(signal);
}

function looksLikeContentImage(url, options = {}) {
  const width = Number(options.width || 0);
  const height = Number(options.height || 0);
  if (!isImageUrl(url)) return false;
  if (/logo|icon|avatar|staff|profile|banner|button|theme|assets\/images\/top/i.test(url)) return false;
  return /wp-content\/uploads|\/uploads\//i.test(url) || width >= 420 || height >= 260;
}

function looksLikeNonFloorplanPhotoSignal(signal) {
  const explicitPlan = /間取り図|平面図|図面|madori|floor.?plan|floor_plan|layout|topview|top-view/i.test(signal);
  if (explicitPlan) return false;
  return /外観|内観|室内|リビング|キッチン|寝室|浴室|洗面|トイレ|玄関|LDKのイメージ|施工写真|写真|photo|gallery|interior|living|kitchen|bedroom/i.test(signal);
}

function scoreImageCandidate(signal, looseReviewCandidate) {
  let score = looseReviewCandidate ? 45 : 0;
  if (/間取り図|間取り|間取|平面図|図面|madori|floor.?plan|floor_plan|layout/i.test(signal)) score += 120;
  if (/[2-5]\s*LDK|平屋|hiraya|坪|帖|畳/i.test(signal)) score += 35;
  if (/施工事例|建築実例|works|case|注文住宅|建売|分譲住宅/i.test(signal)) score += 12;
  if (/logo|icon|banner|mainvisual|hero|ogp|thumbnail|profile|staff|map|frontview|facade|exterior|外観|内観|キッチン|リビング|寝室/i.test(signal)) {
    score -= 80;
  }
  return score;
}

function looksLikeDecorativeOrNonFloorplan(signal) {
  if (/\.svg(?:\?|$)/i.test(signal)) return true;
  if (/logo|icon|ico[-_]|phone|tel|sns|facebook|instagram|line|youtube|header|footer|banner|bnr|loading|spinner|dummy|placeholder|noimage|ogp|ogimage|mainvisual|hero|avatar|profile|staff|map|point[-_]|txt[-_]|takusan|hajimete|prev[-_]image|next[-_]image/i.test(signal)) {
    return true;
  }
  if (/frontview|front-view|sideview|side-view|facade|exterior|appearance|外観|内観|キッチン|リビング|寝室|施工写真/i.test(signal)) {
    return !/間取り図|平面図|図面|madori|floor.?plan|floor_plan|layout/i.test(signal);
  }
  return false;
}

function addLog(siteName, url, action, result, message) {
  logs.push({
    id: `log_${crypto.randomUUID()}`,
    createdAt: new Date().toISOString(),
    siteName,
    domain: safeHostname(url),
    url,
    action,
    result,
    message
  });
  console.log(`[${siteName}] ${action} ${result}: ${message}`);
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

function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return !/^(false|0|no|off)$/i.test(String(value));
}
