#!/usr/bin/env node
import { candidateImageId, normalizeWhitespace } from "./lib/hash-utils.mjs";
import { extractMetadata, sourceSnippet } from "./lib/metadata-extractor.mjs";
import { upsertJsonlById } from "./lib/jsonl-store.mjs";
import { fetchRobotsRules, isAllowedByRobots } from "./lib/robots-utils.mjs";

const args = parseArgs(process.argv.slice(2));

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

async function main() {
  const out = args.out ?? "data/candidate-images.jsonl";
  const maxPages = Number(args.maxPages ?? 80);
  const delayMs = Number(args.delayMs ?? 800);
  const now = new Date().toISOString();
  const robots = await fetchRobotsRules("universalhome.co.jp");
  const indexUrls = [
    "https://www.universalhome.co.jp/concept_plan/nikai/",
    "https://www.universalhome.co.jp/concept_plan/hiraya/"
  ];

  const detailUrls = [];
  for (const indexUrl of indexUrls) {
    if (!isAllowedByRobots(indexUrl, robots.rules)) continue;
    const html = await fetchText(indexUrl);
    detailUrls.push(
      ...[...html.matchAll(/href=["']([^"']+)["']/gi)]
        .map((match) => new URL(match[1], indexUrl).toString())
        .filter((url) => /^https:\/\/www\.universalhome\.co\.jp\/concept_plan\/(?:nikai|hiraya)\/[a-z][0-9]+\/?$/i.test(url))
    );
    if (delayMs > 0) await sleep(delayMs);
  }

  const records = [];
  for (const pageUrl of unique(detailUrls).slice(0, maxPages)) {
    if (!isAllowedByRobots(pageUrl, robots.rules)) continue;
    const html = await fetchText(pageUrl, { optional: true });
    if (!html) continue;
    if (/captcha|recaptcha|hcaptcha|ロボットではありません/i.test(html.slice(0, 20000))) {
      throw new Error("universalhome concept crawl stopped: captcha detected");
    }
    const pageTitle = normalizeWhitespace((html.match(/<title>(.*?)<\/title>/i)?.[1] || ""));
    const imageUrls = unique(
      [...html.matchAll(/(?:src|data-src|href)=["']([^"']+)["']/gi)]
        .map((match) => new URL(match[1], pageUrl).toString())
        .filter(isFloorImageUrl)
    );
    for (const imageUrl of imageUrls) {
      const floorLabel = imageUrl.match(/img_floor_0?([0-9]+)/i)?.[1] ?? "";
      const floors = pageUrl.includes("/hiraya/") ? "平屋" : "2階建て";
      const title = normalizeWhitespace(`${stripBrandSuffix(pageTitle)} ${floorLabel ? `${floorLabel}F` : ""} 間取り図`);
      const nearImageText = normalizeWhitespace(`${pageTitle} ${floors} ${floorLabel ? `${floorLabel}F` : ""} 間取り図 ユニバーサルホーム`);
      const candidate = {
        schemaVersion: 1,
        status: "candidate",
        firstSeenAt: now,
        lastSeenAt: now,
        sourceType: "adapter",
        sourceDomain: "universalhome.co.jp",
        companyName: "ユニバーサルホーム",
        pageUrl,
        imageUrl,
        thumbnailUrl: imageUrl,
        pdfUrl: null,
        pdfPageNumber: null,
        discoveredFrom: "universalhome-concept-adapter",
        title,
        pageTitle,
        alt: title,
        caption: floorLabel ? `${floorLabel}F` : "",
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
  console.log(`Universalhome concept candidates: ${records.length}. ${out}: ${result.before} -> ${result.after}`);
}

async function fetchText(url, options = {}) {
  const response = await fetch(url);
  if (response.status === 403 || response.status === 429) throw new Error(`blocked with HTTP ${response.status}: ${url}`);
  if (options.optional && response.status === 404) return "";
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return response.text();
}

function isFloorImageUrl(url) {
  const value = String(url || "");
  return /^https:\/\/www\.universalhome\.co\.jp\/concept_plan\/(?:nikai|hiraya)\/[a-z][0-9]+\/img\/img_floor_[0-9]+\.(?:png|jpe?g|webp)(?:$|[?#])/i.test(value);
}

function stripBrandSuffix(value) {
  return normalizeWhitespace(String(value || "").replace(/[｜|].*?ユニバーサルホーム.*$/i, ""));
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
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
