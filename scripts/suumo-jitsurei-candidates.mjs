#!/usr/bin/env node
import { candidateImageId, normalizeWhitespace } from "./lib/hash-utils.mjs";
import { readFile } from "node:fs/promises";
import { extractMetadata, sourceSnippet } from "./lib/metadata-extractor.mjs";
import { upsertJsonlById } from "./lib/jsonl-store.mjs";
import { canCrawlDomain, markDomainStopped, markDomainSuccess, readCrawlState, writeCrawlState } from "./lib/crawl-state-store.mjs";
import { fetchRobotsRules, isAllowedByRobots } from "./lib/robots-utils.mjs";

const args = parseArgs(process.argv.slice(2));
const DOMAIN = "suumo.jp";
const IMAGE_DOMAIN = "img01.suumo.com";
const BASE_ROOT_URL = "https://suumo.jp/chumon/jitsurei/";

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

async function main() {
  const config = await readOptionalJson(args.config ?? "floorplan-growth.config.json");
  const portalConfig = config.portalPilot?.suumo ?? {};
  const enabled = parseBool(args.enabled ?? portalConfig.enabled ?? config.portalPilot?.enabled, false);
  if (!enabled) {
    console.log("SUUMO portal pilot is disabled.");
    return;
  }

  const out = args.out ?? "data/candidate-images.jsonl";
  const statePath = args.state ?? "data/crawl-state.json";
  const state = await readCrawlState(statePath);
  const intervalDays = Number(args.recrawlIntervalDays ?? portalConfig.recrawlIntervalDays ?? 1);
  const force = parseBool(args.force, false);
  const domainState = state.domains?.[DOMAIN] || {};
  if (!force && domainState.portalPilotLastRunAt && Date.now() - new Date(domainState.portalPilotLastRunAt).getTime() < intervalDays * 86400000) {
    console.log(`SUUMO portal pilot skipped: interval ${intervalDays} days.`);
    return;
  }
  if (!canCrawlDomain(state, DOMAIN) && !force) {
    console.log("SUUMO portal pilot skipped: domain is waiting for next crawl window.");
    return;
  }

  const maxRootPages = Number(args.maxRootPages ?? portalConfig.maxRootPages ?? 8);
  const maxCasePages = Number(args.maxCasePages ?? portalConfig.maxCasePages ?? 20);
  const maxListPagesPerRegion = Math.max(1, Number(args.maxListPagesPerRegion ?? portalConfig.maxListPagesPerRegion ?? 1));
  const delayMs = Number(args.delayMs ?? portalConfig.delayMs ?? 3000);
  const regionBatchSize = Number(args.regionBatchSize ?? portalConfig.regionBatchSize ?? 4);
  const rotateRegionalRoots = parseBool(args.rotateRegionalRoots ?? portalConfig.rotateRegionalRoots, true);
  const includeRootPage = parseBool(args.includeRootPage ?? portalConfig.includeRootPage, false);
  const configuredRoots = unique([...(portalConfig.rootUrls || []), BASE_ROOT_URL])
    .map(canonicalRootUrl)
    .filter(Boolean);
  const baseRootUrls = unique(configuredRoots.filter((url) => !isRegionalRootUrl(url)));
  const configuredRegionalRoots = unique(configuredRoots.filter(isRegionalRootUrl));
  const now = new Date().toISOString();
  const pageRobots = await fetchRobotsRules(DOMAIN);
  const imageRobots = await fetchRobotsRules(IMAGE_DOMAIN);
  const records = [];

  try {
    const detailSeeds = [];
    const rootHtmlCache = new Map();
    let discoveredRegionalRoots = [];

    for (const rootUrl of (baseRootUrls.length ? baseRootUrls : [BASE_ROOT_URL])) {
      if (!isAllowedByRobots(rootUrl, pageRobots.rules)) continue;
      const html = await fetchHtml(rootUrl);
      rootHtmlCache.set(rootUrl, html);
      discoveredRegionalRoots.push(...extractRegionalJitsureiUrls(html, rootUrl));
      if (includeRootPage) detailSeeds.push(...extractCaseUrls(html, rootUrl).filter(isCaseUrl));
      if (delayMs > 0) await sleep(delayMs);
    }

    const regionalRoots = unique([...configuredRegionalRoots, ...discoveredRegionalRoots.map(canonicalRootUrl)]).filter(isRegionalRootUrl);
    const cursor = Number.isFinite(Number(domainState.suumoRegionCursor)) ? Number(domainState.suumoRegionCursor) : 0;
    const selectedRegionalRoots = rotateRegionalRoots
      ? selectRotatingBatch(regionalRoots, cursor, regionBatchSize)
      : regionalRoots.slice(0, Math.max(0, regionBatchSize));
    const rootUrls = unique([
      ...(includeRootPage ? (baseRootUrls.length ? baseRootUrls : [BASE_ROOT_URL]) : []),
      ...selectedRegionalRoots,
      ...(selectedRegionalRoots.length ? [] : (baseRootUrls.length ? baseRootUrls : [BASE_ROOT_URL]))
    ]).slice(0, maxRootPages);

    for (const rootUrl of rootUrls) {
      if (detailSeeds.length >= maxCasePages) break;
      if (!isAllowedByRobots(rootUrl, pageRobots.rules)) continue;
      const html = rootHtmlCache.get(rootUrl) ?? await fetchHtml(rootUrl);
      detailSeeds.push(...extractCaseUrls(html, rootUrl).filter(isCaseUrl));
      if (delayMs > 0) await sleep(delayMs);

      for (const listUrl of extractPaginationUrls(html, rootUrl).slice(0, maxListPagesPerRegion - 1)) {
        if (detailSeeds.length >= maxCasePages) break;
        if (!isAllowedByRobots(listUrl, pageRobots.rules)) continue;
        const listHtml = await fetchHtml(listUrl);
        detailSeeds.push(...extractCaseUrls(listHtml, listUrl).filter(isCaseUrl));
        if (delayMs > 0) await sleep(delayMs);
      }
    }

    for (const pageUrl of unique(detailSeeds).slice(0, maxCasePages)) {
      if (!isAllowedByRobots(pageUrl, pageRobots.rules)) continue;
      const html = await fetchHtml(pageUrl);
      if (looksLikeCaptcha(html)) throw new Error("captcha detected");
      const pageTitle = normalizeWhitespace((html.match(/<title>(.*?)<\/title>/i)?.[1] || "").replace(/&[^;]+;/g, " "));
      for (const imageUrl of extractFloorplanImages(html, pageUrl)) {
        if (!isAllowedByRobots(imageUrl, imageRobots.rules)) continue;
        const title = makeTitle(pageTitle, imageUrl);
        const nearImageText = normalizeWhitespace(`${pageTitle} SUUMO 注文住宅 建築実例 間取り図`);
        const candidate = {
          schemaVersion: 1,
          status: "candidate",
          firstSeenAt: now,
          lastSeenAt: now,
          sourceType: "portal",
          sourceDomain: DOMAIN,
          companyName: "SUUMO 注文住宅実例",
          pageUrl,
          imageUrl,
          thumbnailUrl: imageUrl,
          pdfUrl: null,
          pdfPageNumber: null,
          discoveredFrom: "suumo-jitsurei-portal-pilot",
          title,
          pageTitle,
          alt: title,
          caption: "",
          nearImageText,
          sourceSnippet: sourceSnippet(nearImageText),
          metadata: extractMetadata({ title, pageTitle, nearImageText, alt: title })
        };
        candidate.id = candidateImageId(candidate);
        records.push(candidate);
      }
      if (delayMs > 0) await sleep(delayMs);
    }

    const result = await upsertJsonlById(out, records);
    markDomainSuccess(state, DOMAIN, {
      portalPilotLastRunAt: now,
      suumoRegionCursor: regionalRoots.length ? (cursor + selectedRegionalRoots.length) % regionalRoots.length : cursor,
      suumoRegionCount: regionalRoots.length,
      lastPortalRegionRoots: selectedRegionalRoots,
      lastPortalCandidateCount: records.length,
      nextCrawlAfter: new Date(Date.now() + intervalDays * 86400000).toISOString()
    });
    await writeCrawlState(state, statePath);
    console.log(`SUUMO portal pilot candidates: ${records.length}. regions: ${selectedRegionalRoots.length}/${regionalRoots.length}. ${out}: ${result.before} -> ${result.after}`);
  } catch (error) {
    markDomainStopped(state, DOMAIN, error.message || "portal pilot failed", { hours: 24 * 30 });
    await writeCrawlState(state, statePath);
    throw error;
  }
}

async function fetchHtml(url) {
  const response = await fetch(url, { redirect: "follow" });
  if (response.status === 403 || response.status === 429) throw new Error(`blocked with HTTP ${response.status}: ${url}`);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return response.text();
}

function extractCaseUrls(html, baseUrl) {
  return unique(
    [...String(html || "").matchAll(/href=["']([^"']+)["']/gi)]
      .map((match) => safeUrl(match[1], baseUrl))
      .filter(Boolean)
      .filter(isCaseUrl)
      .map(canonicalPageUrl)
  );
}

function extractRegionalJitsureiUrls(html, baseUrl) {
  return unique(
    [...String(html || "").matchAll(/href=["']([^"']+)["']/gi)]
      .map((match) => safeUrl(match[1], baseUrl))
      .filter(Boolean)
      .map(canonicalRootUrl)
      .filter(isRegionalRootUrl)
  );
}

function extractPaginationUrls(html, baseUrl) {
  let base;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }
  return unique(
    [...String(html || "").matchAll(/href=["']([^"']+)["']/gi)]
      .map((match) => safeUrl(match[1], baseUrl))
      .filter(Boolean)
      .filter((url) => {
        try {
          const parsed = new URL(url);
          return parsed.hostname === DOMAIN && parsed.pathname === base.pathname && Number(parsed.searchParams.get("pn") || 0) > 1;
        } catch {
          return false;
        }
      })
      .map(canonicalPageUrl)
  ).sort((a, b) => listPageNumber(a) - listPageNumber(b));
}

function extractFloorplanImages(html, baseUrl) {
  return unique(
    [...String(html || "").matchAll(/(?:src|data-src|href)=["']([^"']+)["']/gi)]
      .map((match) => safeUrl(match[1], baseUrl))
      .filter(Boolean)
      .filter((url) => /^https:\/\/img01\.suumo\.com\/front\/gazo\/chumon\/[0-9]+\/[0-9]+\/main\/[^/?#]+m[0-9]+\.(?:jpe?g|png|webp)(?:$|[?#])/i.test(url))
  );
}

function isCaseUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "suumo.jp") return false;
    return /^\/chumon\/(?:tn_[^/]+\/)?(?:koumuten\/)?rn_[^/]+\/[^/]+\/jitsurei\/jc_[0-9]+\/?$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function canonicalPageUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

function canonicalRootUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.search = "";
    parsed.hash = "";
    if (!parsed.pathname.endsWith("/")) parsed.pathname = `${parsed.pathname}/`;
    return parsed.toString();
  } catch {
    return "";
  }
}

function isRegionalRootUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname === DOMAIN && /^\/chumon\/tn_[^/]+\/jitsurei\/$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function listPageNumber(url) {
  try {
    return Number(new URL(url).searchParams.get("pn") || 1);
  } catch {
    return 1;
  }
}

function makeTitle(pageTitle, imageUrl) {
  const layout = pageTitle.match(/[1-7]\s*S?\s*LDK|[1-7]\s*DK|平屋/i)?.[0]?.replace(/\s+/g, "").toUpperCase() || "";
  const floor = imageUrl.match(/m0?([0-9]+)/i)?.[1] || "";
  return normalizeWhitespace(`SUUMO 注文住宅実例 ${layout} 間取り図${floor ? ` ${floor}枚目` : ""}`);
}

function looksLikeCaptcha(html) {
  return /captcha|recaptcha|hcaptcha|認証にご協力ください|ロボットではありません/i.test(String(html || "").slice(0, 20000));
}

function safeUrl(rawUrl, baseUrl) {
  try {
    return new URL(rawUrl, baseUrl).toString();
  } catch {
    return "";
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function selectRotatingBatch(values, start, count) {
  if (!values.length || count <= 0) return [];
  const safeStart = ((Number(start) || 0) % values.length + values.length) % values.length;
  const limit = Math.min(Number(count) || 0, values.length);
  const result = [];
  for (let i = 0; i < limit; i += 1) {
    result.push(values[(safeStart + i) % values.length]);
  }
  return result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readOptionalJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return {};
  }
}

function parseBool(value, defaultValue = false) {
  if (value == null) return defaultValue;
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
    if (!next || next.startsWith("--")) result[key] = true;
    else {
      result[key] = next;
      i += 1;
    }
  }
  return result;
}
