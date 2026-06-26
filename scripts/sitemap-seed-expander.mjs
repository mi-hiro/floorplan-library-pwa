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
  const commonCrawlConfigPath = args.commonCrawlConfig ?? "common-crawl.config.json";
  const crawlerConfigPath = args.crawlerConfig ?? "crawler.config.json";
  const discoveryFilePath = args.discoveryFile ?? path.join("crawler-output", "discovered-sources.json");
  const outPath = args.out ?? discoveryFilePath;
  const writeConfig = parseBool(args.writeConfig, false);
  const maxDomains = Number(args.maxDomains ?? 24);
  const maxSitemapsPerDomain = Number(args.maxSitemapsPerDomain ?? 6);
  const maxUrlsPerDomain = Number(args.maxUrlsPerDomain ?? 40);
  const maxSeedUrlsPerDomain = Number(args.maxSeedUrlsPerDomain ?? 6);
  const timeoutMs = Number(args.timeoutSeconds ?? 20) * 1000;

  const commonCrawlConfig = await readOptionalJson(commonCrawlConfigPath);
  const crawlerConfig = await readOptionalJson(crawlerConfigPath);
  const discoveryFile = await readOptionalJson(discoveryFilePath);
  const blockedDomains = new Set((commonCrawlConfig.blockedDomains ?? []).map((domain) => String(domain).toLowerCase()));
  const domains = collectDomains(commonCrawlConfig, crawlerConfig, discoveryFile, blockedDomains).slice(0, maxDomains);
  const sitemapUrls = [];
  const discoveredUrls = [];

  for (const domain of domains) {
    const robots = await fetchRobots(domain, timeoutMs);
    const domainSitemaps = dedupeUrls([
      ...robots.sitemaps,
      `https://${domain}/sitemap.xml`,
      domain.startsWith("www.") ? `https://${domain.replace(/^www\./, "")}/sitemap.xml` : `https://www.${domain}/sitemap.xml`
    ]).slice(0, maxSitemapsPerDomain);

    for (const sitemapUrl of domainSitemaps) {
      if (!isAllowedByRobots(robots.rules, sitemapUrl)) {
        addLog(domain, sitemapUrl, "sitemap", "robots-blocked", "Skipped by robots.txt");
        continue;
      }
      const urls = await fetchSitemapUrls(domain, sitemapUrl, timeoutMs);
      sitemapUrls.push(...urls.filter((url) => /\.xml(?:[?#].*)?$/i.test(new URL(url).pathname)).slice(0, maxSitemapsPerDomain));
      discoveredUrls.push(...urls.filter(isRelevantUrl).slice(0, maxUrlsPerDomain));
    }

    for (const sitemapUrl of dedupeUrls(sitemapUrls).filter((url) => safeHostname(url).endsWith(domain)).slice(0, maxSitemapsPerDomain)) {
      const urls = await fetchSitemapUrls(domain, sitemapUrl, timeoutMs);
      discoveredUrls.push(...urls.filter(isRelevantUrl).slice(0, maxUrlsPerDomain));
    }
  }

  const existingDiscovered = discoveryFile.discoveredUrls ?? [];
  const mergedDiscovered = dedupeDiscovered([
    ...existingDiscovered,
    ...discoveredUrls.map((url) => ({
      url,
      title: "sitemap candidate",
      domain: safeHostname(url),
      source: "sitemap"
    }))
  ]);

  if (writeConfig) {
    const seedUrls = capUrlsPerDomain(dedupeUrls([...(commonCrawlConfig.seedUrls ?? []), ...mergedDiscovered.map((item) => item.url)]).filter((url) => {
      const hostname = safeHostname(url).toLowerCase();
      return hostname && !isBlocked(hostname, blockedDomains) && isRelevantUrl(url);
    }), maxSeedUrlsPerDomain);
    await writeFile(commonCrawlConfigPath, `${JSON.stringify({ ...commonCrawlConfig, seedUrls }, null, 2)}\n`, "utf8");
    addLog("sitemap", commonCrawlConfigPath, "update-common-crawl", "success", `seedUrls=${seedUrls.length}`);
  }

  const result = {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: "source-discovery",
    discoveredUrls: mergedDiscovered,
    logs: dedupeLogs([...(discoveryFile.logs ?? []), ...logs])
  };

  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(`Sitemap seed expansion finished: ${mergedDiscovered.length} discovered URLs`);
  console.log(`Output: ${outPath}`);
}

function collectDomains(commonCrawlConfig, crawlerConfig, discoveryFile, blockedDomains) {
  const urls = [
    ...(commonCrawlConfig.seedUrls ?? []),
    ...((crawlerConfig.sites ?? []).flatMap((site) => [site.searchUrl, site.sitemapUrl, ...(site.manualUrls ?? [])])),
    ...((discoveryFile.discoveredUrls ?? []).map((item) => item.url))
  ];
  const domains = [];
  for (const url of urls) {
    const hostname = safeHostname(url).toLowerCase();
    if (!hostname || hostname === "-" || isBlocked(hostname, blockedDomains)) continue;
    if (!domains.includes(hostname)) domains.push(hostname);
  }
  return domains;
}

async function fetchRobots(domain, timeoutMs) {
  const robotsUrl = `https://${domain}/robots.txt`;
  try {
    const response = await fetchWithTimeout(robotsUrl, timeoutMs);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    addLog(domain, robotsUrl, "robots", "success", "Loaded robots.txt");
    return { rules: parseRobots(text), sitemaps: parseSitemapsFromRobots(text) };
  } catch (error) {
    addLog(domain, robotsUrl, "robots", "skipped", error.message);
    return { rules: [], sitemaps: [] };
  }
}

async function fetchSitemapUrls(domain, sitemapUrl, timeoutMs) {
  try {
    const response = await fetchWithTimeout(sitemapUrl, timeoutMs);
    if (response.status === 404) {
      addLog(domain, sitemapUrl, "sitemap", "skipped", "Not found");
      return [];
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    const urls = [...text.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)].map((match) => decodeHtml(match[1].trim()));
    addLog(domain, sitemapUrl, "sitemap", "success", `${urls.length} URLs`);
    return urls.filter(normalizeUrl);
  } catch (error) {
    addLog(domain, sitemapUrl, "sitemap", "skipped", error.message);
    return [];
  }
}

function parseRobots(text) {
  const rules = [];
  let applies = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, "").trim();
    if (!line) continue;
    const [rawKey, ...rest] = line.split(":");
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(":").trim();
    if (key === "user-agent") {
      applies = value === "*";
    } else if (applies && (key === "allow" || key === "disallow")) {
      rules.push({ type: key, path: value });
    }
  }
  return rules;
}

function parseSitemapsFromRobots(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^sitemap:/i.test(line))
    .map((line) => line.replace(/^sitemap:\s*/i, "").trim())
    .filter(normalizeUrl);
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

function isRelevantUrl(url) {
  if (/賃貸|マンション|アパート|中古|土地|リフォーム|リノベ|外観|内観|contact|privacy|recruit|login/i.test(url)) {
    return false;
  }
  return /間取り|間取|平面図|図面|madori|floor.?plan|floor_plan|layout|平屋|3ldk|4ldk|注文住宅|建売|分譲住宅|施工事例|建築実例|works|case|plan|bunjou|bunjo|estate/i.test(
    url
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
        "user-agent": "FloorplanLibrarySitemapDiscovery/0.1 (+personal low-frequency sitemap discovery)",
        accept: "application/xml,text/xml,text/plain,*/*;q=0.8"
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

function decodeHtml(value) {
  return String(value ?? "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
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
