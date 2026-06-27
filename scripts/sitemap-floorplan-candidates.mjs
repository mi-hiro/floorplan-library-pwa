#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { candidateImageId, getDomain, normalizeWhitespace } from "./lib/hash-utils.mjs";
import { extractImageCandidatesFromHtml, extractPdfLinksFromHtml } from "./lib/html-image-extractor.mjs";
import { extractMetadata, sourceSnippet } from "./lib/metadata-extractor.mjs";
import { upsertJsonlById } from "./lib/jsonl-store.mjs";
import { canCrawlDomain, markDomainStopped, markDomainSuccess, readCrawlState, writeCrawlState } from "./lib/crawl-state-store.mjs";
import { fetchRobotsRules, isAllowedByRobots } from "./lib/robots-utils.mjs";

const args = parseArgs(process.argv.slice(2));
const SITEMAP_PATHS = [
  "/sitemap.xml",
  "/sitemap_index.xml",
  "/post-sitemap.xml",
  "/page-sitemap.xml",
  "/works-sitemap.xml",
  "/plan-sitemap.xml",
  "/product-sitemap.xml",
  "/case-sitemap.xml",
  "/image-sitemap.xml",
  "/wp-sitemap.xml"
];
const PRIORITY_URL_PATTERNS = [
  /\/plan\//i,
  /\/plans\//i,
  /\/madori\//i,
  /\/floorplan\//i,
  /\/floor-plan\//i,
  /\/layout\//i,
  /\/lineup\//i,
  /\/product\//i,
  /\/hiraya\//i,
  /\/works\//i,
  /\/case\//i,
  /\/example\//i,
  /\/model\//i,
  /\/housing\//i,
  /\/home\//i,
  /間取り|施工事例|プラン|平屋|3ldk|4ldk/i
];
const LOW_PRIORITY_URL_PATTERNS = [
  /\/news\//i,
  /\/blog\//i,
  /\/staff\//i,
  /\/event\//i,
  /\/recruit\//i,
  /\/privacy\//i,
  /\/company\//i,
  /\/contact\//i,
  /\/youtube\//i,
  /\/ranking\//i,
  /\/campaign\//i,
  /\/voice\//i,
  /\/faq\//i
];

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

async function main() {
  const config = await readOptionalJson(args.config ?? "floorplan-growth.config.json");
  const mode = args.mode || "backfill";
  const out = args.out ?? "data/candidate-images.jsonl";
  const statePath = args.state ?? "data/crawl-state.json";
  const state = await readCrawlState(statePath);
  const derived = await deriveSources(config);
  const domains = selectDomains(derived.domains, config, mode, derived.blockedDomains, derived.stats);
  const maxPagesPerDomain = Number(args.maxPagesPerDomain ?? (mode === "daily" ? config.daily?.maxPagesPerDomain : config.backfill?.maxPagesPerDomain) ?? 10);
  const maxDomains = Number(args.maxDomains ?? (mode === "daily" ? config.daily?.maxDomainsPerRun : domains.length) ?? domains.length);
  const maxSitemapsPerDomain = Number(args.maxSitemapsPerDomain ?? 12);
  const delayMs = Number(args.delayMs ?? config.safety?.delayMsPerDomain ?? 10000);
  const timeoutMs = Number(config.safety?.requestTimeoutSeconds ?? 30) * 1000;
  const records = [];
  const selectedDomains = domains.slice(0, maxDomains);

  for (const domain of selectedDomains) {
    if (!canCrawlDomain(state, domain)) continue;
    let latestLastmod = state.domains?.[domain]?.sitemapLastmod || null;
    let pageCount = 0;
    try {
      const robots = await fetchRobotsRules(domain, { timeoutMs });
      const sitemapUrls = buildSitemapUrls(domain, robots.sitemaps || [], derived.sitemapsByDomain.get(domain) || []).slice(0, maxSitemapsPerDomain);
      const pageSeeds = [...(derived.pagesByDomain.get(domain) || [])];
      for (const pageUrl of pageSeeds) {
        if (pageCount >= maxPagesPerDomain) break;
        if (!isAllowedByRobots(pageUrl, robots.rules)) continue;
        const pageRecords = await collectPageCandidates(pageUrl, domain, "seed-url", timeoutMs);
        records.push(...pageRecords);
        pageCount += 1;
        if (delayMs > 0) await sleep(delayMs);
      }
      for (const sitemapUrl of sitemapUrls) {
        if (pageCount >= maxPagesPerDomain) break;
        if (!isAllowedByRobots(sitemapUrl, robots.rules)) continue;
        const sitemap = await fetchSitemapTree(sitemapUrl, robots.rules, timeoutMs);
        for (const item of sitemap.items) {
          if (item.lastmod && (!latestLastmod || item.lastmod > latestLastmod)) latestLastmod = item.lastmod;
          if (mode === "daily" && state.domains?.[domain]?.sitemapLastmod && item.lastmod && item.lastmod <= state.domains[domain].sitemapLastmod) {
            continue;
          }
          for (const imageUrl of item.imageUrls) {
            records.push(makeCandidate({ pageUrl: item.loc, imageUrl, domain, discoveredFrom: "image-sitemap", lastmod: item.lastmod }));
          }
          if (pageCount >= maxPagesPerDomain) continue;
          if (!isPriorityUrl(item.loc)) continue;
          if (!isAllowedByRobots(item.loc, robots.rules)) continue;
          const pageRecords = await collectPageCandidates(item.loc, domain, "sitemap", timeoutMs);
          records.push(...pageRecords.map((record) => ({ ...record, firstSeenAt: item.lastmod || record.firstSeenAt })));
          pageCount += 1;
          if (delayMs > 0) await sleep(delayMs);
        }
      }
      markDomainSuccess(state, domain, {
        sitemapLastmod: latestLastmod || state.domains?.[domain]?.sitemapLastmod || null,
        lastSitemapCandidateCount: records.filter((record) => record.sourceDomain === domain).length
      });
    } catch (error) {
      markDomainStopped(state, domain, error.message || "sitemap failed", { hours: isBlockError(error) ? 72 : 24 });
    }
  }

  const result = await upsertJsonlById(out, records);
  await writeCrawlState(state, statePath);
  console.log(`Sitemap candidates: ${records.length}. ${out}: ${result.before} -> ${result.after}`);
}

async function collectPageCandidates(pageUrl, domain, discoveredFrom, timeoutMs) {
  const response = await fetchWithTimeout(pageUrl, timeoutMs);
  if (response.status === 403 || response.status === 429) throw new Error(`blocked with HTTP ${response.status}`);
  if (!response.ok) return [];
  const html = await response.text();
  if (looksLikeCaptcha(html)) throw new Error("captcha detected");
  const records = [];
  for (const image of extractImageCandidatesFromHtml(html, pageUrl, { sourceType: "sitemap" })) {
    records.push(makeCandidate({ ...image, domain, discoveredFrom, pageUrl: image.pageUrl, imageUrl: image.imageUrl }));
  }
  for (const pdf of extractPdfLinksFromHtml(html, pageUrl)) {
    records.push(
      makeCandidate({
        pageUrl,
        imageUrl: pdf.pdfUrl,
        pdfUrl: pdf.pdfUrl,
        domain,
        discoveredFrom: "sitemap-pdf",
        title: pdf.label,
        alt: pdf.label,
        nearImageText: pdf.label
      })
    );
  }
  return records;
}

function makeCandidate({ pageUrl, imageUrl, pdfUrl = null, domain, discoveredFrom, lastmod = null, title = "", alt = "", caption = "", nearImageText = "", pageTitle = "" }) {
  const text = normalizeWhitespace([alt, caption, nearImageText, pageTitle, pageUrl].filter(Boolean).join(" "));
  const record = {
    id: candidateImageId({ imageUrl, pageUrl, pdfUrl }),
    schemaVersion: 1,
    status: "candidate",
    firstSeenAt: lastmod || new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    sourceType: "sitemap",
    sourceDomain: domain || getDomain(pageUrl || imageUrl),
    companyName: "",
    pageUrl,
    imageUrl,
    thumbnailUrl: "",
    pdfUrl,
    pdfPageNumber: null,
    discoveredFrom,
    title: title || alt || pageTitle || "sitemap candidate",
    pageTitle,
    alt,
    caption,
    nearImageText: text,
    sourceSnippet: sourceSnippet(text),
    metadata: extractMetadata({ title: pageTitle || title, nearImageText: text, alt })
  };
  return record;
}

async function fetchSitemapTree(sitemapUrl, robotsRules, timeoutMs, depth = 0) {
  const response = await fetchWithTimeout(sitemapUrl, timeoutMs);
  if (response.status === 403 || response.status === 429) throw new Error(`blocked with HTTP ${response.status}`);
  if (!response.ok) return { items: [] };
  const xml = await response.text();
  const parsed = parseSitemapXml(xml);
  if (parsed.sitemaps.length && depth < 1) {
    const nested = [];
    for (const child of parsed.sitemaps.filter((item) => isPrioritySitemap(item.loc)).slice(0, 20)) {
      if (!isAllowedByRobots(child.loc, robotsRules)) continue;
      const childTree = await fetchSitemapTree(child.loc, robotsRules, timeoutMs, depth + 1);
      nested.push(...childTree.items);
    }
    return { items: nested };
  }
  return { items: parsed.urls.filter((item) => isPriorityUrl(item.loc) || item.imageUrls.length) };
}

function parseSitemapXml(xml) {
  const sitemaps = [];
  const urls = [];
  for (const match of String(xml || "").matchAll(/<sitemap\b[\s\S]*?<\/sitemap>/gi)) {
    const block = match[0];
    const loc = decodeXml(block.match(/<loc[^>]*>([\s\S]*?)<\/loc>/i)?.[1] || "");
    if (loc) sitemaps.push({ loc, lastmod: decodeXml(block.match(/<lastmod[^>]*>([\s\S]*?)<\/lastmod>/i)?.[1] || "") });
  }
  for (const match of String(xml || "").matchAll(/<url\b[\s\S]*?<\/url>/gi)) {
    const block = match[0];
    const loc = decodeXml(block.match(/<loc[^>]*>([\s\S]*?)<\/loc>/i)?.[1] || "");
    const imageUrls = [...block.matchAll(/<image:loc[^>]*>([\s\S]*?)<\/image:loc>/gi)].map((item) => decodeXml(item[1])).filter(Boolean);
    if (loc) urls.push({ loc, lastmod: decodeXml(block.match(/<lastmod[^>]*>([\s\S]*?)<\/lastmod>/i)?.[1] || ""), imageUrls });
  }
  return { sitemaps, urls };
}

function buildSitemapUrls(domain, robotsSitemaps, explicitSitemaps) {
  const defaults = SITEMAP_PATHS.map((item) => `https://${domain}${item}`);
  return [...new Set([...robotsSitemaps, ...explicitSitemaps, ...defaults])];
}

async function deriveSources(config) {
  const domains = new Set(parseDomains(args.domains || config.sitemap?.domains || []));
  const pagesByDomain = new Map();
  const sitemapsByDomain = new Map();
  const common = await readOptionalJson(args.commonCrawlConfig ?? "common-crawl.config.json");
  const crawler = await readOptionalJson(args.crawlerConfig ?? "crawler.config.json");
  const stats = await readOptionalJson(args.sourceStats ?? "data/source-stats.json");

  for (const seedUrl of common.seedUrls || []) addSeed(seedUrl, domains, pagesByDomain, sitemapsByDomain);
  for (const site of crawler.sites || []) {
    if (site.majorPortal && !site.userAcknowledgedMajorPortal) continue;
    if (!site.enabled && !site.sitemapUrl) continue;
    if (site.domain) domains.add(String(site.domain).replace(/^www\./, "").toLowerCase());
    if (site.sitemapUrl) addSeed(site.sitemapUrl, domains, pagesByDomain, sitemapsByDomain);
    for (const manualUrl of site.manualUrls || []) addSeed(manualUrl, domains, pagesByDomain, sitemapsByDomain);
  }
  if (args.preferHighQuality) {
    for (const [domain, stat] of Object.entries(stats)) {
      if (stat.sourceQuality === "high" || stat.sourceQuality === "medium") domains.add(domain);
    }
  }
  return { domains: [...domains].filter(Boolean), pagesByDomain, sitemapsByDomain, blockedDomains: common.blockedDomains || [], stats };
}

function addSeed(rawUrl, domains, pagesByDomain, sitemapsByDomain) {
  try {
    const parsed = new URL(rawUrl);
    const domain = parsed.hostname.replace(/^www\./, "").toLowerCase();
    domains.add(domain);
    const map = /\.xml(?:$|[?#])/i.test(parsed.pathname) ? sitemapsByDomain : pagesByDomain;
    map.set(domain, [...(map.get(domain) || []), parsed.toString()]);
  } catch {
    // ignore invalid seed
  }
}

function selectDomains(domains, config, mode, extraBlockedDomains = [], stats = {}) {
  const blocked = new Set(["google.com", "google.co.jp", "bing.com", "yahoo.co.jp", "pinterest.com", "instagram.com", "facebook.com", "x.com", "twitter.com", "youtube.com", ...(config.blockedDomains || []), ...extraBlockedDomains]);
  const unique = [...new Set(domains)].filter((domain) => domain && !blocked.has(domain));
  if (mode !== "daily" || !args.preferHighQuality) return unique;
  return unique.sort((a, b) => qualityRank(stats[b]?.sourceQuality) - qualityRank(stats[a]?.sourceQuality));
}

function qualityRank(value) {
  if (value === "high") return 3;
  if (value === "medium") return 2;
  if (value === "low") return 1;
  return 0;
}

function isPrioritySitemap(url) {
  return /sitemap|post|page|works|plan|product|case|image|floor|madori/i.test(url);
}

function isPriorityUrl(url) {
  if (!url || LOW_PRIORITY_URL_PATTERNS.some((pattern) => pattern.test(url))) return false;
  return PRIORITY_URL_PATTERNS.some((pattern) => pattern.test(url));
}

function looksLikeCaptcha(html) {
  return /captcha|recaptcha|hcaptcha|アクセスが集中|ロボットではありません/i.test(String(html || "").slice(0, 20000));
}

function isBlockError(error) {
  return /403|429|captcha|blocked/i.test(error.message || "");
}

async function fetchWithTimeout(url, timeoutMs) {
  return fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
}

async function readOptionalJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return {};
  }
}

function parseDomains(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim().replace(/^www\./, "").toLowerCase()).filter(Boolean);
  return String(value || "")
    .split(",")
    .map((item) => item.trim().replace(/^www\./, "").toLowerCase())
    .filter(Boolean);
}

function decodeXml(value) {
  return normalizeWhitespace(value)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) result[key] = true;
    else {
      result[key] = next;
      i += 1;
    }
  }
  return result;
}
