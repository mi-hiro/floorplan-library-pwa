#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { readJsonl } from "./lib/jsonl-store.mjs";

const args = parseArgs(process.argv.slice(2));

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

async function main() {
  const input = args.input ?? "data/accepted-floorplans.jsonl";
  const out = args.out ?? "public/data/floorplans.json";
  const statsOut = args.statsOut ?? "public/data/floorplan-stats.json";
  const accepted = (await readJsonl(input)).filter((record) => record.status === "accepted");
  const now = new Date().toISOString();
  const candidates = accepted.map(toCrawlCandidate);
  const payload = {
    version: 2,
    generatedAt: now,
    source: "accepted-floorplans",
    candidates,
    logs: [
      {
        id: `accepted_public_${Date.now()}`,
        createdAt: now,
        siteName: "accepted-floorplans",
        domain: "-",
        url: input,
        action: "候補保存",
        result: "成功",
        message: `Accepted floorplans only: ${accepted.length} records.`
      }
    ]
  };
  const stats = buildStats(accepted, now);
  await mkdir(path.dirname(out), { recursive: true });
  await mkdir(path.dirname(statsOut), { recursive: true });
  await writeFile(out, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await writeFile(statsOut, `${JSON.stringify(stats, null, 2)}\n`, "utf8");
  console.log(`Built public floorplans: ${accepted.length} -> ${out}`);
}

function toCrawlCandidate(record) {
  return {
    id: record.id,
    title: record.title || "間取り図",
    listingSource: `accepted ${record.source?.sourceDomain || ""}`.trim(),
    sourceUrl: record.source?.pageUrl || "",
    company: record.source?.companyName || record.source?.sourceDomain || "",
    priceManYen: record.metadata?.price?.value || undefined,
    layout: record.metadata?.layout?.value || "",
    areaSqm: record.metadata?.totalFloorAreaSqm?.value || undefined,
    tsubo: record.metadata?.totalFloorAreaSqm?.value ? Number((record.metadata.totalFloorAreaSqm.value / 3.305785).toFixed(2)) : undefined,
    floors: record.metadata?.floors?.value || "",
    entranceDirection: record.metadata?.entranceDirection?.value || "",
    hasFloorplanImage: true,
    imageUrlCandidates: [record.source?.imageUrl].filter(Boolean),
    imageCandidates: [
      {
        id: `${record.id}:image`,
        kind: "floorplan",
        url: record.source?.imageUrl || "",
        alt: record.context?.alt || record.title || "間取り図",
        sourceUrl: record.source?.pageUrl || "",
        ollamaReview: {
          status: "checked",
          model: "accepted-pipeline",
          isFloorplan: true,
          confidence: record.classification?.finalConfidence ?? 0.85,
          reason: "accepted-floorplans only"
        }
      }
    ],
    fetchedAt: record.lastSeenAt || record.firstSeenAt,
    errorInfo: "",
    memo: "accepted-floorplans.jsonl から生成"
  };
}

function buildStats(records, generatedAt) {
  const byDomain = {};
  for (const record of records) {
    const domain = record.source?.sourceDomain || "unknown";
    byDomain[domain] ??= { acceptedCount: 0 };
    byDomain[domain].acceptedCount += 1;
  }
  return {
    generatedAt,
    acceptedCount: records.length,
    domains: byDomain
  };
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
