import { getDomain, normalizeUrl, normalizeWhitespace, weakDhashSource } from "./hash-utils.mjs";

const HARD_REJECT_PATTERNS = [
  /logo|ロゴ|icon|avatar|profile|staff|スタッフ|banner|baner|バナー|campaign|キャンペーン/i,
  /ranking|ランキング|月間ランキング|chart|graph|グラフ|map|地図|youtube|ytimg|sddefault|hqdefault|mqdefault/i,
  /外観|内観|施工写真|写真のみ|リビング|キッチン|寝室|浴室|洗面|玄関写真|外構|モデルハウス写真|ルームツアー/i,
  /exterior|interior|facade|appearance|living|kitchen|bedroom|bathroom|garden|parking|carport/i,
  /ogp|ogimage|thumbnail|thumb|mainvisual|hero|subnavi|img_nav|bnr|selected|pbmce/i,
  /img01\.suumo\.com\/front\/gazo\/chumon\/.+\/main\/[^/]+p[0-9]+/i
];

const FLOORPLAN_TOKENS = [
  /間取り図|平面図|図面|madori|floor[-_ ]?plan|floorplan|layout|topview|top-view|zumen|drawing|heimen|hemen/i,
  /LDK|DK|K|洋室|和室|玄関|浴室|洗面|収納|WIC|CL|帖|畳|1F|2F|１階|２階/i,
  /(?:^|[/_-])plan[-_]?[0-9]+|collection_plan|madori_thm|N[0-9]+-[12]F/i
];

export function classifyImageCandidate(candidate) {
  const signal = candidateSignal(candidate);
  const imageSignal = imageSpecificSignal(candidate);
  const floorplanEvidence = FLOORPLAN_TOKENS.some((pattern) => pattern.test(imageSignal));
  const hardRejectSignals = HARD_REJECT_PATTERNS.filter((pattern) => pattern.test(imageSignal))
    .filter((pattern) => !floorplanEvidence || !/外観|内観|リビング|キッチン|寝室|浴室|洗面|exterior|interior|living|kitchen|bedroom|bathroom/i.test(pattern.source))
    .map((pattern) => pattern.source);
  const dimensions = dimensionsFromCandidate(candidate);
  const sizePenalty = dimensions.width && dimensions.height && (dimensions.width < 260 || dimensions.height < 180) ? 0.3 : 0;
  const bannerPenalty = dimensions.width && dimensions.height && isBannerRatio(dimensions.width, dimensions.height) ? 0.35 : 0;
  const tokenScore = FLOORPLAN_TOKENS.reduce((score, pattern) => score + (pattern.test(signal) ? 0.18 : 0), 0);
  const pageContextScore = /施工事例|建築実例|プラン|注文住宅|建売|分譲住宅|平屋|[1-7]S?LDK/i.test(signal) ? 0.12 : 0;
  const genericImagePenalty = /\/(?:img|image|photo)[-_]?[0-9]{1,3}\.(?:jpe?g|png|webp)(?:$|\?)/i.test(signal) ? 0.08 : 0;
  const photoTextureScore = hardRejectSignals.length ? 0.9 : /photo|gallery|room|kitchen|living|interior|exterior/i.test(signal) ? 0.55 : 0.15;
  const visualScore = clamp(0.25 + tokenScore + pageContextScore - sizePenalty - bannerPenalty - genericImagePenalty - hardRejectSignals.length * 0.35);

  return {
    finalCategory: hardRejectSignals.length ? inferRejectCategory(signal) : "unknown",
    visualScore,
    floorplanTokenScore: clamp(tokenScore),
    whiteBackgroundRatio: null,
    edgeDensity: null,
    straightLineCount: null,
    rectilinearShapeScore: null,
    colorVariance: null,
    photoTextureScore,
    textLikeRegionScore: null,
    ocrFloorplanTokenScore: clamp(tokenScore),
    aspectRatioScore: bannerPenalty ? 0.2 : 0.8,
    smallImagePenalty: sizePenalty,
    bannerPenalty,
    hardRejectSignals,
    dhash: weakDhashSource(candidate),
    imageDomain: getDomain(candidate.imageUrl || candidate.url || "")
  };
}

export function hasHardRejectSignals(candidate) {
  return classifyImageCandidate(candidate).hardRejectSignals.length > 0;
}

function candidateSignal(candidate) {
  return normalizeWhitespace(
    [
      candidate.imageUrl,
      candidate.url,
      candidate.thumbnailUrl,
      candidate.alt,
      candidate.title,
      candidate.pageTitle,
      candidate.nearImageText,
      candidate.caption
    ]
      .filter(Boolean)
      .map((value) => {
        if (/^https?:/i.test(String(value))) return normalizeUrl(value);
        return value;
      })
      .join(" ")
  );
}

function imageSpecificSignal(candidate) {
  return normalizeWhitespace(
    [
      candidate.imageUrl,
      candidate.url,
      candidate.thumbnailUrl,
      candidate.alt,
      candidate.title,
      candidate.caption,
      candidate.nearImageText
    ]
      .filter(Boolean)
      .map((value) => {
        if (/^https?:/i.test(String(value))) return normalizeUrl(value);
        return value;
      })
      .join(" ")
  );
}

function dimensionsFromCandidate(candidate) {
  return {
    width: Number(candidate.width || candidate.image?.width || 0),
    height: Number(candidate.height || candidate.image?.height || 0)
  };
}

function isBannerRatio(width, height) {
  const ratio = width / Math.max(1, height);
  return ratio > 3.5 || ratio < 0.22;
}

function inferRejectCategory(signal) {
  if (/youtube|ytimg|sddefault|hqdefault|mqdefault/i.test(signal)) return "youtube_thumbnail";
  if (/logo|ロゴ|icon/i.test(signal)) return "logo";
  if (/banner|バナー|campaign|キャンペーン/i.test(signal)) return "banner";
  if (/ranking|ランキング|chart|graph|グラフ/i.test(signal)) return "chart";
  if (/外観|exterior|facade|appearance/i.test(signal)) return "exterior_photo";
  if (/キッチン|kitchen/i.test(signal)) return "kitchen_photo";
  if (/浴室|bathroom/i.test(signal)) return "bathroom_photo";
  if (/寝室|bedroom/i.test(signal)) return "bedroom_photo";
  if (/リビング|living/i.test(signal)) return "living_room_photo";
  if (/内観|interior/i.test(signal)) return "interior_photo";
  if (/map|地図/i.test(signal)) return "map";
  return "other";
}

function clamp(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}
