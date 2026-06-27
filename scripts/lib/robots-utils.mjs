export async function fetchRobotsRules(domain, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const url = `https://${domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "")}/robots.txt`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) return { status: "error", rules: [], url };
    return { status: "allowed", rules: parseRobots(await response.text()), url };
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
    if (!path.startsWith(rule.path)) continue;
    if (!matched || rule.path.length > matched.path.length) matched = rule;
  }
  return !matched || matched.type !== "disallow";
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
    if (applies && (key === "allow" || key === "disallow") && value) rules.push({ type: key, path: value });
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
