import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_CRAWL_STATE = {
  schemaVersion: 1,
  domains: {},
  commonCrawl: {
    processedIndexes: []
  },
  pdf: {
    processedUrls: []
  },
  updatedAt: null
};

export async function readCrawlState(filePath = "data/crawl-state.json") {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    return {
      ...DEFAULT_CRAWL_STATE,
      ...parsed,
      domains: parsed.domains || {},
      commonCrawl: { ...DEFAULT_CRAWL_STATE.commonCrawl, ...(parsed.commonCrawl || {}) },
      pdf: { ...DEFAULT_CRAWL_STATE.pdf, ...(parsed.pdf || {}) }
    };
  } catch {
    return structuredClone(DEFAULT_CRAWL_STATE);
  }
}

export async function writeCrawlState(state, filePath = "data/crawl-state.json") {
  const next = {
    ...DEFAULT_CRAWL_STATE,
    ...state,
    domains: state.domains || {},
    updatedAt: new Date().toISOString()
  };
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

export function getDomainState(state, domain) {
  return state.domains?.[domain] || {};
}

export function mergeDomainState(state, domain, patch) {
  state.domains ??= {};
  const current = state.domains[domain] || {};
  state.domains[domain] = {
    ...current,
    ...patch,
    failures: patch.failures ?? current.failures ?? 0
  };
  return state.domains[domain];
}

export function markDomainSuccess(state, domain, patch = {}) {
  return mergeDomainState(state, domain, {
    ...patch,
    lastCrawledAt: new Date().toISOString(),
    lastStatus: "ok",
    failures: 0,
    blockReason: null,
    nextCrawlAfter: patch.nextCrawlAfter || null
  });
}

export function markDomainStopped(state, domain, reason, { hours = 24, status = "stopped" } = {}) {
  const current = getDomainState(state, domain);
  const next = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  return mergeDomainState(state, domain, {
    lastCrawledAt: new Date().toISOString(),
    lastStatus: status,
    blockReason: reason,
    failures: Number(current.failures || 0) + 1,
    nextCrawlAfter: next
  });
}

export function canCrawlDomain(state, domain, now = new Date()) {
  const nextCrawlAfter = getDomainState(state, domain).nextCrawlAfter;
  if (!nextCrawlAfter) return true;
  return new Date(nextCrawlAfter).getTime() <= now.getTime();
}
