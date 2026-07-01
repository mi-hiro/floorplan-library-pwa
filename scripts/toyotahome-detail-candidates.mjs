#!/usr/bin/env node
import { candidateImageId, normalizeWhitespace } from "./lib/hash-utils.mjs";
import { extractImageCandidatesFromHtml } from "./lib/html-image-extractor.mjs";
import { extractMetadata, sourceSnippet } from "./lib/metadata-extractor.mjs";
import { readJsonl, upsertJsonlById } from "./lib/jsonl-store.mjs";
import { fetchRobotsRules, isAllowedByRobots } from "./lib/robots-utils.mjs";

const args = parseArgs(process.argv.slice(2));

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

async function main() {
  const input = args.input ?? "data/candidate-images.jsonl";
  const out = args.out ?? "data/candidate-images.jsonl";
  const maxPages = Number(args.maxPages ?? 180);
  const delayMs = Number(args.delayMs ?? 800);
  const now = new Date().toISOString();
  const existing = await readJsonl(input);
  const detailUrls = unique(
    existing
      .flatMap((record) => [record.pageUrl, record.imageUrl])
      .filter((url) => /toyotahome\.co\.jp\/housing\/howto\/madori\/design\/detail\.html\?id=/i.test(String(url || "")))
      .map(normalizeDetailUrl)
  ).slice(0, maxPages);

  const robots = await fetchRobotsRules("toyotahome.co.jp");
  const records = [];
  for (const pageUrl of detailUrls) {
    if (!isAllowedByRobots(pageUrl, robots.rules)) continue;
    const response = await fetch(pageUrl);
    if (response.status === 403 || response.status === 429) {
      throw new Error(`toyotahome detail crawl stopped with HTTP ${response.status}`);
    }
    if (!response.ok) continue;
    const html = await response.text();
    if (/captcha|recaptcha|hcaptcha|ロボットではありません/i.test(html.slice(0, 20000))) {
      throw new Error("toyotahome detail crawl stopped: captcha detected");
    }
    const images = extractImageCandidatesFromHtml(html, pageUrl, { sourceType: "adapter" });
    for (const image of images) {
      if (!/\/floorplan\/[0-9]+_heimen[0-9]*\.webp(?:$|[?#])/i.test(image.imageUrl || "")) continue;
      if (/ritumen|noimg|banner|logo|common\//i.test(image.imageUrl || "")) continue;
      const text = normalizeWhitespace(`${image.alt || ""} ${image.caption || ""} ${image.nearImageText || ""}`);
      const record = {
        ...image,
        id: candidateImageId(image),
        schemaVersion: 1,
        status: "candidate",
        firstSeenAt: now,
        lastSeenAt: now,
        sourceType: "adapter",
        sourceDomain: "toyotahome.co.jp",
        companyName: "トヨタホーム",
        discoveredFrom: "toyotahome-detail-adapter",
        title: image.alt || image.pageTitle || "トヨタホームの平面図",
        nearImageText: text,
        sourceSnippet: sourceSnippet(text),
        metadata: extractMetadata({ title: image.pageTitle, nearImageText: text, alt: image.alt })
      };
      records.push(record);
    }
    if (delayMs > 0) await sleep(delayMs);
  }

  const result = await upsertJsonlById(out, records);
  console.log(`Toyotahome detail candidates: ${records.length}. ${out}: ${result.before} -> ${result.after}`);
}

function normalizeDetailUrl(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/^http:\/\//i, "https://")
    .replace(/#.*$/, "");
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
