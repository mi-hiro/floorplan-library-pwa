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
  const maxPages = Number(args.maxPages ?? 10);
  const delayMs = Number(args.delayMs ?? 700);
  const now = new Date().toISOString();
  const pages = [
    "https://www.iidasangyo.co.jp/order/plan/planhouse/index.html",
    "https://www.iidasangyo.co.jp/order/plan/planhouse/three_sh.html",
    "https://www.iidasangyo.co.jp/order/plan/onestory/index.html",
    "https://www.iidasangyo.co.jp/order/plan/twofamilies/index.html",
    "https://www.iidasangyo.co.jp/order/plan/barrierfree/index.html",
    "https://www.iidasangyo.co.jp/order/plan/owner/index.html"
  ].slice(0, maxPages);
  const robots = await fetchRobotsRules("iidasangyo.co.jp");
  const records = [];

  for (const pageUrl of pages) {
    if (!isAllowedByRobots(pageUrl, robots.rules)) continue;
    const response = await fetch(pageUrl);
    if (response.status === 403 || response.status === 429) throw new Error(`blocked with HTTP ${response.status}: ${pageUrl}`);
    if (!response.ok) continue;
    const html = await response.text();
    const pageTitle = (html.match(/<title>(.*?)<\/title>/i)?.[1] || "").replace(/\s+/g, " ").trim();
    const imageUrls = unique(
      [...html.matchAll(/(?:src|href)=["']([^"']+)["']/gi)]
        .map((match) => new URL(match[1], pageUrl).toString())
        .filter(isPlanImageUrl)
    );
    for (const imageUrl of imageUrls) {
      const title = titleFromUrl(imageUrl, pageTitle);
      const nearImageText = normalizeWhitespace(`${pageTitle} ${title}`);
      const candidate = {
        schemaVersion: 1,
        status: "candidate",
        firstSeenAt: now,
        lastSeenAt: now,
        sourceType: "adapter",
        sourceDomain: "iidasangyo.co.jp",
        companyName: "飯田産業",
        pageUrl,
        imageUrl,
        thumbnailUrl: imageUrl,
        pdfUrl: null,
        pdfPageNumber: null,
        discoveredFrom: "iidasangyo-plan-adapter",
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
  console.log(`Iidasangyo plan candidates: ${records.length}. ${out}: ${result.before} -> ${result.after}`);
}

function isPlanImageUrl(url) {
  const value = String(url || "");
  if (!/^https:\/\/www\.iidasangyo\.co\.jp\/order\/plan\//i.test(value)) return false;
  if (/_s\.(?:jpe?g|png|gif|webp)$/i.test(value)) return false;
  if (/title|ttl_|txt_|st_|btn_|logo|elevation|owner[0-9]|voice|^$/i.test(value)) return false;
  return /\/planhouse\/img\/[234]ldk_[0-9]+\.(?:jpe?g|png|gif|webp)$/i.test(value) ||
    /\/onestory\/img\/p_modelplan[0-9]+\.(?:jpe?g|png|gif|webp)$/i.test(value) ||
    /\/twofamilies\/img\/p_twofamilies\.(?:jpe?g|png|gif|webp)$/i.test(value) ||
    /\/barrierfree\/img\/p_(?:barrier|japanese1|sic1|wellhole1)\.(?:jpe?g|png|gif|webp)$/i.test(value) ||
    /\/owner\/img\/p_(?:2dk_[12]F|1dk|1k|1ldk)\.(?:jpe?g|png|gif|webp)$/i.test(value);
}

function titleFromUrl(url, pageTitle) {
  const file = String(url).split("/").pop() || "plan";
  const layout = file.match(/([1-7]ldk|[1-7]dk|[1-7]k)/i)?.[1]?.toUpperCase() || "";
  const floors = /three_sh|3f|3階/i.test(pageTitle) ? "3階建て" : /onestory|平屋/i.test(pageTitle) ? "平屋" : /twofamilies|二世帯/i.test(pageTitle) ? "二世帯" : /owner|賃貸/i.test(pageTitle) ? "賃貸向け" : "2階建て";
  return normalizeWhitespace(`飯田産業 ${layout || "注文住宅"} ${floors} 間取り図 ${file}`);
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
