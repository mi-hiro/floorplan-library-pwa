#!/usr/bin/env node
import { candidateImageId, getDomain } from "./lib/hash-utils.mjs";
import { readJsonl, upsertJsonlById } from "./lib/jsonl-store.mjs";
import { readCrawlState, writeCrawlState } from "./lib/crawl-state-store.mjs";

const args = parseArgs(process.argv.slice(2));

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

async function main() {
  const input = args.input ?? "data/candidate-images.jsonl";
  const reviewOut = args.review ?? "data/review-queue.jsonl";
  const statePath = args.state ?? "data/crawl-state.json";
  const state = await readCrawlState(statePath);
  const processed = new Set(state.pdf?.processedUrls || []);
  const maxPdfFiles = Number(args.maxPdfFiles ?? 20);
  const candidates = await readJsonl(input);
  const pdfs = candidates
    .filter((record) => record.pdfUrl || /\.pdf(?:$|[?#])/i.test(record.imageUrl || ""))
    .filter((record) => !processed.has(record.pdfUrl || record.imageUrl))
    .slice(0, maxPdfFiles)
    .map((record) => ({
      id: candidateImageId({ imageUrl: record.pdfUrl || record.imageUrl, pageUrl: record.pageUrl }),
      status: "review",
      firstSeenAt: record.firstSeenAt || new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      imageUrl: record.imageUrl,
      pageUrl: record.pageUrl,
      pdfUrl: record.pdfUrl || record.imageUrl,
      pdfPageNumber: record.pdfPageNumber ?? null,
      sourceDomain: record.sourceDomain || getDomain(record.pageUrl || record.imageUrl),
      title: record.title || "PDF間取り候補",
      reason: "pdf-rendering-not-enabled",
      note: "PDF page rendering is intentionally optional. Install a renderer and route pages through visual/Ollama classification before acceptance."
    }));
  const result = await upsertJsonlById(reviewOut, pdfs);
  state.pdf ??= { processedUrls: [] };
  state.pdf.processedUrls = [...new Set([...(state.pdf.processedUrls || []), ...pdfs.map((record) => record.pdfUrl).filter(Boolean)])];
  await writeCrawlState(state, statePath);
  console.log(`PDF candidates moved to review: ${pdfs.length}. ${reviewOut}: ${result.before} -> ${result.after}`);
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
