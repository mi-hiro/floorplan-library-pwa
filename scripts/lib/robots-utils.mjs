export async function fetchRobotsRules(domain, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const url = `https://${domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "")}/robots.txt`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) return { status: "error", rules: [], url };
    const text = await response.text();
    return { status: "allowed", rules: parseRobots(text), sitemaps: extractSitemapUrls(text), url };
  } catch (error) {
    return { status: "error", rules: [], url, reason: error.message };
  } finally {
    clearTimeout(timeout);
  }
}

export function isAllowedByRobots(targetUrl, robotsRules) {
  const path = safePath(targetUrl);
  let matched = null;
  for (const rule of robotsRules || []) {
    if (!robotsPathMatches(path, rule.path)) continue;
    if (!matched || robotsSpecificity(rule.path) > robotsSpecificity(matched.path)) matched = rule;
  }
  return !matched || matched.type !== "disallow";
}

export function extractSitemapUrls(text) {
  const urls = [];
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, "").trim();
    if (!line) continue;
    const [rawKey, ...rest] = line.split(":");
    if (rawKey.trim().toLowerCase() !== "sitemap") continue;
    const value = rest.join(":").trim();
    if (/^https?:\/\//i.test(value)) urls.push(value);
  }
  return [...new Set(urls)];
}

function parseRobots(text) {
  const rules = [];
  let applies = false;
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, "").trim();
    if (!line) continue;
    const [rawKey, ...rest] = line.split(":");
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(":").trim();
    if (key === "user-agent") applies = value === "*";
    if (applies && (key === "allow" || key === "disallow") && value) rules.push({ type: key, path: normalizeRobotsPath(value) });
  }
  return rules;
}

function safePath(value) {
  try {
    return new URL(value).pathname || "/";
  } catch {
    return "/";
  }
}

function normalizeRobotsPath(value) {
  return String(value || "").trim() || "/";
}

function robotsPathMatches(path, pattern) {
  const value = String(pattern || "");
  if (value === "/") return true;
  const anchoredEnd = value.endsWith("$");
  const source = value
    .replace(/\$$/, "")
    .split("*")
    .map(escapeRegex)
    .join(".*");
  const regex = new RegExp(`^${source}${anchoredEnd ? "$" : ""}`);
  return regex.test(path);
}

function robotsSpecificity(pattern) {
  return String(pattern || "").replace(/[*$]/g, "").length;
}

function escapeRegex(value) {
  return String(value).replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}
