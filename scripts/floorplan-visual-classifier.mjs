#!/usr/bin/env node
import { classifyImageCandidate } from "./lib/image-features.mjs";
import { readJsonl, writeJsonl } from "./lib/jsonl-store.mjs";

const args = parseArgs(process.argv.slice(2));

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

async function main() {
  const input = args.input ?? "data/candidate-images.jsonl";
  const out = args.out ?? input;
  const records = await readJsonl(input);
  const enriched = records.map((record) => ({
    ...record,
    visualClassification: classifyImageCandidate(record)
  }));
  await writeJsonl(out, enriched);
  console.log(`Visual-classified candidates: ${records.length}`);
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
