#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { candidateImageId, getDomain, normalizeWhitespace } from "./lib/hash-utils.mjs";
import { extractImageCandidatesFromHtml, extractPdfLinksFromHtml } from "./lib/html-image-extractor.mjs";
import { extractMetadata, sourceSnippet } from "./lib/metadata-extractor.mjs";
import { upsertJsonlById } from "./lib/jsonl-store.mjs";

const args = parseArgs(process.argv.slice(2));
const SEARCH_TERMS = ["間取り", "平屋", "3LDK", "2LDK", "4LDK", "プラン", "施工事例", "注文住宅", "建売", "モデルハウス"];

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

async function main() {
  const config = await readOptionalJson(args.config ?? "floorplan-growth.config.json");
  const domains = parseDomains(args.domains || config.wordpress?.domains || []);
  const out = args.out ?? "data/candidate-images.jsonl";
  const maxPerDomain = Number(args.maxPerDomain ?? 20);
  const records = [];

  for (const domain of domains) {
    let domainCount = 0;
    for (const endpoint of ["posts", "pages"]) {
      for (const term of SEARCH_TERMS) {
        if (domainCount >= maxPerDomain) break;
        const url = `https://${domain}/wp-json/wp/v2/${endpoint}?search=${encodeURIComponent(term)}&per_page=10&_fields=link,title,content,modified`;
        let items = [];
        try {
          const response = await fetch(url);
          if (response.status === 403 || response.status === 404) break;
          if (!response.ok) continue;
          items = await response.json();
        } catch {
          continue;
        }
        for (const item of items) {
          const pageUrl = item.link;
          const html = item.content?.rendered || "";
          const pageTitle = normalizeWhitespace(item.title?.rendered || "");
          for (const image of extractImageCandidatesFromHtml(html, pageUrl, { sourceType: "wordpress_rest" })) {
            const nearImageText = normalizeWhitespace(`${image.nearImageText} ${pageTitle}`);
            records.push({
              ...image,
              id: candidateImageId(image),
              status: "candidate",
              firstSeenAt: item.modified || new Date().toISOString(),
              lastSeenAt: new Date().toISOString(),
              sourceType: "wordpress_rest",
              sourceDomain: getDomain(pageUrl),
              pageTitle,
              nearImageText,
              title: image.alt || pageTitle || "WordPress候補",
              sourceSnippet: sourceSnippet(nearImageText),
              metadata: extractMetadata({ title: pageTitle, nearImageText, alt: image.alt })
            });
            domainCount += 1;
          }
          for (const pdf of extractPdfLinksFromHtml(html, pageUrl)) {
            records.push({
              id: candidateImageId({ imageUrl: pdf.pdfUrl, pageUrl }),
              status: "candidate",
              firstSeenAt: item.modified || new Date().toISOString(),
              lastSeenAt: new Date().toISOString(),
              sourceType: "wordpress_rest",
              sourceDomain: getDomain(pageUrl),
              pageUrl,
              imageUrl: pdf.pdfUrl,
              pdfUrl: pdf.pdfUrl,
              pdfPageNumber: null,
              title: pdf.label || pageTitle || "PDF候補",
              pageTitle,
              alt: pdf.label || "",
              nearImageText: pdf.label || pageTitle,
              sourceSnippet: sourceSnippet(`${pdf.label} ${pageTitle}`),
              metadata: extractMetadata({ title: pageTitle, nearImageText: pdf.label })
            });
          }
        }
      }
    }
  }

  const result = await upsertJsonlById(out, records);
  console.log(`WordPress REST candidates: ${records.length}. ${out}: ${result.before} -> ${result.after}`);
}

function parseDomains(value) {
  if (Array.isArray(value)) return value;
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function readOptionalJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return {};
  }
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
