#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { candidateImageId, getDomain, normalizeWhitespace } from "./lib/hash-utils.mjs";
import { extractImageCandidatesFromHtml, extractPdfLinksFromHtml } from "./lib/html-image-extractor.mjs";
import { extractMetadata, sourceSnippet } from "./lib/metadata-extractor.mjs";
import { upsertJsonlById } from "./lib/jsonl-store.mjs";
import { canCrawlDomain, markDomainStopped, markDomainSuccess, readCrawlState, writeCrawlState } from "./lib/crawl-state-store.mjs";
import { fetchRobotsRules, isAllowedByRobots } from "./lib/robots-utils.mjs";

const args = parseArgs(process.argv.slice(2));
const SEARCH_TERMS = ["間取り", "平屋", "3LDK", "2LDK", "4LDK", "プラン", "施工事例", "注文住宅", "建売", "モデルハウス"];

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

async function main() {
  const config = await readOptionalJson(args.config ?? "floorplan-growth.config.json");
  const out = args.out ?? "data/candidate-images.jsonl";
  const statePath = args.state ?? "data/crawl-state.json";
  const state = await readCrawlState(statePath);
  const mode = args.mode || (args.daily ? "daily" : "backfill");
  const domains = await deriveDomains(config, mode);
  const maxPerDomain = Number(args.maxPerDomain ?? (mode === "daily" ? 10 : 30));
  const maxDomains = Number(args.maxDomains ?? (mode === "daily" ? config.daily?.maxDomainsPerRun : domains.length) ?? domains.length);
  const delayMs = Number(args.delayMs ?? Math.min(3000, config.safety?.delayMsPerDomain ?? 3000));
  const records = [];

  for (const domain of domains.slice(0, maxDomains)) {
    if (!canCrawlDomain(state, domain)) continue;
    const robots = await fetchRobotsRules(domain);
    let domainCount = 0;
    let latestModified = state.domains?.[domain]?.wordpressModifiedAfter || null;
    try {
      for (const endpoint of ["posts", "pages"]) {
        for (const term of SEARCH_TERMS) {
          if (domainCount >= maxPerDomain) break;
          const url = buildRestUrl(domain, endpoint, term, mode === "daily" ? state.domains?.[domain]?.wordpressModifiedAfter : null);
          if (!isAllowedByRobots(url, robots.rules)) continue;
          const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
          if (response.status === 403 || response.status === 404) break;
          if (response.status === 429) throw new Error("blocked with HTTP 429");
          if (!response.ok) continue;
          const items = await response.json();
          if (!Array.isArray(items)) continue;
          for (const item of items) {
            if (domainCount >= maxPerDomain) break;
            const pageUrl = item.link;
            if (!pageUrl || !isAllowedByRobots(pageUrl, robots.rules)) continue;
            const html = item.content?.rendered || "";
            const pageTitle = normalizeWhitespace(item.title?.rendered || "");
            const modified = item.modified || item.modified_gmt || new Date().toISOString();
            if (modified && (!latestModified || modified > latestModified)) latestModified = modified;
            for (const image of extractImageCandidatesFromHtml(html, pageUrl, { sourceType: "wordpress_rest" })) {
              const nearImageText = normalizeWhitespace(`${image.nearImageText} ${pageTitle}`);
              records.push({
                ...image,
                id: candidateImageId(image),
                status: "candidate",
                firstSeenAt: modified,
                lastSeenAt: new Date().toISOString(),
                sourceType: "wordpress_rest",
                sourceDomain: getDomain(pageUrl),
                pageTitle,
                nearImageText,
                title: image.alt || pageTitle || "WordPress candidate",
                sourceSnippet: sourceSnippet(nearImageText),
                metadata: extractMetadata({ title: pageTitle, nearImageText, alt: image.alt })
              });
              domainCount += 1;
            }
            for (const pdf of extractPdfLinksFromHtml(html, pageUrl)) {
              records.push({
                id: candidateImageId({ imageUrl: pdf.pdfUrl, pageUrl }),
                status: "candidate",
                firstSeenAt: modified,
                lastSeenAt: new Date().toISOString(),
                sourceType: "wordpress_rest",
                sourceDomain: getDomain(pageUrl),
                pageUrl,
                imageUrl: pdf.pdfUrl,
                pdfUrl: pdf.pdfUrl,
                pdfPageNumber: null,
                title: pdf.label || pageTitle || "PDF candidate",
                pageTitle,
                alt: pdf.label || "",
                nearImageText: pdf.label || pageTitle,
                sourceSnippet: sourceSnippet(`${pdf.label} ${pageTitle}`),
                metadata: extractMetadata({ title: pageTitle, nearImageText: pdf.label })
              });
            }
          }
          if (delayMs > 0) await sleep(delayMs);
        }
      }
      markDomainSuccess(state, domain, { wordpressModifiedAfter: latestModified });
    } catch (error) {
      markDomainStopped(state, domain, error.message || "wordpress failed", { hours: /403|429/.test(error.message || "") ? 72 : 24 });
    }
  }

  const result = await upsertJsonlById(out, records);
  await writeCrawlState(state, statePath);
  console.log(`WordPress REST candidates: ${records.length}. ${out}: ${result.before} -> ${result.after}`);
}

function buildRestUrl(domain, endpoint, term, modifiedAfter) {
  const url = new URL(`https://${domain}/wp-json/wp/v2/${endpoint}`);
  url.searchParams.set("search", term);
  url.searchParams.set("per_page", "10");
  url.searchParams.set("_fields", "link,title,content,modified,modified_gmt");
  if (modifiedAfter) url.searchParams.set("modified_after", modifiedAfter);
  return url.toString();
}

async function deriveDomains(config, mode) {
  const domains = new Set(parseDomains(args.domains || config.wordpress?.domains || []));
  const common = await readOptionalJson(args.commonCrawlConfig ?? "common-crawl.config.json");
  const stats = await readOptionalJson(args.sourceStats ?? "data/source-stats.json");
  for (const seedUrl of common.seedUrls || []) {
    const domain = getDomain(seedUrl);
    if (domain) domains.add(domain);
  }
  if (mode === "daily" || args.preferHighQuality) {
    for (const [domain, stat] of Object.entries(stats)) {
      if (stat.sourceQuality === "high" || stat.sourceQuality === "medium") domains.add(domain);
    }
  }
  const blocked = new Set([...(common.blockedDomains || []), "google.com", "google.co.jp", "bing.com", "yahoo.co.jp", "youtube.com"]);
  const ordered = [...domains].filter((domain) => domain && !blocked.has(domain));
  if (mode !== "daily") return ordered;
  return ordered.sort((a, b) => qualityRank(stats[b]?.sourceQuality) - qualityRank(stats[a]?.sourceQuality));
}

function qualityRank(value) {
  if (value === "high") return 3;
  if (value === "medium") return 2;
  if (value === "low") return 1;
  return 0;
}

function parseDomains(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim().replace(/^www\./, "").toLowerCase()).filter(Boolean);
  return String(value || "")
    .split(",")
    .map((item) => item.trim().replace(/^www\./, "").toLowerCase())
    .filter(Boolean);
}

async function readOptionalJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return {};
  }
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
