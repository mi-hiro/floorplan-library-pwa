#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";

const config = readConfig();

if (existsSync("crawler-output/latest-crawl.json")) {
  run("scripts/import-latest-crawl-candidates.mjs", ["--input", "crawler-output/latest-crawl.json", "--out", "data/candidate-images.jsonl"]);
}
run("scripts/sitemap-floorplan-candidates.mjs", [
  "--config",
  "floorplan-growth.config.json",
  "--mode",
  "daily",
  "--prefer-high-quality",
  "--out",
  "data/candidate-images.jsonl",
  "--max-domains",
  String(config.daily?.maxDomainsPerRun ?? 10),
  "--max-pages-per-domain",
  String(config.daily?.maxPagesPerDomain ?? 5)
]);
run("scripts/wordpress-rest-candidates.mjs", [
  "--config",
  "floorplan-growth.config.json",
  "--mode",
  "daily",
  "--prefer-high-quality",
  "--out",
  "data/candidate-images.jsonl",
  "--max-domains",
  String(config.daily?.maxDomainsPerRun ?? 10),
  "--max-per-domain",
  String(config.daily?.maxPagesPerDomain ?? 5)
]);
run("scripts/pdf-floorplan-candidates.mjs", ["--input", "data/candidate-images.jsonl", "--review", "data/review-queue.jsonl", "--max-pdf-files", String(config.daily?.maxPdfFiles ?? 5)]);
run("scripts/domain-adapter-candidates.mjs", ["--out", "data/candidate-images.jsonl", "--max-pages", "10"]);
run("scripts/promote-floorplan-candidates.mjs", ["--config", "floorplan-growth.config.json", "--max-images", String(Math.min(100, config.ollama?.maxImages ?? 100))]);
run("scripts/clean-accepted-floorplans.mjs", []);
run("scripts/update-source-stats.mjs", []);
run("scripts/build-public-floorplans.mjs", []);
syncLatestCrawl();

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

function syncLatestCrawl() {
  if (!existsSync("public/data/floorplans.json")) return;
  mkdirSync("crawler-output", { recursive: true });
  copyFileSync("public/data/floorplans.json", "crawler-output/latest-crawl.json");
}
