#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { candidateImageId, getDomain, normalizeUrl, normalizeWhitespace } from "./lib/hash-utils.mjs";
import { upsertJsonlById } from "./lib/jsonl-store.mjs";
import { extractMetadata, sourceSnippet } from "./lib/metadata-extractor.mjs";

const args = parseArgs(process.argv.slice(2));

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

async function main() {
  const inputPath = args.input ?? "crawler-output/latest-crawl.json";
  const outPath = args.out ?? "data/candidate-images.jsonl";
  const payload = JSON.parse(await readFile(inputPath, "utf8"));
  const now = new Date().toISOString();
  const records = [];

  for (const candidate of payload.candidates ?? []) {
    for (const image of candidate.imageCandidates ?? []) {
      const imageUrl = image.url || image.imageUrl;
      if (!imageUrl) continue;
      const pageUrl = candidate.sourceUrl || image.sourceUrl || "";
      const nearImageText = normalizeWhitespace(
        [image.alt, candidate.title, candidate.layout, candidate.floors, candidate.memo].filter(Boolean).join(" ")
      );
      const record = {
        id: candidateImageId({ imageUrl, pageUrl }),
        schemaVersion: 1,
        status: "candidate",
        firstSeenAt: image.firstSeenAt || candidate.fetchedAt || now,
        lastSeenAt: now,
        sourceType: inferSourceType(candidate),
        sourceDomain: getDomain(pageUrl || imageUrl),
        companyName: candidate.company || candidate.listingSource || "",
        pageUrl,
        imageUrl,
        thumbnailUrl: image.thumbnailUrl || "",
        pdfUrl: null,
        pdfPageNumber: null,
        discoveredFrom: candidate.listingSource || "latest-crawl",
        title: image.alt || candidate.title || "間取り図候補",
        pageTitle: candidate.title || "",
        alt: image.alt || "",
        caption: "",
        nearImageText,
        sourceSnippet: sourceSnippet(nearImageText),
        metadata: extractMetadata({
          title: candidate.title || "",
          nearImageText,
          alt: image.alt || ""
        }),
        originalCandidateId: candidate.id || "",
        originalImageId: image.id || "",
        originalKind: image.kind || "",
        ollamaReview: image.ollamaReview || null,
        normalizedImageUrl: normalizeUrl(imageUrl),
        normalizedPageUrl: normalizeUrl(pageUrl)
      };
      records.push(record);
    }
  }

  const result = await upsertJsonlById(outPath, records);
  console.log(`Imported candidates: ${records.length}. ${outPath}: ${result.before} -> ${result.after}`);
}

function inferSourceType(candidate) {
  const memo = `${candidate.memo || ""} ${candidate.listingSource || ""}`;
  if (/Common Crawl/i.test(memo)) return "common_crawl";
  if (/sitemap/i.test(memo)) return "sitemap";
  return "adapter";
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
