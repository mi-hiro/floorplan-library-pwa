#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { candidateImageId, getDomain, normalizeWhitespace } from "./lib/hash-utils.mjs";
import { extractImageCandidatesFromHtml } from "./lib/html-image-extractor.mjs";
import { extractMetadata, sourceSnippet } from "./lib/metadata-extractor.mjs";
import { upsertJsonlById } from "./lib/jsonl-store.mjs";
import { canCrawlDomain, markDomainStopped, markDomainSuccess, readCrawlState, writeCrawlState } from "./lib/crawl-state-store.mjs";
import { fetchRobotsRules, isAllowedByRobots } from "./lib/robots-utils.mjs";

const args = parseArgs(process.argv.slice(2));

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

async function main() {
  const adapters = await readOptionalJson(args.adapters ?? "data/source-adapters.json");
  const out = args.out ?? "data/candidate-images.jsonl";
  const statePath = args.state ?? "data/crawl-state.json";
  const state = await readCrawlState(statePath);
  const maxPages = Number(args.maxPages ?? 20);
  const records = [];
  for (const [domain, adapter] of Object.entries(adapters)) {
    if (!adapter.enabled) continue;
    if (!canCrawlDomain(state, domain)) continue;
    const robots = await fetchRobotsRules(domain);
    const pageUrls = (adapter.seedUrls || []).slice(0, maxPages);
    try {
      for (const pageUrl of pageUrls) {
        if (!isAllowedByRobots(pageUrl, robots.rules)) continue;
        let html = "";
        const response = await fetch(pageUrl);
        if (response.status === 403 || response.status === 429) throw new Error(`blocked with HTTP ${response.status}`);
        if (!response.ok) continue;
        html = await response.text();
        if (/captcha|recaptcha|hcaptcha|ロボットではありません/i.test(html.slice(0, 20000))) throw new Error("captcha detected");
        for (const image of extractImageCandidatesFromHtml(html, pageUrl, { sourceType: "adapter" })) {
          const text = normalizeWhitespace(`${image.nearImageText} ${adapter.contextSelectors?.join(" ") || ""}`);
          records.push({
            ...image,
            id: candidateImageId(image),
            status: "candidate",
            firstSeenAt: new Date().toISOString(),
            lastSeenAt: new Date().toISOString(),
            sourceType: "adapter",
            sourceDomain: getDomain(pageUrl) || domain,
            companyName: adapter.companyName || domain,
            discoveredFrom: "domain-adapter",
            title: image.alt || image.pageTitle || `${domain} adapter candidate`,
            nearImageText: text,
            sourceSnippet: sourceSnippet(text),
            metadata: extractMetadata({ title: image.pageTitle, nearImageText: text, alt: image.alt })
          });
        }
      }
      markDomainSuccess(state, domain);
    } catch (error) {
      markDomainStopped(state, domain, error.message || "adapter failed", { hours: /403|429|captcha/i.test(error.message || "") ? 72 : 24 });
    }
  }
  const result = await upsertJsonlById(out, records);
  await writeCrawlState(state, statePath);
  console.log(`Domain adapter candidates: ${records.length}. ${out}: ${result.before} -> ${result.after}`);
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
