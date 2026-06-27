import { normalizeWhitespace } from "./hash-utils.mjs";

export function extractMetadata({ title = "", nearImageText = "", pageText = "", alt = "" } = {}) {
  const sources = [
    { name: "near-image-text", text: `${alt} ${nearImageText}`, confidence: 0.92 },
    { name: "same-card-text", text: nearImageText, confidence: 0.82 },
    { name: "page-title", text: title, confidence: 0.58 },
    { name: "page-text", text: pageText.slice(0, 6000), confidence: 0.4 }
  ];
  return {
    layout: pickMatch(sources, /\b([1-7]S?LDK|[1-7]DK|[1-7]K)\b|平屋/i, normalizeLayout),
    totalFloorAreaSqm: pickArea(sources, /(延床|建物|施工|床面積|面積).{0,20}?([0-9]+(?:\.[0-9]+)?)\s*(㎡|m²|m2|坪)/i),
    siteAreaSqm: pickArea(sources, /(土地|敷地).{0,20}?([0-9]+(?:\.[0-9]+)?)\s*(㎡|m²|m2|坪)/i),
    floors: pickMatch(sources, /(平屋|1階建て|一階建て|2階建て|二階建て|3階建て|三階建て)/i, normalizeFloors),
    entranceDirection: pickMatch(
      sources,
      /玄関.{0,10}?(南東|南西|北東|北西|東|西|南|北)|(南東|南西|北東|北西|東|西|南|北)向き/,
      (match) => match[1] || match[2] || ""
    ),
    price: pickPrice(sources)
  };
}

export function sourceSnippet(value, maxLength = 500) {
  return normalizeWhitespace(value).slice(0, maxLength);
}

function pickMatch(sources, pattern, mapper = (match) => match[1] || match[0]) {
  for (const source of sources) {
    const match = normalizeWhitespace(source.text).match(pattern);
    const value = match ? mapper(match) : "";
    if (value) return { value, confidence: source.confidence, source: source.name };
  }
  return { value: null, confidence: 0, source: null };
}

function pickArea(sources, pattern) {
  for (const source of sources) {
    const match = normalizeWhitespace(source.text).match(pattern);
    if (!match) continue;
    const rawValue = Number(match[2]);
    if (!Number.isFinite(rawValue)) continue;
    const unit = match[3];
    const value = /坪/i.test(unit) ? Number((rawValue * 3.305785).toFixed(2)) : rawValue;
    return { value, confidence: source.confidence, source: source.name };
  }
  return { value: null, confidence: 0, source: null };
}

function pickPrice(sources) {
  for (const source of sources) {
    const text = normalizeWhitespace(source.text);
    const match = text.match(/([0-9]{3,5})\s*万円|価格.{0,20}?([0-9,]+)/);
    if (!match) continue;
    const value = Number(String(match[1] || match[2]).replace(/,/g, ""));
    if (Number.isFinite(value)) return { value, currency: "JPY", confidence: source.confidence, source: source.name };
  }
  return { value: null, currency: "JPY", confidence: 0, source: null };
}

function normalizeLayout(match) {
  const value = match[1] || match[0];
  return /平屋/.test(value) ? "" : value.toUpperCase().replace(/\s+/g, "");
}

function normalizeFloors(match) {
  const value = match[1] || match[0];
  if (/平屋|1階|一階/.test(value)) return "平屋";
  if (/2階|二階/.test(value)) return "2階建て";
  if (/3階|三階/.test(value)) return "3階建て";
  return value;
}
