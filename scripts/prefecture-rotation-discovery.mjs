#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const args = parseArgs(process.argv.slice(2));

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

async function main() {
  const configPath = args.config ?? "prefecture-discovery.config.json";
  const statePath = args.state ?? path.join("crawler-output", "prefecture-discovery-state.json");
  const outPath = args.out ?? path.join(".tmp", "prefecture-search-batch.json");
  const textOutPath = args.textOut ?? path.join(".tmp", "prefecture-search-queries.txt");
  const config = await readJson(configPath);
  const state = await readOptionalJson(statePath);
  const batchSize = Number(args.batchSize ?? config.batchSize ?? 3);
  const queriesPerPrefecture = Number(args.queriesPerPrefecture ?? config.queriesPerPrefecture ?? 4);
  const advance = parseBool(args.advance, false);
  const prefectures = config.prefectures ?? [];
  const queryTemplates = config.queryTemplates ?? [];

  if (!prefectures.length) throw new Error("prefectures is empty.");
  if (!queryTemplates.length) throw new Error("queryTemplates is empty.");

  const startIndex = normalizeIndex(Number(state.nextIndex ?? 0), prefectures.length);
  const selectedPrefectures = [];
  for (let i = 0; i < Math.min(batchSize, prefectures.length); i += 1) {
    selectedPrefectures.push(prefectures[(startIndex + i) % prefectures.length]);
  }

  const queries = selectedPrefectures.flatMap((prefecture) =>
    queryTemplates.slice(0, queriesPerPrefecture).map((template) => ({
      prefecture,
      query: String(template).replaceAll("{prefecture}", prefecture)
    }))
  );

  const nextIndex = normalizeIndex(startIndex + selectedPrefectures.length, prefectures.length);
  const completedRounds = Number(state.completedRounds ?? 0) + (advance && startIndex + selectedPrefectures.length >= prefectures.length ? 1 : 0);
  const runs = advance
    ? [
        ...(state.runs ?? []),
        {
          createdAt: new Date().toISOString(),
          prefectures: selectedPrefectures,
          queryCount: queries.length,
          startIndex,
          nextIndex
        }
      ].slice(-120)
    : (state.runs ?? []);

  const nextState = {
    version: 1,
    updatedAt: new Date().toISOString(),
    nextIndex: advance ? nextIndex : startIndex,
    completedRounds,
    pendingPrefectures: advance ? [] : selectedPrefectures,
    pendingQueries: advance ? [] : queries,
    lastPreparedAt: new Date().toISOString(),
    lastPrefectures: selectedPrefectures,
    lastQueries: queries,
    totals: {
      prefectures: prefectures.length,
      runs: runs.length
    },
    runs
  };

  const batch = {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: "prefecture-rotation",
    selectedPrefectures,
    queries,
    nextIndex,
    completedRounds
  };

  await writeJson(outPath, batch);
  await writeJson(statePath, nextState);
  await writeText(textOutPath, queries.map((item) => item.query).join("\n") + "\n");

  console.log(`Prefecture rotation ${advance ? "advanced" : "prepared"}: ${selectedPrefectures.join(", ")}`);
  console.log(`Queries: ${queries.length}`);
  console.log(`Next index: ${advance ? nextIndex : startIndex} / ${prefectures.length}`);
  console.log(`Batch: ${outPath}`);
  console.log(`Query list: ${textOutPath}`);
  console.log(`State: ${statePath}`);
}

function normalizeIndex(index, length) {
  if (!Number.isFinite(index) || index < 0) return 0;
  return index % length;
}

function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return !/^(false|0|no|off)$/i.test(String(value));
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function readOptionalJson(filePath) {
  try {
    return await readJson(filePath);
  } catch {
    return {};
  }
}

async function writeJson(filePath, payload) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function writeText(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, value, "utf8");
}

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      result[key] = true;
    } else {
      result[key] = next;
      i += 1;
    }
  }
  return result;
}
