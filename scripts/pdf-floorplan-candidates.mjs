#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
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
  const maxPdfBytes = Number(args.maxPdfBytes ?? 8000000);
  const renderPages = Number(args.renderPages ?? 0);
  const candidates = await readJsonl(input);
  const pdfLike = candidates
    .filter((record) => record.pdfUrl || /\.pdf(?:$|[?#])/i.test(record.imageUrl || ""))
    .filter((record) => !processed.has(record.pdfUrl || record.imageUrl))
    .slice(0, maxPdfFiles);
  const pdfs = [];
  for (const record of pdfLike) {
    const pdfUrl = record.pdfUrl || record.imageUrl;
    const verified = await verifyPdfUrl(pdfUrl, maxPdfBytes);
    if (!verified.ok) {
      processed.add(pdfUrl);
      continue;
    }
    const rendered = renderPages > 0 ? await renderPdfPages(pdfUrl, record, renderPages, maxPdfBytes) : [];
    pdfs.push({
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
      reason: rendered.length ? "pdf-pages-rendered-for-review" : "pdf-rendering-not-enabled",
      localRenderedPages: rendered,
      note: rendered.length
        ? "PDF pages were rendered locally for review. They are not accepted until visual/Ollama classification confirms a floorplan."
        : "PDF page rendering is optional. Route pages through visual/Ollama classification before acceptance."
    });
    processed.add(pdfUrl);
  }
  const result = await upsertJsonlById(reviewOut, pdfs);
  state.pdf ??= { processedUrls: [] };
  state.pdf.processedUrls = [...new Set([...(state.pdf.processedUrls || []), ...[...processed].filter(Boolean)])];
  await writeCrawlState(state, statePath);
  console.log(`PDF candidates moved to review: ${pdfs.length}. ${reviewOut}: ${result.before} -> ${result.after}`);
}

async function verifyPdfUrl(pdfUrl, maxPdfBytes) {
  if (!/^https?:\/\//i.test(pdfUrl || "")) return { ok: false, reason: "not-http" };
  if (/\.pdf(?:$|[?#])/i.test(pdfUrl)) return { ok: true };
  try {
    const response = await fetch(pdfUrl, { method: "HEAD", signal: AbortSignal.timeout(15000) });
    if (response.status === 403 || response.status === 429) return { ok: false, reason: `blocked ${response.status}` };
    if (!response.ok) return { ok: false, reason: `http ${response.status}` };
    const type = response.headers.get("content-type") || "";
    const length = Number(response.headers.get("content-length") || 0);
    if (length && length > maxPdfBytes) return { ok: false, reason: "too-large" };
    return { ok: /pdf/i.test(type), reason: type || "not-pdf" };
  } catch (error) {
    return { ok: false, reason: error.message || "head-failed" };
  }
}

async function renderPdfPages(pdfUrl, record, pageLimit, maxPdfBytes) {
  const pdftoppm = findPdfToPpm();
  if (!pdftoppm) return [];
  const id = candidateImageId({ imageUrl: pdfUrl, pageUrl: record.pageUrl }).slice(0, 16);
  const dir = path.join(".tmp", "pdf-pages", id);
  await mkdir(dir, { recursive: true });
  const pdfPath = path.join(dir, "source.pdf");
  try {
    const response = await fetch(pdfUrl, { signal: AbortSignal.timeout(20000) });
    if (!response.ok) return [];
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxPdfBytes) return [];
    await import("node:fs/promises").then((fs) => fs.writeFile(pdfPath, bytes));
  } catch {
    return [];
  }
  const prefix = path.join(dir, "page");
  const result = spawnSync(pdftoppm, ["-png", "-f", "1", "-l", String(Math.max(1, pageLimit)), "-r", "120", pdfPath, prefix], {
    encoding: "utf8",
    shell: false
  });
  if (result.status !== 0) return [];
  const fs = await import("node:fs/promises");
  try {
    const files = await fs.readdir(dir);
    return files.filter((file) => /^page-\d+\.png$/i.test(file)).map((file) => path.join(dir, file));
  } catch {
    return [];
  }
}

function findPdfToPpm() {
  const candidates = [
    process.env.PDFTOPPM,
    "pdftoppm",
    "C:\\Users\\fujis\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\bin\\pdftoppm.cmd"
  ].filter(Boolean);
  for (const command of candidates) {
    const result = spawnSync(command, ["-h"], { encoding: "utf8", shell: false });
    if (result.status === 0 || result.stderr || result.stdout) return command;
  }
  return "";
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
