#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const args = parseArgs(process.argv.slice(2));

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

async function main() {
  const batchPath = args.batch ?? path.join(".tmp", "prefecture-auto-batch.json");
  const baseConfigPath = args.baseConfig ?? "source-discovery.config.json";
  const outPath = args.out ?? path.join(".tmp", "prefecture-source-discovery.config.json");
  const batch = await readJson(batchPath);
  const base = await readOptionalJson(baseConfigPath);
  const maxQueries = Number(args.maxQueries ?? 40);
  const prefectures = batch.selectedPrefectures ?? [];
  const batchQueries = (batch.queries ?? []).map((item) => item.query).filter(Boolean);
  const extraQueries = prefectures.flatMap((prefecture) => [
    `${prefecture} 工務店 プラン集 間取り`,
    `${prefecture} 住宅会社 平屋プラン 間取り`,
    `${prefecture} 新築 3LDK 間取り 工務店`,
    `${prefecture} 注文住宅 建築実例 平面図`
  ]);
  const queries = dedupeStrings([...batchQueries, ...extraQueries]).slice(0, Math.max(1, maxQueries));

  const result = {
    ...base,
    duckduckgo: {
      ...(base.duckduckgo ?? {}),
      enabled: true,
      maxResultsPerQuery: Number(args.maxResultsPerQuery ?? base.duckduckgo?.maxResultsPerQuery ?? 20),
      queries
    }
  };

  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(`Prefecture source config written: ${queries.length} queries`);
  console.log(`Output: ${outPath}`);
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

function dedupeStrings(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = normalizeWhitespace(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeWhitespace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
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
