#!/usr/bin/env node
import { candidateImageId, getDomain } from "./lib/hash-utils.mjs";
import { readJsonl, upsertJsonlById } from "./lib/jsonl-store.mjs";

const args = parseArgs(process.argv.slice(2));

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

async function main() {
  const input = args.input ?? "data/candidate-images.jsonl";
  const reviewOut = args.review ?? "data/review-queue.jsonl";
  const maxPdfFiles = Number(args.maxPdfFiles ?? 20);
  const candidates = await readJsonl(input);
  const pdfs = candidates
    .filter((record) => record.pdfUrl || /\.pdf(?:$|[?#])/i.test(record.imageUrl || ""))
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
