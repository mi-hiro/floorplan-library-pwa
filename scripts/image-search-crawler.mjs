#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const DEFAULT_QUERIES = [
  "新築 間取り図 3LDK",
  "新築 間取り図 4LDK",
  "注文住宅 間取り図 3LDK",
  "平屋 間取り図 3LDK",
  "建売住宅 間取り図 3LDK",
  "施工事例 間取り図 3LDK"
];

const args = parseArgs(process.argv.slice(2));
const logs = [];

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

async function main() {
  const configPath = args.config ?? "image-search.config.json";
  const outPath = args.out ?? path.join("crawler-output", "latest-crawl.json");
  const config = await readOptionalJson(configPath);
  const provider = resolveProvider(args.provider ?? config.provider ?? process.env.IMAGE_SEARCH_PROVIDER ?? "auto");
  const queries = config.queries?.length ? config.queries : DEFAULT_QUERIES;
  const perQuery = Number(args.perQuery ?? config.perQuery ?? 20);
  const mergeExisting = parseBool(args.mergeExisting ?? config.mergeExisting, false);

  let candidates = [];
  if (provider === "google") {
    candidates = await collectFromGoogle(queries, perQuery, config.google ?? {});
  } else if (provider === "bing") {
    candidates = await collectFromBing(queries, perQuery, config.bing ?? {});
  } else {
    throw new Error(`未対応の画像検索プロバイダーです: ${provider}`);
  }

  const result = {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: "local-crawler",
    candidates: dedupeCandidates(candidates),
    logs
  };

  if (mergeExisting) {
    const existing = await readOptionalJson(outPath);
    result.candidates = dedupeCandidates([...(existing.candidates ?? []), ...result.candidates]);
    result.logs = dedupeLogs([...(existing.logs ?? []), ...result.logs]);
  }

  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(result, null, 2), "utf8");
  console.log(`画像検索完了: 間取り候補 ${result.candidates.length}件`);
  console.log(`出力: ${outPath}`);
}

async function collectFromGoogle(queries, perQuery, settings) {
  const apiKey = process.env[settings.apiKeyEnv ?? "GOOGLE_CUSTOM_SEARCH_API_KEY"];
  const cx = process.env[settings.cxEnv ?? "GOOGLE_CUSTOM_SEARCH_CX"];
  if (!apiKey || !cx) {
    throw new Error("Google画像検索には GOOGLE_CUSTOM_SEARCH_API_KEY と GOOGLE_CUSTOM_SEARCH_CX が必要です。");
  }

  const results = [];
  for (const query of queries) {
    let start = 1;
    while (resultsForQuery(results, query) < perQuery && start <= 91) {
      const url = new URL("https://customsearch.googleapis.com/customsearch/v1");
      url.searchParams.set("key", apiKey);
      url.searchParams.set("cx", cx);
      url.searchParams.set("q", query);
      url.searchParams.set("searchType", "image");
      url.searchParams.set("num", String(Math.min(10, perQuery - resultsForQuery(results, query))));
      url.searchParams.set("start", String(start));
      url.searchParams.set("safe", settings.safe ?? "active");
      url.searchParams.set("gl", settings.gl ?? "jp");
      url.searchParams.set("lr", settings.lr ?? "lang_ja");
      url.searchParams.set("imgSize", settings.imgSize ?? "large");
      if (settings.rights) url.searchParams.set("rights", settings.rights);
      if (settings.imgType) url.searchParams.set("imgType", settings.imgType);

      const payload = await fetchJson(url, "Google画像検索", query);
      for (const item of payload.items ?? []) {
        const candidate = googleItemToCandidate(item, query);
        if (candidate) results.push(candidate);
      }
      start += 10;
    }
  }
  return results;
}

async function collectFromBing(queries, perQuery, settings) {
  const apiKey = process.env[settings.apiKeyEnv ?? "BING_IMAGE_SEARCH_KEY"];
  if (!apiKey) throw new Error("Bing画像検索には BING_IMAGE_SEARCH_KEY が必要です。");

  const results = [];
  for (const query of queries) {
    let offset = 0;
    while (resultsForQuery(results, query) < perQuery && offset < 150) {
      const url = new URL(settings.endpoint ?? "https://api.bing.microsoft.com/v7.0/images/search");
      url.searchParams.set("q", query);
      url.searchParams.set("count", String(Math.min(35, perQuery - resultsForQuery(results, query))));
      url.searchParams.set("offset", String(offset));
      url.searchParams.set("mkt", settings.market ?? "ja-JP");
      url.searchParams.set("safeSearch", settings.safeSearch ?? "Moderate");

      const payload = await fetchJson(url, "Bing画像検索", query, { "Ocp-Apim-Subscription-Key": apiKey });
      for (const item of payload.value ?? []) {
        const candidate = bingItemToCandidate(item, query);
        if (candidate) results.push(candidate);
      }
      offset += 35;
    }
  }
  return results;
}

async function fetchJson(url, siteName, query, headers = {}) {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    addLog(siteName, url.toString(), "画像検索", "停止中", `HTTP ${response.status}: ${query}`);
    throw new Error(`${siteName}でHTTP ${response.status}`);
  }
  addLog(siteName, url.toString().replace(/key=[^&]+/, "key=***"), "画像検索", "成功", query);
  return response.json();
}

function googleItemToCandidate(item, query) {
  const imageUrl = item.link;
  const sourceUrl = item.image?.contextLink || item.displayLink || imageUrl;
  if (!imageUrl || !sourceUrl || !looksLikeFloorplan(item.title, imageUrl, query)) return null;
  return makeCandidate({
    provider: "Google画像検索",
    query,
    title: item.title,
    imageUrl,
    thumbnailUrl: item.image?.thumbnailLink,
    sourceUrl,
    sourceName: item.displayLink || safeHostname(sourceUrl),
    width: item.image?.width,
    height: item.image?.height
  });
}

function bingItemToCandidate(item, query) {
  const imageUrl = item.contentUrl;
  const sourceUrl = item.hostPageUrl || imageUrl;
  if (!imageUrl || !sourceUrl || !looksLikeFloorplan(item.name, imageUrl, query)) return null;
  return makeCandidate({
    provider: "Bing画像検索",
    query,
    title: item.name,
    imageUrl,
    thumbnailUrl: item.thumbnailUrl,
    sourceUrl,
    sourceName: item.hostPageDisplayUrl || safeHostname(sourceUrl),
    width: item.width,
    height: item.height
  });
}

function makeCandidate({ provider, query, title, imageUrl, thumbnailUrl, sourceUrl, sourceName, width, height }) {
  const id = `candidate_${hashId(`${provider}:${sourceUrl}:${imageUrl}`)}`;
  const imageId = `image_candidate_${hashId(imageUrl)}`;
  const layout = extractLayout(`${query} ${title}`);
  return {
    id,
    title: title || query,
    listingSource: sourceName || provider,
    sourceUrl,
    company: sourceName || "",
    layout,
    floors: /平屋/.test(`${query} ${title}`) ? "平屋" : "",
    entranceDirection: "",
    hasFloorplanImage: true,
    imageUrlCandidates: [imageUrl, thumbnailUrl].filter(Boolean),
    imageCandidates: [
      {
        id: imageId,
        kind: "floorplan",
        url: imageUrl,
        thumbnailUrl,
        alt: title || query,
        sourceUrl
      }
    ],
    fetchedAt: new Date().toISOString(),
    errorInfo: "",
    memo: `${provider} APIで収集。検索語: ${query}${width && height ? ` / ${width}x${height}` : ""}`
  };
}

function looksLikeFloorplan(title, imageUrl, query) {
  const text = `${query} ${title} ${decodeUrlForSignals(imageUrl)}`;
  if (/logo|icon|banner|profile|avatar|photo|interior|exterior|外観|内観/i.test(text)) return false;
  if (looksLikeArticleThumbnail(text)) return false;
  if (/frontview|front-view|sideview|side-view|facade|appearance|立面/i.test(text)) return false;
  if (/間取り図|平面図|図面|madori|floor.?plan|floor_plan|layout/i.test(text)) return true;
  return /(?:[2-5]\s*LDK|平屋|[0-9]{2}\s*坪|坪).{0,24}間取り|間取り.{0,24}(?:[2-5]\s*LDK|平屋|[0-9]{2}\s*坪|坪)/i.test(text);
}

function decodeUrlForSignals(url) {
  try {
    return decodeURIComponent(url);
  } catch {
    return url;
  }
}

function looksLikeArticleThumbnail(text) {
  const articleUrl = /top_column|column|blog|article|news|pickup|cover|thumbnail|ogp/i.test(text);
  const articleTitle = /選|メリット|デメリット|解説|とは|コツ|相場|種類|目安|アイデア|おすすめ|ランキング|カタログ|施工事例/i.test(
    text
  );
  const explicitPlan = /間取り図|平面図|図面|madori|floor.?plan|floor_plan|layout/i.test(text);
  return articleUrl && articleTitle && !explicitPlan;
}

function dedupeCandidates(items) {
  const seen = new Set();
  return items.filter((item) => {
    const imageUrl = item.imageCandidates?.[0]?.url || item.imageUrlCandidates?.[0] || item.sourceUrl;
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

function resultsForQuery(results, query) {
  return results.filter((item) => item.memo.includes(query)).length;
}

async function readOptionalJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return {};
  }
}

function extractLayout(value) {
  const match = value.match(/\b([2-5]\s*LDK)\b/i);
  return match ? match[1].replace(/\s+/g, "").toUpperCase() : "";
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

function resolveProvider(value) {
  const provider = String(value || "auto").toLowerCase();
  if (provider !== "auto") return provider;
  const hasGoogle = Boolean(process.env.GOOGLE_CUSTOM_SEARCH_API_KEY && process.env.GOOGLE_CUSTOM_SEARCH_CX);
  if (hasGoogle) return "google";
  if (process.env.BING_IMAGE_SEARCH_KEY) return "bing";
  return "google";
}

function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return !/^(false|0|no|off)$/i.test(String(value));
}
