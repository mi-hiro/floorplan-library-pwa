#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const args = parseArgs(process.argv.slice(2));

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

async function main() {
  const discoveryPath = args.discoveryFile ?? path.join("crawler-output", "discovered-sources.json");
  const baseConfigPath = args.baseConfig ?? "crawler.config.json";
  const existingCrawlPath = args.existingCrawl ?? path.join("crawler-output", "latest-crawl.json");
  const outPath = args.out ?? path.join("crawler-output", "discovered-crawler.config.json");
  const discovery = await readOptionalJson(discoveryPath);
  const baseConfig = await readOptionalJson(baseConfigPath);
  const existingCrawl = await readOptionalJson(existingCrawlPath);
  const maxDomains = Number(args.maxDomains ?? 4);
  const maxUrlsPerDomain = Number(args.maxUrlsPerDomain ?? 12);
  const delaySeconds = Number(args.delaySeconds ?? 10);
  const blockedDomains = new Set([
    "google.com",
    "google.co.jp",
    "bing.com",
    "yahoo.co.jp",
    "pinterest.com",
    "instagram.com",
    "facebook.com",
    "x.com",
    "twitter.com",
    "youtube.com",
    "suumo.jp",
    "homes.co.jp",
    "athome.co.jp",
    "myhome.nifty.com",
    "town-life.jp",
    "ii-ie2.net",
    "hugkumi-life.jp"
  ]);
  const grouped = new Map();

  for (const item of discovery.discoveredUrls ?? []) {
    const url = normalizeUrl(item.url);
    if (!url || !isRelevantUrl(url)) continue;
    const hostname = safeHostname(url).toLowerCase();
    if (!hostname || isBlocked(hostname, blockedDomains)) continue;
    if (!grouped.has(hostname)) grouped.set(hostname, []);
    const urls = grouped.get(hostname);
    if (!urls.includes(url)) urls.push(url);
  }

  const currentCounts = countExistingByDomain(existingCrawl);
  const sites = [...grouped.entries()]
    .sort(([hostA, urlsA], [hostB, urlsB]) => {
      const countDelta = (currentCounts.get(normalizeDomain(hostA)) ?? 0) - (currentCounts.get(normalizeDomain(hostB)) ?? 0);
      if (countDelta !== 0) return countDelta;
      return scoreUrl(urlsB[0] || "") - scoreUrl(urlsA[0] || "");
    })
    .slice(0, maxDomains)
    .map(([hostname, urls]) => {
      const manualUrls = urls.sort((a, b) => scoreUrl(b) - scoreUrl(a)).slice(0, maxUrlsPerDomain);
      const shouldFollowLinks = manualUrls.some(looksLikeListingUrl);
      const followLinkBudget = shouldFollowLinks ? Math.max(8, maxUrlsPerDomain * 2) : 0;
      return {
        id: `discovered_${hashId(hostname)}`,
        siteName: `discovered ${hostname}`,
        domain: hostname,
        searchUrl: "",
        manualUrls,
        enabled: true,
        crawlMode: shouldFollowLinks ? "lowFrequency" : "manualOnly",
        perRunLimit: shouldFollowLinks ? manualUrls.length + followLinkBudget : manualUrls.length,
        delaySeconds,
        recrawlIntervalDays: 30,
        sitemapUrl: "",
        imageAutoFetch: false,
        imageSaveMode: "urlOnly",
        majorPortal: false
      };
    });

  const result = {
    global: {
      userAgent: "FloorplanLibraryCrawler/0.1 (+personal low-frequency crawler; respects robots.txt)",
      requestTimeoutSeconds: 30,
      maxPagesPerRun: Math.max(1, maxDomains * maxUrlsPerDomain),
      maxImagesPerCandidate: 90,
      floorplanOnly: true,
      verifyImageUrls: true,
      imageFetchLimit: 12,
      maxImageBytes: 3145728,
      ...(baseConfig.global ?? {}),
      floorplanOnly: true,
      looseImageCandidates: true,
      verifyImageUrls: true
    },
    sites
  };

  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(`Discovered crawler config written: ${sites.length} sites`);
  console.log(`Output: ${outPath}`);
}

function countExistingByDomain(crawl) {
  const counts = new Map();
  for (const candidate of crawl.candidates ?? []) {
    const domain = normalizeDomain(candidate.sourceUrl || candidate.listingSource || "");
    if (!domain) continue;
    counts.set(domain, (counts.get(domain) ?? 0) + 1);
  }
  return counts;
}

function normalizeDomain(value) {
  const hostname = safeHostname(value);
  if (hostname) return hostname.replace(/^www\./, "").toLowerCase();
  return String(value || "").replace(/^www\./, "").toLowerCase();
}

async function readOptionalJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return {};
  }
}

function isRelevantUrl(url) {
  if (/\.xml(?:[?#].*)?$/i.test(url)) return false;
  if (/賃貸|マンション|アパート|中古|土地|リフォーム|リノベ|contact|privacy|recruit|login/i.test(url)) return false;
  if (/english|financial|diversity|company\/financial|ir\/|csr\//i.test(url)) return false;
  return /間取り|間取|平面図|図面|madori|floor.?plan|floor_plan|layout|平屋|3ldk|4ldk|注文住宅|建売|分譲住宅|施工事例|建築実例|works|case|plan/i.test(url);
}

function scoreUrl(url) {
  let score = 0;
  if (/\/plan\/plan[0-9]+\/?$/i.test(url)) score += 120;
  if (/madori|間取り|floor.?plan|floor_plan|layout|平面図|図面/i.test(url)) score += 80;
  if (/施工事例|建築実例|works|case/i.test(url)) score += 35;
  if (/\.xml(?:[?#].*)?$/i.test(url)) score -= 200;
  if (/column|blog|news|english|financial|diversity|company/i.test(url)) score -= 60;
  if (/contact|privacy|recruit|login/i.test(url)) score -= 100;
  return score;
}

function looksLikeListingUrl(url) {
  return /\/(?:works?|case|construction|gallery|photo|voice|example|jitsurei|sekou|owner|interview)(?:\/|$|\?)/i.test(url);
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

function safeHostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function hashId(value) {
  return crypto.createHash("sha1").update(value).digest("hex").slice(0, 10);
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
