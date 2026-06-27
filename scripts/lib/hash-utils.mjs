import crypto from "node:crypto";

export function sha256Text(value) {
  return crypto.createHash("sha256").update(String(value ?? "")).digest("hex");
}

export function stableId(parts) {
  return sha256Text(Array.isArray(parts) ? parts.filter(Boolean).join("|") : parts);
}

export function normalizeUrl(value) {
  if (!value) return "";
  try {
    const parsed = new URL(String(value));
    parsed.hash = "";
    const removableParams = [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "fbclid",
      "gclid",
      "yclid"
    ];
    for (const key of removableParams) parsed.searchParams.delete(key);
    return decodeURIComponent(parsed.toString()).replace(/\/$/, "").toLowerCase();
  } catch {
    return String(value).trim().toLowerCase();
  }
}

export function candidateImageId(candidate) {
  return stableId([
    normalizeUrl(candidate.imageUrl || candidate.url),
    normalizeUrl(candidate.pageUrl || candidate.sourceUrl),
    candidate.pdfUrl || "",
    candidate.pdfPageNumber ?? ""
  ]);
}

export function weakDhashSource(candidate) {
  return sha256Text(
    [
      normalizeUrl(candidate.imageUrl || candidate.url),
      normalizeUrl(candidate.thumbnailUrl || ""),
      normalizeWhitespace(candidate.alt || ""),
      normalizeWhitespace(candidate.title || "")
    ].join("|")
  ).slice(0, 16);
}

export function normalizeWhitespace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function getDomain(value) {
  try {
    return new URL(value).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

export function pickBetterValue(current, incoming) {
  if (current == null || current === "") return incoming;
  if (incoming == null || incoming === "") return current;
  if (typeof current === "object" && typeof incoming === "object") {
    const currentConfidence = Number(current.confidence ?? 0);
    const incomingConfidence = Number(incoming.confidence ?? 0);
    return incomingConfidence > currentConfidence ? incoming : current;
  }
  return current;
}
