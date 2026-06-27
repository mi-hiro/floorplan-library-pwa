#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

if (existsSync("crawler-output/latest-crawl.json")) {
  run("scripts/import-latest-crawl-candidates.mjs", ["--input", "crawler-output/latest-crawl.json", "--out", "data/candidate-images.jsonl"]);
}
run("scripts/wordpress-rest-candidates.mjs", ["--config", "floorplan-growth.config.json", "--out", "data/candidate-images.jsonl", "--max-per-domain", "10"]);
run("scripts/domain-adapter-candidates.mjs", ["--out", "data/candidate-images.jsonl", "--max-pages", "10"]);
run("scripts/promote-floorplan-candidates.mjs", ["--config", "floorplan-growth.config.json"]);
run("scripts/update-source-stats.mjs", []);
run("scripts/build-public-floorplans.mjs", []);

function run(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], { stdio: "inherit", shell: false });
  if (result.status !== 0) process.exit(result.status || 1);
}
