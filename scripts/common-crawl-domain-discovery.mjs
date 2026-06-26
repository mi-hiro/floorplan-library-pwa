#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const DEFAULT_QUERIES = [
  "*.jp/*madori*",
  "*.jp/*間取り*",
  "*.jp/*floorplan*",
  "*.jp/*floor-plan*",
  "*.jp/*floor_plan*",
  "*.jp/*madori*.jpg",
  "*.jp/*madori*.png",
  "*.jp/*madori*.webp",
  "*.jp/*floorplan*.jpg",
  "*.jp/*floorplan*.png",
  "*.jp/*floor_plan*.jpg",
  "*.jp/*floor_plan*.png",
  "*.jp/*layout*.jpg",
  "*.jp/*layout*.png",
  "*.jp/*works*madori*",
  "*.jp/*case*madori*",
  "*.jp/*施工事例*間取り*"
];

const DEFAULT_INDEX_IDS = ["CC-MAIN-2026-25", "CC-MAIN-2026-21", "CC-MAIN-2026-18"];
const args = parseArgs(process.argv.slice(2));
const logs = [];

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

async function main() {
  const configPath = args.config ?? "common-crawl.config.json";
  const discoveryPath = args.discoveryFile ?? path.join("crawler-output", "discovered-sources.json");
  const outPath = args.out ?? path.join("crawler-output", "common-crawl-domains.json");
  const config = await readOptionalJson(configPath);
  const existingDiscovery = await readOptionalJson(discoveryPath);
  const indexIds = (config.indexIds?.length ? config.indexIds : DEFAULT_INDEX_IDS).slice(0, Number(args.maxIndexes ?? config.maxIndexes ?? 1));
  const queries = (config.queries?.length ? config.queries : DEFAULT_QUERIES).slice(0, Number(args.maxQueries ?? 24));
  const perQuery = Number(args.perQuery ?? 80);
  const timeoutMs = Number(args.timeoutSeconds ?? 20) * 1000;
  const targetDomains = Number(args.targetDomains ?? 200);
  const blockedDomains = new Set((config.blockedDomains ?? []).map((domain) => String(domain).toLowerCase()));
  const domainMap = new Map();

  for (const indexId of indexIds) {
    for (const query of queries) {
      const records = await fetchIndexRecords(indexId, query, perQuery, timeoutMs);
      for (const record of records) {
        addRecord(domainMap, record, query, blockedDomains);
      }
    }
  }

  const domains = [...domainMap.values()]
    .sort((a, b) => b.score - a.score || b.records - a.records || a.domain.localeCompare(b.domain))
    .slice(0, targetDomains);

  const discoveredFromDomains = domains.flatMap((domain) =>
    domain.sampleUrls.slice(0, 4).map((url) => ({
      url,
      title: `Common Crawl domain candidate: ${domain.domain}`,
      domain: safeHostname(url),
      source: "common-crawl-domain-discovery",
      score: domain.score
    }))
  );

  const mergedDiscovery = {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: "source-discovery",
    discoveredUrls: dedupeDiscovered([...(existingDiscovery.discoveredUrls ?? []), ...discoveredFromDomains]),
    logs: dedupeLogs([...(existingDiscovery.logs ?? []), ...logs])
  };

  const result = {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: "common-crawl-domain-discovery",
    domains,
    logs
  };

  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await mkdir(path.dirname(discoveryPath), { recursive: true });
  await writeFile(discoveryPath, `${JSON.stringify(mergedDiscovery, null, 2)}\n`, "utf8");
  console.log(`Common Crawl domain discovery finished: ${domains.length} domains`);
  console.log(`Output: ${outPath}`);
  console.log(`Updated discovery: ${discoveryPath}`);
}

async function fetchIndexRecords(indexId, query, perQuery, timeoutMs) {
  const url = new URL(`https://index.commoncrawl.org/${indexId}-index`);
  url.searchParams.set("url", query);
  url.searchParams.set("output", "json");
  url.searchParams.set("fl", "url,mime,status,timestamp");
  url.searchParams.set("filter", "status:200");
  url.searchParams.set("collapse", "urlkey");
  url.searchParams.set("limit", String(Math.max(1, perQuery)));

  try {
    const response = await fetchWithTimeout(url, timeoutMs);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const records = (await response.text())
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => safeJsonParse(line))
      .filter(Boolean);
    addLog("Common Crawl", url.toString(), "domain-query", "success", `${query}: ${records.length} records`);
    return records.map((record) => ({ ...record, indexId }));
  } catch (error) {
    addLog("Common Crawl", url.toString(), "domain-query", "skipped", `${query}: ${error.message}`);
    return [];
  }
}

function addRecord(domainMap, record, query, blockedDomains) {
  const url = normalizeUrl(record.url);
  if (!url) return;
  const hostname = safeHostname(url).replace(/^www\./, "").toLowerCase();
  if (!hostname || isBlocked(hostname, blockedDomains)) return;
  if (!isRelevantUrl(url, record.mime)) return;

  const current =
    domainMap.get(hostname) ?? {
      domain: hostname,
      records: 0,
      imageRecords: 0,
      htmlRecords: 0,
      score: 0,
      queries: [],
      sampleUrls: []
    };

  current.records += 1;
  if (/^image\//i.test(record.mime || "") || isImageUrl(url)) current.imageRecords += 1;
  else current.htmlRecords += 1;
  current.score += scoreUrl(url, record.mime);
  if (!current.queries.includes(query)) current.queries.push(query);
  if (!current.sampleUrls.includes(url) && current.sampleUrls.length < 12) current.sampleUrls.push(url);
  domainMap.set(hostname, current);
}

function isRelevantUrl(url, mime = "") {
  const signal = decodeUrlForSignals(url);
  if (/logo|icon|banner|profile|avatar|staff|map|sns|facebook|instagram|line|youtube|thumbnail|ogp/i.test(signal)) {
    return false;
  }
  if (/間取り図|間取り|間取|平面図|図面|madori|floor.?plan|floor_plan|layout/i.test(signal)) return true;
  if (/賃貸|マンション|アパート|中古|土地|リフォーム|リノベ|外観|内観/i.test(signal)) {
    return false;
  }
  return /(?:2|3|4|5)ldk|平屋|hiraya|注文住宅|建売|分譲住宅|施工事例|works|case|house-plan|plan/i.test(signal) && (/image\//i.test(mime) || isImageUrl(signal));
}

function scoreUrl(url, mime = "") {
  const signal = decodeUrlForSignals(url);
  let score = 0;
  if (/間取り図|間取り|間取|madori/i.test(signal)) score += 120;
  if (/floor.?plan|floor_plan|layout|平面図|図面/i.test(signal)) score += 95;
  if (/\/works\/|\/case\/|施工事例|建築実例/i.test(signal)) score += 25;
  if (/^image\//i.test(mime) || isImageUrl(signal)) score += 20;
  if (/column|blog|news|article|まとめ|ranking/i.test(signal)) score -= 60;
  return score;
}

function isImageUrl(value) {
  return /\.(?:png|jpe?g|webp|gif)(?:[?#].*)?$/i.test(value || "");
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

function dedupeLogs(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = item.id || `${item.createdAt}:${item.siteName}:${item.url}:${item.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "FloorplanLibraryDiscovery/0.1 (+personal Common Crawl domain discovery)"
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

function decodeUrlForSignals(value) {
  try {
    return decodeURIComponent(String(value));
  } catch {
    return String(value || "");
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
