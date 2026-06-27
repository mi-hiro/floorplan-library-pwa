#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const config = readConfig();

if (existsSync("scripts/common-crawl-candidates.mjs") && existsSync("common-crawl.config.json")) {
  run("scripts/common-crawl-candidates.mjs", [
    "--config",
    "common-crawl.config.json",
    "--out",
    "crawler-output/latest-crawl.json",
    "--merge-existing",
    "--target-count",
    String(config.backfill?.targetCandidateCount ?? 5000),
    "--per-query",
    "80",
    "--max-queries",
    "40",
      "--max-archived-pages",
      String(config.backfill?.maxArchivedPages ?? 300),
      "--max-indexes",
      String(config.backfill?.maxCommonCrawlIndexes ?? 4),
      "--fetch-archived-pages",
      "true",
      "--loose-image-candidates",
      "true"
  ]);
}
run("scripts/import-latest-crawl-candidates.mjs", ["--input", existingLatestCrawl(), "--out", "data/candidate-images.jsonl"]);
run("scripts/sitemap-floorplan-candidates.mjs", [
  "--config",
  "floorplan-growth.config.json",
  "--mode",
  "backfill",
  "--out",
  "data/candidate-images.jsonl",
  "--max-pages-per-domain",
  String(config.backfill?.maxPagesPerDomain ?? 50)
]);
run("scripts/wordpress-rest-candidates.mjs", [
  "--config",
  "floorplan-growth.config.json",
  "--mode",
  "backfill",
  "--out",
  "data/candidate-images.jsonl",
  "--max-per-domain",
  String(Math.min(30, config.backfill?.maxPagesPerDomain ?? 30))
]);
run("scripts/pdf-floorplan-candidates.mjs", ["--input", "data/candidate-images.jsonl", "--review", "data/review-queue.jsonl", "--max-pdf-files", String(config.backfill?.maxPdfFiles ?? 100)]);
run("scripts/domain-adapter-candidates.mjs", ["--out", "data/candidate-images.jsonl"]);
run("scripts/promote-floorplan-candidates.mjs", ["--config", "floorplan-growth.config.json", "--max-images", String(config.ollama?.maxImages ?? 1000)]);
run("scripts/update-source-stats.mjs", []);
run("scripts/build-public-floorplans.mjs", []);

function existingLatestCrawl() {
  if (existsSync("crawler-output/latest-crawl.json")) return "crawler-output/latest-crawl.json";
  if (existsSync("public/data/floorplans.json")) return "public/data/floorplans.json";
  return "crawler-output/latest-crawl.json";
}

function run(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], { stdio: "inherit", shell: false });
  if (result.status !== 0) process.exit(result.status || 1);
}

function readConfig() {
  try {
    return JSON.parse(readFileSync("floorplan-growth.config.json", "utf8"));
  } catch {
    return {};
  }
}
