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
  const delayMs = Number(args.delayMs ?? 3000);
  const requestedDomains = new Set(parseDomains(args.domains));
  const candidatePageSeeds = await readCandidatePageSeeds(args.seedCandidates ?? out, adapters);
  const records = [];
  for (const [domain, adapter] of Object.entries(adapters)) {
    if (!adapter.enabled) continue;
    const domainKey = normalizeDomain(domain);
    if (requestedDomains.size && !requestedDomains.has(domainKey)) continue;
    if (!canCrawlDomain(state, domain)) continue;
    const robots = await fetchRobotsRules(domain);
    const pageUrls = unique([...(adapter.seedUrls || []), ...(candidatePageSeeds.get(domainKey) || [])]).slice(0, maxPages);
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
          if (!passesAdapterPatterns(image, adapter)) continue;
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
        if (delayMs > 0) await sleep(delayMs);
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

function passesAdapterPatterns(image, adapter) {
  const signal = [image.imageUrl, image.alt, image.caption, image.nearImageText, image.pageTitle].filter(Boolean).join(" ");
  if (matchesAny(signal, adapter.rejectUrlPatterns || adapter.rejectPatterns || [])) return false;
  const acceptPatterns = adapter.acceptUrlPatterns || adapter.acceptPatterns || [];
  if (!acceptPatterns.length) return true;
  return matchesAny(signal, acceptPatterns);
}

function matchesAny(value, patterns) {
  return patterns.some((pattern) => {
    try {
      return new RegExp(pattern, "i").test(value);
    } catch {
      return String(value).toLowerCase().includes(String(pattern).toLowerCase());
    }
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readOptionalJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return {};
  }
}

async function readCandidatePageSeeds(filePath, adapters) {
  if (!filePath || String(filePath).toLowerCase() === "false") return new Map();
  const result = new Map();
  try {
    const lines = (await readFile(filePath, "utf8")).split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      let record = null;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const pageUrl = record?.pageUrl;
      if (!pageUrl) continue;
      const domain = normalizeDomain(getDomain(pageUrl));
      const adapter = adapters[domain];
      if (!adapter) continue;
      if (adapter.pagePatterns?.length && !matchesAny(pageUrl, adapter.pagePatterns)) continue;
      result.set(domain, [...(result.get(domain) || []), pageUrl]);
    }
  } catch {
    return result;
  }
  for (const [domain, urls] of result) result.set(domain, unique(urls));
  return result;
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

function parseDomains(value) {
  return String(value || "")
    .split(",")
    .map((item) => normalizeDomain(item.trim()))
    .filter(Boolean);
}

function normalizeDomain(value) {
  return String(value || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "").toLowerCase();
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}
