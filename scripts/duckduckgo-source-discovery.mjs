#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const args = parseArgs(process.argv.slice(2));
const logs = [];

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

async function main() {
  const configPath = args.config ?? "source-discovery.config.json";
  const commonCrawlConfigPath = args.commonCrawlConfig ?? "common-crawl.config.json";
  const outPath = args.out ?? path.join("crawler-output", "discovered-sources.json");
  const config = await readOptionalJson(configPath);
  const duckduckgo = config.duckduckgo ?? {};

  if (duckduckgo.enabled === false) {
    console.log("DuckDuckGo discovery is disabled in config.");
    return;
  }

  const blockedDomains = new Set((config.blockedDomains ?? []).map((domain) => String(domain).toLowerCase()));
  const maxResultsPerQuery = Number(args.maxResultsPerQuery ?? duckduckgo.maxResultsPerQuery ?? 20);
  const timeoutMs = Number(args.timeoutSeconds ?? duckduckgo.timeoutSeconds ?? 15) * 1000;
  const queries = duckduckgo.queries?.length ? duckduckgo.queries : ["注文住宅 間取り 実例 プラン集"];
  const discovered = [];

  for (const query of queries) {
    const payload = await fetchDuckDuckGo(query, timeoutMs);
    const urls = extractDuckDuckGoUrls(payload)
      .filter((item) => isRelevantDiscovery(item, blockedDomains))
      .slice(0, maxResultsPerQuery)
      .map((item) => ({ ...item, query, source: "duckduckgo-instant-answer" }));
    discovered.push(...urls);
  }

  const existing = await readOptionalJson(outPath);
  const result = {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: "source-discovery",
    discoveredUrls: dedupeDiscovered([...(existing.discoveredUrls ?? []), ...discovered]),
    logs: dedupeLogs([...(existing.logs ?? []), ...logs])
  };

  if (parseBool(args.updateCommonCrawl, false)) {
    const commonCrawlConfig = await readOptionalJson(commonCrawlConfigPath);
    const maxSeedUrlsToAdd = Number(args.maxSeedUrlsToAdd ?? config.maxSeedUrlsToAdd ?? 80);
    const maxSeedUrlsPerDomain = Number(args.maxSeedUrlsPerDomain ?? config.maxSeedUrlsPerDomain ?? 6);
    const seedUrls = capUrlsPerDomain(dedupeUrls([...(commonCrawlConfig.seedUrls ?? []), ...result.discoveredUrls.map((item) => item.url)])
      .filter((url) => isRelevantSeedUrl(url, blockedDomains))
      .slice(0, Math.max(maxSeedUrlsToAdd, (commonCrawlConfig.seedUrls ?? []).length)), maxSeedUrlsPerDomain);
    await writeFile(commonCrawlConfigPath, `${JSON.stringify({ ...commonCrawlConfig, seedUrls }, null, 2)}\n`, "utf8");
    addLog("DuckDuckGo", commonCrawlConfigPath, "update-common-crawl", "success", `seedUrls=${seedUrls.length}`);
  }

  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(`DuckDuckGo discovery finished: ${result.discoveredUrls.length} discovered URLs`);
  console.log(`Output: ${outPath}`);
}

async function fetchDuckDuckGo(query, timeoutMs) {
  const url = new URL("https://api.duckduckgo.com/");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("no_html", "1");
  url.searchParams.set("skip_disambig", "1");

  try {
    const response = await fetchWithTimeout(url, timeoutMs);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    addLog("DuckDuckGo", url.toString(), "instant-answer", "success", query);
    return response.json();
  } catch (error) {
    addLog("DuckDuckGo", url.toString(), "instant-answer", "skipped", `${query}: ${error.message}`);
    return {};
  }
}

function extractDuckDuckGoUrls(payload) {
  const items = [];
  const add = (url, title = "") => {
    const normalized = normalizeUrl(url);
    if (!normalized) return;
    items.push({ url: normalized, title: normalizeWhitespace(title), domain: safeHostname(normalized) });
  };

  add(payload.AbstractURL, payload.Heading || payload.AbstractText || "");
  for (const item of payload.Results ?? []) add(item.FirstURL, item.Text);
  walkRelatedTopics(payload.RelatedTopics ?? [], add);
  return dedupeDiscovered(items);
}

function walkRelatedTopics(items, add) {
  for (const item of items) {
    if (item.Topics) {
      walkRelatedTopics(item.Topics, add);
    } else {
      add(item.FirstURL, item.Text);
    }
  }
}

function isRelevantDiscovery(item, blockedDomains) {
  const url = item.url || "";
  const host = safeHostname(url).toLowerCase();
  if (!host || isBlocked(host, blockedDomains)) return false;
  return isRelevantSeedUrl(`${url} ${item.title || ""}`, blockedDomains);
}

function isRelevantSeedUrl(value, blockedDomains) {
  const host = safeHostname(value).toLowerCase();
  if (host && isBlocked(host, blockedDomains)) return false;
  if (/賃貸|マンション|アパート|中古|土地|リフォーム|リノベ|不動産投資/i.test(value)) return false;
  return /間取り|間取|平面図|図面|madori|floor.?plan|floor_plan|layout|注文住宅|新築|工務店|住宅会社|ハウスメーカー|平屋|3LDK|4LDK|施工事例|建築実例|works|case|plan/i.test(
    value
  );
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

function capUrlsPerDomain(urls, maxPerDomain) {
  const counts = new Map();
  return urls
    .sort((a, b) => scoreUrl(b) - scoreUrl(a))
    .filter((url) => {
      const hostname = safeHostname(url).replace(/^www\./, "").toLowerCase();
      const count = counts.get(hostname) ?? 0;
      if (count >= maxPerDomain) return false;
      counts.set(hostname, count + 1);
      return true;
    });
}

function scoreUrl(url) {
  let score = 0;
  if (/\/plan\/plan[0-9]+\/?$/i.test(url)) score += 120;
  if (/madori|間取り|floor.?plan|floor_plan|layout|平面図|図面/i.test(url)) score += 90;
  if (/施工事例|建築実例|works|case/i.test(url)) score += 45;
  if (/column|blog|news|financial|english|diversity|company/i.test(url)) score -= 80;
  return score;
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

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "FloorplanLibraryDiscovery/0.1 (+personal source discovery)"
      }
    });
  } finally {
    clearTimeout(timeout);
  }
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

function isBlocked(hostname, domains) {
  return [...domains].some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
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

function normalizeWhitespace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
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
