import { normalizeWhitespace } from "./hash-utils.mjs";

export function extractImageCandidatesFromHtml(html, pageUrl, options = {}) {
  const candidates = [];
  const seen = new Set();
  const title = extractTitle(html);
  const add = (rawUrl, attrs = {}, rawMatch = "") => {
    const imageUrl = normalizePossiblyRelativeUrl(rawUrl, pageUrl);
    if (!imageUrl || seen.has(imageUrl)) return;
    seen.add(imageUrl);
    const nearImageText = normalizeWhitespace(
      [attrs.nearImageText, attrs.caption, attrs.alt, textAround(html, rawMatch), title].filter(Boolean).join(" ")
    );
    candidates.push({
      sourceType: options.sourceType || "html",
      pageUrl,
      imageUrl,
      pageTitle: title,
      alt: normalizeWhitespace(attrs.alt || ""),
      caption: normalizeWhitespace(attrs.caption || ""),
      nearImageText,
      discoveredFrom: attrs.discoveredFrom || "html"
    });
  };

  for (const match of html.matchAll(/<img\b([^>]+)>/gi)) {
    const attrs = parseAttrs(match[1]);
    const context = imageContext(html, match.index ?? 0, match[0]);
    for (const key of ["src", "data-src", "data-original", "data-lazy-src", "data-srcset", "data-large_image", "data-bg", "data-background-image"]) {
      if (attrs[key]) add(firstSrc(attrs[key]), { alt: attrs.alt, caption: context.caption, nearImageText: context.text, discoveredFrom: key }, match[0]);
    }
    if (attrs.srcset) {
      for (const src of parseSrcset(attrs.srcset)) add(src, { alt: attrs.alt, caption: context.caption, nearImageText: context.text, discoveredFrom: "srcset" }, match[0]);
    }
  }

  for (const match of html.matchAll(/<source\b([^>]+)>/gi)) {
    const attrs = parseAttrs(match[1]);
    const context = imageContext(html, match.index ?? 0, match[0]);
    for (const src of parseSrcset(attrs.srcset || attrs["data-srcset"] || "")) add(src, { caption: context.caption, nearImageText: context.text, discoveredFrom: "picture-source" }, match[0]);
  }

  for (const match of html.matchAll(/url\((['"]?)([^)'"]+)\1\)/gi)) {
    add(match[2], { nearImageText: textAround(html, match[0]), discoveredFrom: "css-background" }, match[0]);
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

function imageContext(html, index, rawMatch) {
  const figure = enclosingBlock(html, index, "figure");
  const card =
    figure ||
    enclosingBlock(html, index, "article") ||
    enclosingBlock(html, index, "li") ||
    enclosingBlock(html, index, "section") ||
    enclosingBlock(html, index, "div");
  const caption = normalizeWhitespace((figure || "").match(/<figcaption[^>]*>([\s\S]*?)<\/figcaption>/i)?.[1] || "");
  return {
    caption: stripTags(caption),
    text: normalizeWhitespace(stripTags(card || textAround(html, rawMatch)))
  };
}

function textAround(html, rawMatch) {
  const index = rawMatch ? html.indexOf(rawMatch) : -1;
  const start = Math.max(0, index < 0 ? 0 : index - 1200);
  const end = Math.min(html.length, index < 0 ? 1800 : index + rawMatch.length + 1200);
  return stripTags(html.slice(start, end));
}

function enclosingBlock(html, index, tagName) {
  const before = html.slice(0, index);
  const openPattern = new RegExp(`<${tagName}\\b[^>]*>`, "gi");
  let open = null;
  for (const match of before.matchAll(openPattern)) open = match;
  if (!open) return "";
  const openIndex = open.index ?? -1;
  const closePattern = new RegExp(`</${tagName}>`, "i");
  const close = html.slice(index).match(closePattern);
  if (!close || close.index == null) return "";
  const closeIndex = index + close.index + close[0].length;
  if (closeIndex - openIndex > 8000) return "";
  return html.slice(openIndex, closeIndex);
}
