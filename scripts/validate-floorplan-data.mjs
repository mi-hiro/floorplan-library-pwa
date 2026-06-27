#!/usr/bin/env node
import { readJsonl } from "./lib/jsonl-store.mjs";
import { classifyImageCandidate } from "./lib/image-features.mjs";

const args = parseArgs(process.argv.slice(2));

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

async function main() {
  const sampleSize = Number(args.sample ?? 100);
  const accepted = (await readJsonl(args.accepted ?? "data/accepted-floorplans.jsonl")).filter((record) => record.status === "accepted");
  const sample = randomSample(accepted, sampleSize);
  const problems = [];
  for (const record of accepted) {
    const confidence = Number(record.classification?.finalConfidence ?? 0);
    if (record.classification?.finalCategory !== "floorplan") problems.push({ id: record.id, reason: "final category is not floorplan" });
    const visual = classifyImageCandidate({
      imageUrl: record.source?.imageUrl,
      pageUrl: record.source?.pageUrl,
      alt: record.context?.alt,
      title: record.title,
      nearImageText: record.context?.nearImageText
    });
    if (confidence < 0.85) problems.push({ id: record.id, reason: `confidence ${confidence} < 0.85` });
    if (visual.hardRejectSignals.length) problems.push({ id: record.id, reason: "hard reject signal", signals: visual.hardRejectSignals });
    if (record.status !== "accepted") problems.push({ id: record.id, reason: "status is not accepted" });
  }
  for (const record of sample) {
    if (!record.source?.imageUrl) problems.push({ id: record.id, reason: "missing image URL" });
    if (!record.source?.pageUrl) problems.push({ id: record.id, reason: "missing source page URL" });
  }
  const summary = {
    acceptedCount: accepted.length,
    sampled: sample.length,
    problemCount: problems.length,
    estimatedPrecisionGoal: "90/100 accepted sample should be real floorplans",
    problems: problems.slice(0, 20)
  };
  console.log(JSON.stringify(summary, null, 2));
  if (problems.length) process.exit(1);
}

function randomSample(items, size) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, size);
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
