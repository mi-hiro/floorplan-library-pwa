import { normalizeWhitespace } from "./hash-utils.mjs";

export function extractImageCandidatesFromHtml(html, pageUrl, options = {}) {
  const candidates = [];
  const seen = new Set();
  const title = extractTitle(html);
  const add = (rawUrl, attrs = {}) => {
    const imageUrl = normalizePossiblyRelativeUrl(rawUrl, pageUrl);
    if (!imageUrl || seen.has(imageUrl)) return;
    seen.add(imageUrl);
    candidates.push({
      sourceType: options.sourceType || "html",
      pageUrl,
      imageUrl,
      pageTitle: title,
      alt: normalizeWhitespace(attrs.alt || ""),
      caption: normalizeWhitespace(attrs.caption || ""),
      nearImageText: normalizeWhitespace(attrs.nearImageText || title),
      discoveredFrom: attrs.discoveredFrom || "html"
    });
  };

  for (const match of html.matchAll(/<img\b([^>]+)>/gi)) {
    const attrs = parseAttrs(match[1]);
    for (const key of ["src", "data-src", "data-original", "data-lazy-src", "data-srcset"]) {
      if (attrs[key]) add(firstSrc(attrs[key]), { alt: attrs.alt, discoveredFrom: key });
    }
    if (attrs.srcset) {
      for (const src of parseSrcset(attrs.srcset)) add(src, { alt: attrs.alt, discoveredFrom: "srcset" });
    }
  }

  for (const match of html.matchAll(/<source\b([^>]+)>/gi)) {
    const attrs = parseAttrs(match[1]);
    for (const src of parseSrcset(attrs.srcset || attrs["data-srcset"] || "")) add(src, { discoveredFrom: "picture-source" });
  }

  for (const match of html.matchAll(/url\((['"]?)([^)'"]+)\1\)/gi)) {
    add(match[2], { discoveredFrom: "css-background" });
  }

  return candidates;
}

export function extractPdfLinksFromHtml(html, pageUrl) {
  const links = [];
  for (const match of html.matchAll(/<a\b([^>]+)>([\s\S]*?)<\/a>/gi)) {
    const attrs = parseAttrs(match[1]);
    const href = normalizePossiblyRelativeUrl(attrs.href, pageUrl);
    const label = normalizeWhitespace(stripTags(match[2]));
    if (!href || !/\.pdf(?:$|[?#])|間取り|madori|plan|floorplan|catalog|catalogue|カタログ|プラン|商品|lineup/i.test(`${href} ${label}`)) continue;
    links.push({ pageUrl, pdfUrl: href, label });
  }
  return links;
}

function parseAttrs(value) {
  const attrs = {};
  for (const match of String(value || "").matchAll(/([:@\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attrs;
}

function parseSrcset(value) {
  return String(value || "")
    .split(",")
    .map((part) => firstSrc(part.trim()))
    .filter(Boolean);
}

function firstSrc(value) {
  return String(value || "").trim().split(/\s+/)[0];
}

function normalizePossiblyRelativeUrl(rawUrl, pageUrl) {
  if (!rawUrl || /^(data:|javascript:|#)/i.test(rawUrl)) return "";
  try {
    return new URL(rawUrl, pageUrl).toString();
  } catch {
    return "";
  }
}

function extractTitle(html) {
  return normalizeWhitespace(stripTags(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || ""));
}

function stripTags(value) {
  return String(value || "").replace(/<[^>]+>/g, " ");
}
