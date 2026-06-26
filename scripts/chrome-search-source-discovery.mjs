#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const DEFAULT_BLOCKED_DOMAINS = [
  "google.com",
  "google.co.jp",
  "bing.com",
  "yahoo.co.jp",
  "duckduckgo.com",
  "pinterest.com",
  "instagram.com",
  "facebook.com",
  "x.com",
  "twitter.com",
  "youtube.com",
  "amazon.co.jp",
  "rakuten.co.jp",
  "suumo.jp",
  "homes.co.jp",
  "athome.co.jp",
  "myhome.nifty.com",
  "town-life.jp",
  "ii-ie2.net",
  "hugkumi-life.jp"
];

const args = parseArgs(process.argv.slice(2));
const logs = [];

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

async function main() {
  const configPath = args.config ?? "chrome-discovery.config.json";
  const inputPath = args.input ?? path.join(".tmp", "chrome-search-links.txt");
  const discoveryPath = args.discoveryFile ?? path.join("crawler-output", "discovered-sources.json");
  const outPath = args.out ?? path.join("crawler-output", "chrome-discovered-sources.json");
  const commonCrawlConfigPath = args.commonCrawlConfig ?? "common-crawl.config.json";
  const config = await readOptionalJson(configPath);
  const blockedDomains = new Set([...(config.blockedDomains ?? DEFAULT_BLOCKED_DOMAINS)].map((domain) => String(domain).toLowerCase()));
  const minScore = Number(args.minScore ?? config.minScore ?? 35);
  const maxUrls = Number(args.maxUrls ?? config.maxUrls ?? 300);
  const maxUrlsPerDomain = Number(args.maxUrlsPerDomain ?? config.maxUrlsPerDomain ?? 8);
  const rawInput = await readTextInput(inputPath, args.urls);

  const discovered = capUrlsPerDomain(
    extractSearchItems(rawInput)
      .map((item) => normalizeSearchItem(item))
      .filter((item) => item.url)
      .filter((item) => isUsefulDiscovery(item, blockedDomains))
      .map((item) => ({ ...item, score: scoreDiscovery(item) }))
      .filter((item) => item.score >= minScore)
      .sort((a, b) => b.score - a.score || a.url.localeCompare(b.url)),
    maxUrlsPerDomain
  ).slice(0, maxUrls);

  const existing = await readOptionalJson(discoveryPath);
  const mergedDiscovery = {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: "source-discovery",
    discoveredUrls: dedupeDiscovered([...(existing.discoveredUrls ?? []), ...discovered]),
    logs: dedupeLogs([...(existing.logs ?? []), ...logs])
  };

  const result = {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: "chrome-search-discovery",
    discoveredUrls: discovered,
    logs
  };

  if (parseBool(args.updateCommonCrawl ?? config.updateCommonCrawl, true)) {
    await updateCommonCrawlSeeds(commonCrawlConfigPath, mergedDiscovery.discoveredUrls, blockedDomains, config);
  }

  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await mkdir(path.dirname(discoveryPath), { recursive: true });
  await writeFile(discoveryPath, `${JSON.stringify(mergedDiscovery, null, 2)}\n`, "utf8");

  addLog("Chrome Discovery", inputPath, "source-import", "success", `${discovered.length} source URLs`);
  console.log(`Chrome search discovery finished: ${discovered.length} URLs`);
  console.log(`Output: ${outPath}`);
  console.log(`Updated discovery: ${discoveryPath}`);
}

async function readTextInput(inputPath, inlineUrls) {
  if (inlineUrls) return String(inlineUrls);
  try {
    return await readFile(inputPath, "utf8");
  } catch {
    addLog("Chrome Discovery", inputPath, "source-import", "skipped", "Input file was not found");
    return "";
  }
}

function extractSearchItems(rawInput) {
  const text = String(rawInput || "");
  const items = [];

  const parsedJson = safeJsonParse(text);
  if (Array.isArray(parsedJson)) {
    for (const item of parsedJson) {
      if (typeof item === "string") items.push({ url: item, title: "" });
      else items.push({ url: item.url || item.href || item.link || "", title: item.title || item.text || item.label || "" });
    }
  } else if (parsedJson && typeof parsedJson === "object") {
    for (const item of parsedJson.items ?? parsedJson.links ?? parsedJson.results ?? []) {
      items.push({ url: item.url || item.href || item.link || "", title: item.title || item.text || item.label || "" });
    }
  }

  for (const match of text.matchAll(/<a\b[^>]*href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi)) {
    items.push({ url: decodeHtml(match[2]), title: normalizeWhitespace(stripHtml(match[3])) });
  }

  for (const match of text.matchAll(/https?:\/\/[^\s"'<>\\)]+/gi)) {
    items.push({ url: match[0], title: "" });
  }

  return dedupeDiscovered(items);
}

function normalizeSearchItem(item) {
  const rawUrl = unwrapSearchUrl(item.url);
  const url = normalizeUrl(rawUrl);
  return {
    url,
    title: normalizeWhitespace(item.title || ""),
    domain: safeHostname(url),
    source: "chrome-search-discovery"
  };
}

function unwrapSearchUrl(rawUrl) {
  let current = decodeHtml(String(rawUrl || ""));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const normalized = normalizeUrl(current);
    if (!normalized) return current;
    const parsed = new URL(normalized);
    const hostname = parsed.hostname.replace(/^www\./, "").toLowerCase();
    const direct =
      parsed.searchParams.get("imgrefurl") ||
      parsed.searchParams.get("url") ||
      parsed.searchParams.get("q") ||
      parsed.searchParams.get("u") ||
      parsed.searchParams.get("uddg") ||
      parsed.searchParams.get("ru");
    if (direct && /^https?:\/\//i.test(direct)) {
      current = direct;
      continue;
    }
    if (hostname.endsWith("bing.com")) {
      const encoded = parsed.searchParams.get("r") || parsed.searchParams.get("u");
      const decoded = decodeBingUrl(encoded);
      if (decoded) {
        current = decoded;
        continue;
      }
    }
    return normalized;
  }
  return current;
}

function decodeBingUrl(value) {
  if (!value) return "";
  const cleaned = String(value).replace(/^a1/i, "");
  try {
    const padded = cleaned + "=".repeat((4 - (cleaned.length % 4)) % 4);
    const decoded = Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return /^https?:\/\//i.test(decoded) ? decoded : "";
  } catch {
    return "";
  }
}

function isUsefulDiscovery(item, blockedDomains) {
  const url = item.url || "";
  const hostname = safeHostname(url).replace(/^www\./, "").toLowerCase();
  if (!hostname || isBlocked(hostname, blockedDomains)) return false;
  if (/\.(pdf|zip|docx?|xlsx?|pptx?)(?:[?#].*)?$/i.test(url)) return false;
  if (/\/(?:tag|category|author|contact|privacy|recruit|login|company|news)(?:\/|$)/i.test(url) && !/間取り|madori|floor.?plan|plan/i.test(url)) return false;
  const signal = decodeUrlForSignals(`${item.title || ""} ${url}`);
  if (/賃貸|マンション|アパート|中古|土地|リフォーム|リノベ|外観|内観|不動産投資/i.test(signal)) return false;
  return /間取り|間取|平面図|図面|madori|floor.?plan|floor_plan|layout|注文住宅|新築|工務店|住宅会社|ハウスメーカー|平屋|3LDK|4LDK|施工事例|建築実例|works|case|plan/i.test(signal);
}

function scoreDiscovery(item) {
  const signal = decodeUrlForSignals(`${item.title || ""} ${item.url || ""}`);
  let score = 0;
  if (/間取り図|間取り|間取|madori/i.test(signal)) score += 110;
  if (/平面図|図面|floor.?plan|floor_plan|layout/i.test(signal)) score += 90;
  if (/3LDK|4LDK|5LDK|平屋|二階建|2階建/i.test(signal)) score += 35;
  if (/注文住宅|新築|工務店|住宅会社|ハウスメーカー/i.test(signal)) score += 30;
  if (/施工事例|建築実例|works|case|plan/i.test(signal)) score += 20;
  if (/column|blog|news|article|まとめ|ランキング|おすすめ|とは|コツ/i.test(signal)) score -= 35;
  if (/contact|privacy|recruit|login|company|ir|csr/i.test(signal)) score -= 80;
  return score;
}

function capUrlsPerDomain(items, maxPerDomain) {
  const counts = new Map();
  return items.filter((item) => {
    const hostname = safeHostname(item.url).replace(/^www\./, "").toLowerCase();
    const count = counts.get(hostname) ?? 0;
    if (count >= maxPerDomain) return false;
    counts.set(hostname, count + 1);
    return true;
  });
}

async function updateCommonCrawlSeeds(configPath, discoveredUrls, blockedDomains, config) {
  const commonCrawlConfig = await readOptionalJson(configPath);
  const maxSeedUrlsToAdd = Number(args.maxSeedUrlsToAdd ?? config.maxSeedUrlsToAdd ?? 120);
  const maxSeedUrlsPerDomain = Number(args.maxSeedUrlsPerDomain ?? config.maxSeedUrlsPerDomain ?? 8);
  const existingSeedUrls = dedupeUrls(commonCrawlConfig.seedUrls ?? []);
  const existingKeys = new Set(existingSeedUrls.map((url) => normalizeUrl(url)));
  const newSeedUrls = capUrlsPerDomain(
    dedupeUrls(discoveredUrls.map((item) => item.url))
      .filter((url) => !existingKeys.has(normalizeUrl(url)))
      .filter((url) => isUsefulDiscovery({ url, title: "" }, blockedDomains))
      .sort((a, b) => scoreDiscovery({ url: b }) - scoreDiscovery({ url: a })),
    maxSeedUrlsPerDomain
  ).slice(0, maxSeedUrlsToAdd);
  const seedUrls = dedupeUrls([...existingSeedUrls, ...newSeedUrls]);
  await writeFile(configPath, `${JSON.stringify({ ...commonCrawlConfig, seedUrls }, null, 2)}\n`, "utf8");
  addLog("Chrome Discovery", configPath, "update-common-crawl", "success", `seedUrls=${seedUrls.length}, added=${newSeedUrls.length}`);
}

function dedupeDiscovered(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = normalizeUrl(item.url);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    item.url = key;
    item.domain = item.domain || safeHostname(key);
    return true;
  });
}

function dedupeUrls(urls) {
  const seen = new Set();
  return urls.filter((url) => {
    const key = normalizeUrl(url);
    if (!key || seen.has(key)) return false;
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

async function readOptionalJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return {};
  }
}

function normalizeUrl(rawUrl) {
  if (!rawUrl) return "";
  try {
    const parsed = new URL(rawUrl);
    if (!/^https?:$/.test(parsed.protocol)) return "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function safeHostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function isBlocked(hostname, domains) {
  return [...domains].some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

function stripHtml(html) {
  return String(html ?? "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
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

function decodeUrlForSignals(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
}

function normalizeWhitespace(value) {
  return decodeHtml(value).replace(/\s+/g, " ").trim();
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
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

function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return !/^(false|0|no|off)$/i.test(String(value));
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
