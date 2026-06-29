#!/usr/bin/env node
import { readJsonl, upsertJsonlById, writeJsonl } from "./lib/jsonl-store.mjs";
import { classifyImageCandidate } from "./lib/image-features.mjs";

const args = parseArgs(process.argv.slice(2));

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

async function main() {
  const acceptedPath = args.accepted ?? "data/accepted-floorplans.jsonl";
  const rejectedPath = args.rejected ?? "data/rejected-images.jsonl";
  const accepted = await readJsonl(acceptedPath);
  const keep = [];
  const reject = [];
  const now = new Date().toISOString();
  const seenImageUrls = new Set();
  const preferredHashIds = buildPreferredHashIds(accepted);

  for (const record of accepted) {
    const visual = classifyImageCandidate({
      imageUrl: record.source?.imageUrl,
      pageUrl: record.source?.pageUrl,
      alt: record.context?.alt,
      title: record.title,
      nearImageText: record.context?.nearImageText,
      caption: record.context?.caption
    });
    const imageUrlKey = normalizeAcceptedImageUrl(record.source?.imageUrl || "");
    const duplicateReason = imageUrlKey && seenImageUrls.has(imageUrlKey) ? "accepted-cleanup-duplicate-image-url" : "";
    const duplicateHashReason = getDuplicateHashReason(record, preferredHashIds);
    const extraReason = duplicateReason || duplicateHashReason || extraRejectReason(record);
    if (visual.hardRejectSignals.length || extraReason) {
      reject.push({
        id: record.id,
        status: "rejected",
        firstSeenAt: record.firstSeenAt || now,
        lastSeenAt: now,
        imageUrl: record.source?.imageUrl || "",
        pageUrl: record.source?.pageUrl || "",
        sourceDomain: record.source?.sourceDomain || "",
        category: visual.finalCategory === "unknown" ? "other" : visual.finalCategory,
        reason: extraReason || "accepted-cleanup-hard-reject",
        visualScore: Number(visual.visualScore.toFixed(3)),
        hardRejectSignals: visual.hardRejectSignals,
        previousAcceptedConfidence: record.classification?.finalConfidence ?? null
      });
    } else {
      if (imageUrlKey) seenImageUrls.add(imageUrlKey);
      keep.push(record);
    }
  }

  await writeJsonl(acceptedPath, keep);
  const acceptedIds = new Set(keep.map((record) => record.id));
  const rejectedBefore = (await readJsonl(rejectedPath)).filter((record) => !acceptedIds.has(record.id));
  await writeJsonl(rejectedPath, rejectedBefore);
  const rejectedResult = await upsertJsonlById(rejectedPath, reject);
  console.log(`Cleaned accepted floorplans: kept ${keep.length}, removed ${reject.length}, rejected now ${rejectedResult.after}`);
}

function extraRejectReason(record) {
  const decodedUrl = safeDecode(record.source?.imageUrl || "");
  const text = `${record.title || ""} ${decodedUrl} ${record.source?.imageUrl || ""} ${record.context?.alt || ""}`.toLowerCase();
  if (isSmallAcceptedImage(record)) return "accepted-cleanup-small-or-banner-image";
  if (/\/common\/|noimg|placeholder|dummy|spacer|img-nav|nav-identity|pagetop|page_top|common\/tp\.gif/.test(text)) return "accepted-cleanup-common-ui-image";
  if (/facebook\.com|tr\.line\.me|tag\.gif|google-analytics|googletagmanager|tracking|pixel|prev-image|next-image|pic_clm_list|pic_body|keyvisual|interview-nav|og image|ogp|thumbnail|thumb|_thum|thum\.|tit_|bt_cate|btn_|bt_|txt[-_]|linenap|lineup_all|pc_linenap|sp_linenap/.test(text)) return "accepted-cleanup-text-or-thumbnail-image";
  if (/aerahome\.com\/column\/wp\/wp-content\/uploads\/.+\/column[0-9]+-01(?:-\d+x\d+)?\.(?:jpe?g|png|webp)/.test(text) && !hasStrongFilePlanEvidence(record)) return "accepted-cleanup-aerahome-column-photo";
  if (hasPhotoOnlyTitle(record)) return "accepted-cleanup-photo-only-title";
  if (/mainvisual|hero|gallery|photo|entrance|corridor|toilet|window|curtain|television|slidingdoor|livingcurtain|specialgift|siteguard|captcha|ウッドデッキ|カフェ|ldk|dsc|mg_|玄関|廊下|外観|内観/.test(text) && !hasStrongPlanEvidence(record)) return "accepted-cleanup-photo-or-system-image";
  if (/[-_](?:120x68|160x90|300x200|320x180)\.(?:jpe?g|png|webp)(?:$|[?#]|\s)/.test(text)) return "accepted-cleanup-small-thumbnail";
  if (/hamaguri\.co\.jp/.test(text) && !hasStrongPlanEvidence(record)) return "accepted-cleanup-domain-photo-gallery";
  if (/yuyuhome\.co\.jp/.test(text) && !/floor_plan|madori|plan|間取り|図面|drawing/.test(decodedUrl.toLowerCase()) && !hasStrongPlanEvidence(record)) return "accepted-cleanup-domain-photo-gallery";
  if (/cleverlyhome\.com/.test(text) && !hasStrongFilePlanEvidence(record) && !isCleverlyPlanTitle(record)) return "accepted-cleanup-domain-photo-gallery";
  if (/(chitose-home\.com|marusho-kensetsu\.co\.jp)/.test(text) && !hasStrongFilePlanEvidence(record)) return "accepted-cleanup-domain-photo-gallery";
  if (/irohaie\.com/.test(text) && !hasStrongFilePlanEvidence(record) && !hasStrongPlanEvidence(record)) return "accepted-cleanup-domain-photo-gallery";
  if (/be-enough\.jp/.test(text) && isBeEnoughNonFloorplanFile(decodedUrl)) return "accepted-cleanup-be-enough-site-plan-or-elevation";
  if (/打ち合わせ|作成中|様子/.test(text) && !hasStrongFilePlanEvidence(record)) return "accepted-cleanup-process-photo";
  if (/sfc\.jp/.test(text) && /イメージ|ウッドデッキ|パントリー|ウォークイン|クローゼット|和室|ランドリー|土間|ガレージ|吹き抜け|勾配天井|ワークスペース/.test(text) && !/間取りの(?:１|1|２|2|３|3|一|二|三)?階部分/.test(text)) return "accepted-cleanup-sfc-photo-section";
  if (/sekisuiheim\.com\/madori\//.test(text) && /pic_(?:kv|idea|small_pw|mdr_cta)/.test(text)) return "accepted-cleanup-sekisuiheim-madori-explainer-image";
  if (/genmai-home\.com/.test(text) && !/drawing|madori|floor|plan|間取り|図面/.test(record.source?.imageUrl || "")) return "accepted-cleanup-blog-non-plan-image";
  if (/bedroom|childroom|kitchen|living|bathroom|toilet|pantry|closet|wood[_-]?deck|寝室|子ども部屋|子供部屋|キッチン|リビング|浴室|洗面|トイレ|パントリー|ウォークイン|クローゼット|和室|ランドリー|土間|ガレージ|吹き抜け|勾配天井|ワークスペース/.test(text) && !hasStrongPlanEvidence(record)) {
    return "accepted-cleanup-room-photo";
  }
  if (isGenericUploadedPhoto(decodedUrl) && !hasStrongPlanEvidence(record)) return "accepted-cleanup-generic-uploaded-photo";
  if (!isLikelyAcceptedImageUrl(record.source?.imageUrl || "")) return "accepted-cleanup-non-image-url";
  return "";
}

function buildPreferredHashIds(records) {
  const best = new Map();
  for (const record of records) {
    const hash = record.image?.sha256;
    if (!hash) continue;
    const current = best.get(hash);
    if (!current || acceptedRecordScore(record) > acceptedRecordScore(current)) {
      best.set(hash, record);
    }
  }
  return new Map([...best].map(([hash, record]) => [hash, record.id]));
}

function getDuplicateHashReason(record, preferredHashIds) {
  const hash = record.image?.sha256;
  if (!hash) return "";
  const preferredId = preferredHashIds.get(hash);
  return preferredId && preferredId !== record.id ? "accepted-cleanup-duplicate-image-hash" : "";
}

function acceptedRecordScore(record) {
  const url = safeDecode(record.source?.imageUrl || "").toLowerCase();
  const width = Number(record.image?.width || 0);
  const height = Number(record.image?.height || 0);
  let score = Math.min(30, (width * height) / 50000);
  if (/layout|madori|floor[-_]?plan|floorplan|drawing|間取り|平面図|図面/i.test(url)) score += 50;
  if (/_s\.(?:jpe?g|png|webp)(?:$|[?#])/i.test(url)) score -= 40;
  if (isSmallAcceptedImage(record)) score -= 60;
  return score;
}

function isSmallAcceptedImage(record) {
  const width = Number(record.image?.width || 0);
  const height = Number(record.image?.height || 0);
  if (!width || !height) return false;
  const ratio = width / Math.max(1, height);
  return width < 260 || height < 180 || ratio > 3.5 || ratio < 0.22;
}

function hasStrongPlanEvidence(record) {
  if (hasStrongImagePlanEvidence(record)) return true;
  const url = safeDecode(record.source?.imageUrl || "").toLowerCase();
  const fileName = url.split(/[/?#]/)[0].split("/").filter(Boolean).pop() || url;
  const title = String(record.title || "").toLowerCase();
  if (/with-e-home\.com\/img\/uploads\/plans\/\d{4}-\d{2}-\d{2}\/[^?#\s]+\.png/i.test(url)) return true;
  if (title.length <= 70 && /^平屋の間取り$/.test(title)) return true;
  if (title.length <= 110 && /間取りの(?:１|1|２|2|３|3|一|二|三)?階部分|注文住宅の間取り|注文住宅.*プラン|間取り.*プラン|間取り図plan|平面図|図面|平屋.*間取り(?:事例|プラン)|間取り(?:事例|プラン|集)|間取り\s*(?:例|一覧|アーカイブ)|plan gallery|floor[-_ ]?plan archive/i.test(title)) return true;
  if (/floor_plan|floorplan|topview_plan|madori|drawing|layout|plan[_-]?[0-9]|pic_small_pl_p[0-9]/i.test(url)) return true;
  return false;
}

function hasStrongImagePlanEvidence(record) {
  const url = safeDecode(record.source?.imageUrl || "").toLowerCase();
  const fileName = url.split(/[/?#]/)[0].split("/").filter(Boolean).pop() || url;
  const alt = String(record.context?.alt || "").toLowerCase();
  return /madori|floor[-_ ]?plan|floorplan|layout|topview|heimen|hemen|zumen|drawing|間取り|間取|平面図|図面|plan[_-]?[0-9]|pic_small_pl_p[0-9]|collection_plan|madori_thm|zu[0-9]/i.test(`${fileName} ${alt}`);
}

function hasStrongFilePlanEvidence(record) {
  const url = safeDecode(record.source?.imageUrl || "").toLowerCase();
  const path = url.replace(/^https?:\/\/[^/]+/i, "").split(/[?#]/)[0];
  const fileName = path.split("/").filter(Boolean).pop() || path;
  return /madori|floor[-_ ]?plan|floorplan|layout|topview|heimen|hemen|zumen|drawing|間取り|間取|平面図|図面|plan[_-]?[0-9]|pic_small_pl_p[0-9]|collection_plan|madori_thm|zu[0-9]/i.test(fileName);
}

function isCleverlyPlanTitle(record) {
  const title = String(record.title || "").toLowerCase();
  return /間取り図\s*(?:1f|2f|１f|２f|１階|２階|平屋)|(?:1f|2f|１f|２f|１階|２階)の?間取り図|平屋間取り図/i.test(title) &&
    !/打ち合わせ|作成中|様子/.test(title);
}

function hasPhotoOnlyTitle(record) {
  const title = String(record.title || "").toLowerCase();
  if (!title) return false;
  const hasPhotoWord = /外観|内観|施工写真|写真のみ|リビングイメージ|イメージ|photo|interior|exterior|facade|appearance|gallery/i.test(title) ||
    /(?:リビング|ダイニング|キッチン|寝室|浴室|洗面|トイレ|玄関|和室|パントリー|ウォークイン|クローゼット|ランドリー|土間|ガレージ|吹き抜け|勾配天井|ワークスペース)(?:の|$|\s|　)/i.test(title);
  if (!hasPhotoWord) return false;
  return !/間取り|間取|平面図|図面|プラン|floor[-_ ]?plan|floorplan|madori|drawing|[1-7]s?ldk/i.test(title);
}

function isGenericUploadedPhoto(decodedUrl) {
  const fileName = decodedUrl.toLowerCase().split(/[/?#]/)[0].split("/").filter(Boolean).pop() || "";
  return /^(?:dsc|mg_|img_|image_|photo_|pic_|main|sub|[0-9]{1,3}(?:-[0-9])?)|(?:1200x628|1920x1080|27422127_s|more|re_(?:forte|item|works|voices))/.test(fileName);
}

function isBeEnoughNonFloorplanFile(decodedUrl) {
  const fileName = decodedUrl
    .toLowerCase()
    .replace(/^https?:\/\/[^/]+/i, "")
    .split(/[?#]/)[0]
    .split("/")
    .filter(Boolean)
    .pop() || "";
  return /^(?:snapshot|plan[0-9]+-img0[14](?:-\d+x\d+)?)\.(?:jpe?g|png|webp)$/.test(fileName);
}

function isLikelyAcceptedImageUrl(rawUrl) {
  const value = String(rawUrl || "").toLowerCase();
  if (!/^https?:\/\//.test(value)) return false;
  if (/facebook\.com|tr\.line\.me|tag\.gif|google-analytics|googletagmanager|tracking|pixel|\/tr(?:\?|\/)/.test(value)) return false;
  return /\.(?:jpe?g|png|webp|gif)(?:$|[?#])/.test(value) || /\/(?:image|img|uploads|wp-content|madori|plan|floor|drawing)\//.test(value);
}

function safeDecode(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
}

function normalizeAcceptedImageUrl(value) {
  return safeDecode(value)
    .trim()
    .toLowerCase()
    .replace(/[?#].*$/, "")
    .replace(/-\d+x\d+(?=\.(?:jpe?g|png|webp|gif)$)/i, "");
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
