#!/usr/bin/env node
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { readJsonl } from "./lib/jsonl-store.mjs";

const args = parseArgs(process.argv.slice(2));

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

async function main() {
  const out = args.out ?? "data/source-stats.json";
  const candidates = await readJsonl(args.candidates ?? "data/candidate-images.jsonl");
  const accepted = await readJsonl(args.accepted ?? "data/accepted-floorplans.jsonl");
  const rejected = await readJsonl(args.rejected ?? "data/rejected-images.jsonl");
  const review = await readJsonl(args.review ?? "data/review-queue.jsonl");
  const stats = {};
  add(stats, candidates, "candidateCount");
  add(stats, accepted, "acceptedCount");
  add(stats, rejected, "rejectedCount");
  add(stats, review, "reviewCount");
  const existing = await readOptionalJson(out);
  const state = await readOptionalJson(args.state ?? "data/crawl-state.json");
  for (const [domain, value] of Object.entries(stats)) {
    const acceptedCount = value.acceptedCount || 0;
    const candidateCount = value.candidateCount || 0;
    value.acceptanceRate = candidateCount ? Number((acceptedCount / candidateCount).toFixed(3)) : 0;
    value.lastCrawledAt = state.domains?.[domain]?.lastCrawledAt || existing[domain]?.lastCrawledAt || null;
    value.blockReason = state.domains?.[domain]?.blockReason || null;
    value.nextCrawlAfter = state.domains?.[domain]?.nextCrawlAfter || null;
    value.sourceQuality = value.acceptanceRate >= 0.3 && acceptedCount >= 5 ? "high" : value.acceptanceRate >= 0.1 ? "medium" : "low";
  }
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(stats, null, 2)}\n`, "utf8");
  console.log(`Updated source stats: ${Object.keys(stats).length} domains`);
}

function add(stats, records, key) {
  for (const record of records) {
    const domain = record.source?.sourceDomain || record.sourceDomain || "unknown";
    stats[domain] ??= { candidateCount: 0, acceptedCount: 0, rejectedCount: 0, reviewCount: 0 };
    stats[domain][key] += 1;
  }
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
