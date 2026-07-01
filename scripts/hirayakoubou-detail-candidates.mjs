#!/usr/bin/env node
import { candidateImageId, normalizeWhitespace } from "./lib/hash-utils.mjs";
import { extractImageCandidatesFromHtml } from "./lib/html-image-extractor.mjs";
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
  const indexUrl = args.indexUrl ?? "https://hirayakoubou.net/plan/";
  const maxPages = Number(args.maxPages ?? 80);
  const delayMs = Number(args.delayMs ?? 800);
  const now = new Date().toISOString();
  const robots = await fetchRobotsRules("hirayakoubou.net");
  if (!isAllowedByRobots(indexUrl, robots.rules)) {
    console.log("Hirayakoubou index disallowed by robots.txt.");
    return;
  }

  const indexHtml = await fetchText(indexUrl);
  const detailUrls = unique(
    [...indexHtml.matchAll(/href=["']([^"']+)["']/gi)]
      .map((match) => new URL(match[1], indexUrl).toString())
      .filter((url) => /^https:\/\/hirayakoubou\.net\/plan\/[^/?#]+\/?$/i.test(url))
      .filter((url) => !/\/plan\/(?:$|sample\/)/i.test(url))
  ).slice(0, maxPages);

  const records = [];
  for (const pageUrl of detailUrls) {
    if (!isAllowedByRobots(pageUrl, robots.rules)) continue;
    const html = await fetchText(pageUrl, { optional: true });
    if (!html) continue;
    if (/captcha|recaptcha|hcaptcha|ロボットではありません/i.test(html.slice(0, 20000))) {
      throw new Error("hirayakoubou detail crawl stopped: captcha detected");
    }
    for (const image of extractImageCandidatesFromHtml(html, pageUrl, { sourceType: "adapter" })) {
      if (!/wp-content\/uploads\/[^?#]+fig[^?#]*\.(?:jpe?g|png|webp)(?:$|[?#])/i.test(image.imageUrl || "")) continue;
      if (/logo|favicon|closed|kou-fav|banner|bnr|common/i.test(image.imageUrl || "")) continue;
      const text = normalizeWhitespace(`${image.alt || ""} ${image.caption || ""} ${image.nearImageText || ""}`);
      records.push({
        ...image,
        id: candidateImageId(image),
        schemaVersion: 1,
        status: "candidate",
        firstSeenAt: now,
        lastSeenAt: now,
        sourceType: "adapter",
        sourceDomain: "hirayakoubou.net",
        companyName: "平屋幸房",
        discoveredFrom: "hirayakoubou-detail-adapter",
        title: image.alt || image.pageTitle || "平屋幸房の間取り図",
        nearImageText: text,
        sourceSnippet: sourceSnippet(text),
        metadata: extractMetadata({ title: image.pageTitle, nearImageText: text, alt: image.alt })
      });
    }
    if (delayMs > 0) await sleep(delayMs);
  }

  const result = await upsertJsonlById(out, records);
  console.log(`Hirayakoubou detail candidates: ${records.length}. ${out}: ${result.before} -> ${result.after}`);
}

async function fetchText(url, options = {}) {
  const response = await fetch(url);
  if (response.status === 403 || response.status === 429) throw new Error(`blocked with HTTP ${response.status}: ${url}`);
  if (options.optional && response.status === 404) return "";
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return response.text();
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
