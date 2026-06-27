#!/usr/bin/env node
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { candidateImageId, pickBetterValue, stableId, weakDhashSource } from "./lib/hash-utils.mjs";
import { readJsonl, upsertJsonlById } from "./lib/jsonl-store.mjs";
import { classifyImageCandidate } from "./lib/image-features.mjs";
import { analyzeImageBytes } from "./lib/image-byte-features.mjs";
import { extractMetadata } from "./lib/metadata-extractor.mjs";

const args = parseArgs(process.argv.slice(2));
const CLASSIFIER_VERSION = "2026-06-27";
const OLLAMA_PROMPT = `You are classifying real-estate images.

Return strict JSON only. Do not include markdown.

Classify the image into exactly one category:
- floorplan
- site_plan_only
- exterior_photo
- interior_photo
- kitchen_photo
- bathroom_photo
- bedroom_photo
- living_room_photo
- 3d_render
- map
- chart
- banner
- logo
- youtube_thumbnail
- other

A valid floorplan must be a top-down architectural plan of a house or apartment.
It usually contains rooms, walls, doors, stairs, labels, dimensions, or room names.
Reject exterior photos, interior photos, perspective renderings, maps, banners, thumbnails, logos, charts, decorative images, and photographs.

Important:
- If the image is only an exterior or interior photo, isFloorplan must be false.
- If the page context says "floor plan" but the image itself is a photo, isFloorplan must be false.
- If the image is a top-down plan mixed with a small exterior photo, classify as floorplan only when the floor plan is the main content.
- If unsure, use confidence below 0.85.

Return:
{
  "category": "...",
  "isFloorplan": true,
  "isTopDownPlan": true,
  "hasRoomLabels": true,
  "hasWallsOrRoomBoundaries": true,
  "visibleRooms": ["LDK", "Bedroom", "Bathroom"],
  "confidence": 0.0,
  "reason": "short reason"
}`;
const OLLAMA_FAST_PROMPT = `Classify this real-estate image. Return strict JSON only.

category must be exactly one of:
floorplan, site_plan_only, exterior_photo, interior_photo, kitchen_photo, bathroom_photo, bedroom_photo, living_room_photo, 3d_render, map, chart, banner, logo, youtube_thumbnail, other.

A valid floorplan is a top-down architectural house/apartment plan with rooms, walls, doors, stairs, labels, dimensions, or room names.
Reject photos, perspective renders, maps, banners, logos, charts, thumbnails, and decorative images.
If the image is clearly a top-down floorplan, set category="floorplan", isFloorplan=true, isTopDownPlan=true, hasWallsOrRoomBoundaries=true, confidence=0.95.
If unsure, confidence must be below 0.85.

Return exactly:
{"category":"...","isFloorplan":true,"isTopDownPlan":true,"hasRoomLabels":true,"hasWallsOrRoomBoundaries":true,"visibleRooms":[],"confidence":0.0,"reason":"short reason"}`;
const OLLAMA_FORMAT_SCHEMA = {
  type: "object",
  properties: {
    category: {
      type: "string",
      enum: [
        "floorplan",
        "site_plan_only",
        "exterior_photo",
        "interior_photo",
        "kitchen_photo",
        "bathroom_photo",
        "bedroom_photo",
        "living_room_photo",
        "3d_render",
        "map",
        "chart",
        "banner",
        "logo",
        "youtube_thumbnail",
        "other"
      ]
    },
    isFloorplan: { type: "boolean" },
    isTopDownPlan: { type: "boolean" },
    hasRoomLabels: { type: "boolean" },
    hasWallsOrRoomBoundaries: { type: "boolean" },
    visibleRooms: { type: "array", items: { type: "string" } },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    reason: { type: "string" }
  },
  required: ["category", "isFloorplan", "isTopDownPlan", "hasRoomLabels", "hasWallsOrRoomBoundaries", "visibleRooms", "confidence", "reason"]
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

async function main() {
  const config = await readOptionalJson(args.config ?? "floorplan-growth.config.json");
  const paths = {
    candidates: args.candidates ?? "data/candidate-images.jsonl",
    accepted: args.accepted ?? "data/accepted-floorplans.jsonl",
    rejected: args.rejected ?? "data/rejected-images.jsonl",
    review: args.review ?? "data/review-queue.jsonl"
  };
  const thresholds = {
    autoAccept: Number(config.classification?.autoAcceptMinConfidence ?? 0.85),
    reviewMin: Number(config.classification?.reviewMinConfidence ?? 0.6),
    minVisualForOllama: Number(config.classification?.minVisualScoreForOllama ?? 0.45)
  };
  const ollamaOptions = {
    enabled: parseBool(args.ollama ?? config.ollama?.enabled, true),
    endpoint: String(args.ollamaEndpoint ?? config.ollama?.endpoint ?? "http://127.0.0.1:11434").replace(/\/$/, ""),
    model: String(args.ollamaModel ?? config.ollama?.model ?? "llama3.2-vision:11b"),
    fallbackVisionModels: config.ollama?.fallbackVisionModels || ["llama3.2-vision", "llava", "minicpm-v", "moondream", "bakllava"],
    requestDelayMs: Number(args.ollamaDelayMs ?? config.ollama?.requestDelayMs ?? 1000),
    fetchTimeoutSeconds: Number(args.fetchTimeoutSeconds ?? config.ollama?.fetchTimeoutSeconds ?? 20),
    ollamaTimeoutSeconds: Number(args.ollamaTimeoutSeconds ?? config.ollama?.ollamaTimeoutSeconds ?? 90),
    maxImageBytes: Number(args.maxImageBytes ?? config.ollama?.maxImageBytes ?? 3000000),
    maxImages: Number(args.maxImages ?? config.ollama?.maxImages ?? 1000)
  };

  const rawCandidates = await readJsonl(paths.candidates);
  const rejectedExisting = new Set((await readJsonl(paths.rejected)).map((record) => record.id));
  const reviewExisting = new Map((await readJsonl(paths.review)).map((record) => [record.id, record]));
  const acceptedRecords = await readJsonl(paths.accepted);
  const acceptedExisting = new Set(acceptedRecords.map((record) => record.id));
  const acceptedImageUrls = new Set(acceptedRecords.map((record) => normalizeImageUrlForDedupe(record.source?.imageUrl || "")).filter(Boolean));
  const accepted = [];
  const rejected = [];
  const review = [];
  const candidateUpdates = [];
  const now = new Date().toISOString();
  const ollamaRuntime = ollamaOptions.enabled ? await resolveOllamaRuntime(ollamaOptions) : { available: false, reason: "disabled" };
  const domainOllamaErrors = countDomainOllamaErrors(rawCandidates);
  const maxOllamaErrorsPerDomain = Number(args.maxOllamaErrorsPerDomain ?? 3);
  const candidates = filterPromotionCandidates(orderCandidatesForPromotion(rawCandidates, domainOllamaErrors));
  const reconsiderRejected = parseBool(args.reconsiderRejected, false);
  let ollamaChecked = 0;

  for (const candidate of candidates) {
    if (!candidate?.imageUrl) continue;
    const id = candidate.id || candidateImageId(candidate);
    if (rejectedExisting.has(id) && !reconsiderRejected) continue;
    if (acceptedExisting.has(id)) {
      accepted.push({ id, lastSeenAt: now });
      continue;
    }
    const imageUrlKey = normalizeImageUrlForDedupe(candidate.imageUrl || "");
    if (imageUrlKey && acceptedImageUrls.has(imageUrlKey)) continue;

    const visual = classifyImageCandidate(candidate);
    let ollama = normalizeOllama(candidate.ollamaReview || reviewExisting.get(id)?.ollamaReview);

    if (visual.hardRejectSignals.length) {
      rejected.push(makeRejected(candidate, visual, ollama, now, "hard-reject-signal"));
      continue;
    }

    if (
      needsFreshOllamaReview(ollama) &&
      ollamaRuntime.available &&
      visual.visualScore >= thresholds.minVisualForOllama &&
      ollamaChecked < ollamaOptions.maxImages &&
      Number(domainOllamaErrors.get(candidate.sourceDomain || "") || 0) < maxOllamaErrorsPerDomain &&
      !isPdfCandidate(candidate)
    ) {
      const reviewed = await reviewWithOllama(candidate, ollamaRuntime, ollamaOptions);
      ollamaChecked += reviewed.ollamaReview?.status === "checked" || reviewed.ollamaReview?.status === "error" ? 1 : 0;
      ollama = normalizeOllama(reviewed.ollamaReview);
      candidate.ollamaReview = reviewed.ollamaReview;
      candidate.imageSha256 = reviewed.imageSha256 || candidate.imageSha256 || null;
      candidate.width = reviewed.width || candidate.width || null;
      candidate.height = reviewed.height || candidate.height || null;
      candidateUpdates.push({
        id,
        ollamaReview: reviewed.ollamaReview,
        imageSha256: reviewed.imageSha256 || candidate.imageSha256 || null,
        width: reviewed.width || candidate.width || null,
        height: reviewed.height || candidate.height || null,
        lastSeenAt: now
      });
      if (reviewed.ollamaReview?.status === "error") {
        const domain = candidate.sourceDomain || "";
        domainOllamaErrors.set(domain, Number(domainOllamaErrors.get(domain) || 0) + 1);
      }
      if (ollamaOptions.requestDelayMs > 0) await sleep(ollamaOptions.requestDelayMs);
    }

    const finalConfidence = finalConfidenceFrom(visual, ollama);

    if (ollama.status === "checked" && !ollama.isFloorplan) {
      rejected.push(makeRejected(candidate, visual, ollama, now, "ollama-rejected"));
      continue;
    }

    if (isAccepted(candidate, visual, ollama, finalConfidence, thresholds.autoAccept)) {
      accepted.push(makeAccepted(candidate, visual, ollama, finalConfidence, now));
      if (imageUrlKey) acceptedImageUrls.add(imageUrlKey);
      continue;
    }

    if (finalConfidence >= thresholds.reviewMin || visual.visualScore >= thresholds.minVisualForOllama || ollama.status !== "unchecked") {
      review.push(makeReview(candidate, visual, ollama, finalConfidence, now));
    } else {
      rejected.push(makeRejected(candidate, visual, ollama, now, "low-confidence"));
    }
  }

  if (candidateUpdates.length) await upsertJsonlById(paths.candidates, candidateUpdates);
  const acceptedResult = await upsertJsonlById(paths.accepted, accepted, mergeAccepted);
  const rejectedResult = await upsertJsonlById(paths.rejected, rejected);
  const reviewResult = await upsertJsonlById(paths.review, review);
  console.log(
    `Promoted candidates: accepted +${acceptedResult.added} (${acceptedResult.after}), review ${reviewResult.after}, rejected ${rejectedResult.after}, ollamaChecked ${ollamaChecked}`
  );
  if (ollamaOptions.enabled && !ollamaRuntime.available) {
    console.log(`Ollama unavailable: ${ollamaRuntime.reason}. New unchecked candidates stay in review/candidate, not accepted.`);
  }
}

function filterPromotionCandidates(candidates) {
  const domain = String(args.onlyDomain || "").replace(/^www\./, "").toLowerCase();
  const urlPattern = args.urlPattern ? new RegExp(String(args.urlPattern), "i") : null;
  return candidates.filter((candidate) => {
    if (domain && String(candidate.sourceDomain || "").replace(/^www\./, "").toLowerCase() !== domain) return false;
    if (urlPattern && !urlPattern.test(candidate.imageUrl || "")) return false;
    return true;
  });
}

function isAccepted(candidate, visual, ollama, finalConfidence, minConfidence) {
  return (
    ollama.status === "checked" &&
    ollama.category === "floorplan" &&
    ollama.isFloorplan === true &&
    ollama.isTopDownPlan === true &&
    ollama.hasWallsOrRoomBoundaries === true &&
    finalConfidence >= minConfidence &&
    visual.hardRejectSignals.length === 0 &&
    hasAcceptanceEvidence(candidate, visual)
  );
}

function hasAcceptanceEvidence(candidate, visual) {
  const { fileSignal, imageSignal, titleSignal, allSignal } = acceptanceSignals(candidate);
  if (!isLikelyImageUrl(candidate.imageUrl || "")) return false;
  if (/facebook\.com|tr\.line\.me|tag\.gif|google-analytics|googletagmanager|tracking|pixel|tr\?|og image|ogp|thumbnail|thumb|_thum|thum\.|prev-image|next-image|pic_clm_list|pic_body|keyvisual|interview-nav|[-_](?:120x68|160x90|320x180)\.(?:jpe?g|png|webp)(?:$|[?#]|\s)|tit_|bt_cate|btn_|bt_|bn-footer|globalnav|sidebutton|pagetop|page_top|phone\.png|footer|header|recruit|request|contact|company|showroom|modelhouse|event|txt[-_]|linenap|lineup_all|noimg|placeholder|dummy|spacer|img-nav|nav-identity|common\/tp\.gif|mainvisual|hero|gallery|photo|entrance|corridor|toilet|window|curtain|television|slidingdoor|livingcurtain|specialgift|siteguard|captcha/.test(allSignal)) {
    return false;
  }
  if (/打ち合わせ|作成中|様子/.test(titleSignal) && !/madori|floor[-_ ]?plan|floorplan|topview|heimen|hemen|zumen|drawing|間取り図|平面図|図面|plan[_-]?[0-9]|collection_plan|madori_thm|zu[0-9]/i.test(fileSignal)) return false;
  if (/hamaguri\.co\.jp/.test(allSignal) && !/madori|floor|plan|間取り|図面|drawing/.test(fileSignal)) return false;
  if (/yuyuhome\.co\.jp/.test(allSignal) && !/floor_plan|madori|plan|間取り|図面|drawing/.test(fileSignal)) return false;
  if (/genmai-home\.com/.test(allSignal) && !/drawing|madori|floor|plan|間取り|図面/.test(fileSignal)) return false;
  if (/cleverlyhome\.com/.test(allSignal) && !/madori|floor[-_ ]?plan|floorplan|topview|heimen|hemen|zumen|drawing|間取り図|平面図|図面|plan[_-]?[0-9]|collection_plan|madori_thm|zu[0-9]/i.test(fileSignal) && !isCleverlyPlanTitle(titleSignal)) return false;
  if (/(chitose-home\.com|marusho-kensetsu\.co\.jp|irohaie\.com)/.test(allSignal) && !/madori|floor[-_ ]?plan|floorplan|topview|heimen|hemen|zumen|drawing|間取り図|平面図|図面|plan[_-]?[0-9]|collection_plan|madori_thm|zu[0-9]/i.test(fileSignal)) return false;
  if (/madori|floor[-_ ]?plan|floorplan|floor_plan|topview|heimen|hemen|zumen|drawing|間取り図|平面図|図面|plan[_-]?[0-9]|madori_[0-9]|collection_plan|madori_thm|zu[0-9]/i.test(imageSignal)) {
    return true;
  }
  if (titleSignal.length <= 60 && /間取り図|平面図|図面|注文住宅の間取り|^平屋の間取り$/.test(titleSignal) && visual.visualScore >= 0.55 && !isGenericPhotoFile(fileSignal)) return true;
  return false;
}

function countDomainOllamaErrors(candidates) {
  const result = new Map();
  for (const candidate of candidates) {
    if (candidate.ollamaReview?.status !== "error") continue;
    const domain = candidate.sourceDomain || "";
    result.set(domain, Number(result.get(domain) || 0) + 1);
  }
  return result;
}

function orderCandidatesForPromotion(candidates, domainOllamaErrors) {
  const seenDomains = new Map();
  return [...candidates]
    .map((candidate, index) => {
      const visual = classifyImageCandidate(candidate);
      const domain = candidate.sourceDomain || "";
      const domainSeen = Number(seenDomains.get(domain) || 0);
      seenDomains.set(domain, domainSeen + 1);
      const { imageSignal, titleSignal, allSignal } = acceptanceSignals(candidate);
      const explicitPlanScore = /madori|floor[-_ ]?plan|floorplan|topview|heimen|hemen|zumen|drawing|間取り図|平面図|図面|plan[_-]?[0-9]|collection_plan|madori_thm/i.test(imageSignal) ||
        (titleSignal.length <= 60 && /間取り図|平面図|図面|注文住宅の間取り|^平屋の間取り$/.test(titleSignal))
        ? 0.35
        : 0;
      const rejectPenalty = /facebook\.com|tr\.line\.me|tag\.gif|tracking|pixel|thumbnail|thumb|_thum|prev-image|next-image|pic_clm_list|pic_body|keyvisual|interview-nav|bn-footer|globalnav|sidebutton|pagetop|page_top|phone\.png|footer|header|recruit|request|contact|company|showroom|modelhouse|event|ogp|noimg|placeholder|dummy|mainvisual|hero|gallery|photo/i.test(allSignal)
        ? 0.6
        : 0;
      const errorPenalty = Math.min(1, Number(domainOllamaErrors.get(domain) || 0) * 0.3);
      const alreadyCheckedPenalty = candidate.ollamaReview?.status === "checked" ? 0.4 : 0;
      const pdfPenalty = isPdfCandidate(candidate) ? 1 : 0;
      const diversityPenalty = Math.min(0.35, domainSeen * 0.03);
      const priority = visual.visualScore + explicitPlanScore - rejectPenalty - errorPenalty - alreadyCheckedPenalty - pdfPenalty - diversityPenalty;
      return { candidate, index, priority };
    })
    .sort((a, b) => b.priority - a.priority || a.index - b.index)
    .map((item) => item.candidate);
}

function acceptanceSignals(candidate) {
  const rawUrl = String(candidate.imageUrl || candidate.url || candidate.thumbnailUrl || "");
  const fileSignal = extractUrlFileName(rawUrl).toLowerCase();
  const imageSignal = `${fileSignal} ${candidate.alt || ""} ${candidate.caption || ""}`.toLowerCase();
  const titleSignal = String(candidate.title || candidate.pageTitle || "").toLowerCase();
  const allSignal = `${rawUrl} ${imageSignal} ${titleSignal}`.toLowerCase();
  return { fileSignal, imageSignal, titleSignal, allSignal };
}

function extractUrlFileName(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() || parsed.pathname || rawUrl);
  } catch {
    return rawUrl.split(/[/?#]/)[0] || rawUrl;
  }
}

function isLikelyImageUrl(rawUrl) {
  const value = String(rawUrl || "").toLowerCase();
  if (!/^https?:\/\//.test(value)) return false;
  if (/facebook\.com|tr\.line\.me|tag\.gif|google-analytics|googletagmanager|tracking|pixel|\/tr(?:\?|\/)/.test(value)) return false;
  return /\.(?:jpe?g|png|webp|gif)(?:$|[?#])/.test(value) || /\/(?:image|img|photo|uploads|wp-content|madori|plan|floor|drawing)\//.test(value);
}

function isGenericPhotoFile(fileSignal) {
  return /^(?:img|image|photo|pic|main|sub|detail|gallery)[-_]?[0-9]{1,4}\.(?:jpe?g|png|webp|gif)/i.test(fileSignal);
}

function isCleverlyPlanTitle(titleSignal) {
  return /間取り図\s*(?:1f|2f|１f|２f|１階|２階|平屋)|(?:1f|2f|１f|２f|１階|２階)の?間取り図|平屋間取り図/i.test(titleSignal) &&
    !/ldk|打ち合わせ|作成中|様子/.test(titleSignal);
}

function normalizeImageUrlForDedupe(value) {
  return safeDecode(value)
    .trim()
    .toLowerCase()
    .replace(/[?#].*$/, "")
    .replace(/-\d+x\d+(?=\.(?:jpe?g|png|webp|gif)$)/i, "");
}

function safeDecode(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
}

function makeAccepted(candidate, visual, ollama, finalConfidence, now) {
  const metadata = candidate.metadata || extractMetadata(candidate);
  return {
    id: candidate.id || candidateImageId(candidate),
    schemaVersion: 1,
    status: "accepted",
    firstSeenAt: candidate.firstSeenAt || now,
    lastSeenAt: now,
    currentSourceStatus: "available",
    source: {
      sourceType: candidate.sourceType || "adapter",
      sourceDomain: candidate.sourceDomain || "",
      companyName: candidate.companyName || "",
      pageUrl: candidate.pageUrl || "",
      imageUrl: candidate.imageUrl || "",
      pdfUrl: candidate.pdfUrl ?? null,
      pdfPageNumber: candidate.pdfPageNumber ?? null,
      discoveredFrom: candidate.discoveredFrom || ""
    },
    title: candidate.title || candidate.pageTitle || "間取り図",
    image: {
      kind: "floorplan",
      width: Number(candidate.width || 0) || null,
      height: Number(candidate.height || 0) || null,
      sha256: candidate.imageSha256 || null,
      phash: candidate.phash || null,
      dhash: candidate.dhash || visual.dhash || weakDhashSource(candidate),
      contentHashSource: candidate.imageSha256 ? "image-bytes" : "url-only",
      localCachePath: null
    },
    classification: {
      finalCategory: "floorplan",
      visualScore: Number(visual.visualScore.toFixed(3)),
      ollamaScore: Number(ollama.confidence.toFixed(3)),
      finalConfidence: Number(finalConfidence.toFixed(3)),
      isTopDownPlan: true,
      hasRoomLabels: ollama.hasRoomLabels === true,
      hasWallsOrRoomBoundaries: true,
      rejectSignals: [],
      classifierVersion: CLASSIFIER_VERSION
    },
    metadata,
    context: {
      pageTitle: candidate.pageTitle || "",
      nearImageText: candidate.nearImageText || "",
      sourceSnippet: candidate.sourceSnippet || "",
      alt: candidate.alt || "",
      caption: candidate.caption || ""
    }
  };
}

function makeRejected(candidate, visual, ollama, now, reason) {
  return {
    id: candidate.id || candidateImageId(candidate),
    status: "rejected",
    firstSeenAt: candidate.firstSeenAt || now,
    lastSeenAt: now,
    imageUrl: candidate.imageUrl,
    pageUrl: candidate.pageUrl,
    sourceDomain: candidate.sourceDomain || "",
    category: ollama.category || (visual.finalCategory === "unknown" ? "other" : visual.finalCategory),
    reason,
    visualScore: Number(visual.visualScore.toFixed(3)),
    ollamaReview: ollama.raw ?? null,
    hardRejectSignals: visual.hardRejectSignals
  };
}

function makeReview(candidate, visual, ollama, finalConfidence, now) {
  return {
    id: candidate.id || candidateImageId(candidate),
    status: "review",
    firstSeenAt: candidate.firstSeenAt || now,
    lastSeenAt: now,
    imageUrl: candidate.imageUrl,
    pageUrl: candidate.pageUrl,
    sourceDomain: candidate.sourceDomain || "",
    title: candidate.title || candidate.pageTitle || "",
    visualScore: Number(visual.visualScore.toFixed(3)),
    finalConfidence: Number(finalConfidence.toFixed(3)),
    reason: reviewReason(ollama),
    ollamaReview: ollama.raw ?? null,
    context: {
      pageTitle: candidate.pageTitle || "",
      nearImageText: candidate.nearImageText || "",
      alt: candidate.alt || ""
    }
  };
}

function reviewReason(ollama) {
  if (ollama.status === "checked") return "ollama-uncertain";
  if (ollama.status === "error") return "ollama-or-image-fetch-error";
  return "unchecked-or-visual-only";
}

function normalizeOllama(value) {
  if (!value) return { status: "unchecked", confidence: 0, raw: null };
  const legacyFloorplan = isStrongLegacyFloorplanReview(value);
  const category = value.category || (legacyFloorplan ? "floorplan" : value.isFloorplan ? "floorplan" : "other");
  return {
    status: value.status || "checked",
    category,
    isFloorplan: value.isFloorplan === true,
    isTopDownPlan: value.isTopDownPlan === true || legacyFloorplan,
    hasRoomLabels: value.hasRoomLabels === true,
    hasWallsOrRoomBoundaries: value.hasWallsOrRoomBoundaries === true || legacyFloorplan,
    confidence: Number(value.confidence ?? 0),
    reason: value.reason || "",
    raw: value
  };
}

function isStrongLegacyFloorplanReview(value) {
  if (!value || value.category) return false;
  if (value.status && value.status !== "checked") return false;
  if (value.isFloorplan !== true) return false;
  if (Number(value.confidence ?? 0) < 0.9) return false;
  const reason = String(value.reason || "");
  return /top[- ]?view|top[- ]?down|floor plan|residential floor plan|architectural drawing|layout of a .*floor plan/i.test(reason);
}

function needsFreshOllamaReview(ollama) {
  if (ollama.status === "error") return parseBool(args.retryErrors, false);
  if (ollama.status !== "checked") return true;
  const raw = ollama.raw || {};
  if (isStrongLegacyFloorplanReview(raw)) return false;
  if (ollama.isFloorplan && Number(raw.confidence ?? 0) < 0.6) return parseBool(args.retryLowConfidence, false);
  if (ollama.isFloorplan && (raw.category == null || raw.isTopDownPlan == null || raw.hasWallsOrRoomBoundaries == null)) return true;
  return false;
}

function finalConfidenceFrom(visual, ollama) {
  if (ollama.status === "checked") return Math.min(1, Math.max(0, ollama.confidence * 0.8 + visual.visualScore * 0.2));
  if (ollama.status === "error") return Math.min(0.84, visual.visualScore);
  return Math.min(0.84, visual.visualScore);
}

async function resolveOllamaRuntime(options) {
  try {
    const response = await fetch(`${options.endpoint}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return { available: false, reason: `HTTP ${response.status}` };
    const payload = await response.json();
    const available = new Set((payload.models || []).map((model) => model.name));
    const models = [options.model, ...options.fallbackVisionModels].filter(Boolean);
    const selected = models.find((model) => available.has(model) || available.has(`${model}:latest`));
    if (!selected) return { available: false, reason: "no configured vision model found" };
    return { available: true, endpoint: options.endpoint, model: available.has(selected) ? selected : `${selected}:latest` };
  } catch (error) {
    return { available: false, reason: error.message || "connection failed" };
  }
}

async function reviewWithOllama(candidate, runtime, options) {
  const image = await fetchImageBytes(candidate.imageUrl, options);
  if (!image.ok) {
    return {
      ollamaReview: {
        status: "error",
        category: "other",
        isFloorplan: false,
        confidence: 0,
        reason: image.reason
      }
    };
  }
  const byteFeatures = await analyzeImageBytes(image.bytes).catch((error) => ({
    available: false,
    hardReject: false,
    reason: error.message || "byte feature analysis failed"
  }));
  if (byteFeatures.hardReject) {
    return {
      imageSha256: image.sha256,
      width: image.width,
      height: image.height,
      byteFeatures,
      ollamaReview: {
        status: "checked",
        model: "image-byte-features",
        category: byteFeatures.category || "other",
        isFloorplan: false,
        isTopDownPlan: false,
        hasRoomLabels: false,
        hasWallsOrRoomBoundaries: false,
        visibleRooms: [],
        confidence: 0.95,
        reason: byteFeatures.reason || "local visual features rejected image"
      }
    };
  }

  try {
    let response = await callOllamaGenerate(runtime, image, options, OLLAMA_FORMAT_SCHEMA);
    if (response.status === 400) response = await callOllamaGenerate(runtime, image, options, "json");
    if (!response.ok) {
      return {
        imageSha256: image.sha256,
        width: image.width,
        height: image.height,
        ollamaReview: {
          status: "error",
          model: runtime.model,
          category: "other",
          isFloorplan: false,
          confidence: 0,
          reason: `ollama HTTP ${response.status}`
        }
      };
    }
    const payload = await response.json();
    const ollamaReview = normalizeOllamaJson(payload.response, runtime.model);
    if (ollamaReview.isFloorplan && byteFeatures.available && byteFeatures.photoLike && !byteFeatures.floorplanLike) {
      ollamaReview.category = byteFeatures.category || "interior_photo";
      ollamaReview.isFloorplan = false;
      ollamaReview.isTopDownPlan = false;
      ollamaReview.hasWallsOrRoomBoundaries = false;
      ollamaReview.confidence = 0.95;
      ollamaReview.reason = `Rejected by local visual features: ${byteFeatures.reason}`;
    }
    ollamaReview.byteFeatures = byteFeatures;
    return {
      imageSha256: image.sha256,
      width: image.width,
      height: image.height,
      byteFeatures,
      ollamaReview
    };
  } catch (error) {
    return {
      imageSha256: image.sha256,
      width: image.width,
      height: image.height,
      ollamaReview: {
        status: "error",
        model: runtime.model,
        category: "other",
        isFloorplan: false,
        confidence: 0,
        reason: error.message || "ollama request failed"
      }
    };
  }
}

function callOllamaGenerate(runtime, image, options, format) {
  return fetch(`${runtime.endpoint}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: runtime.model,
        prompt: promptForModel(runtime.model),
      images: [image.base64],
      stream: false,
      format,
      options: {
        temperature: 0,
        num_predict: 220
      }
    }),
    signal: AbortSignal.timeout(options.ollamaTimeoutSeconds * 1000)
  });
}

function promptForModel(model) {
  return /moondream|minicpm|bakllava|llava/i.test(model) ? OLLAMA_FAST_PROMPT : OLLAMA_PROMPT;
}

async function fetchImageBytes(imageUrl, options) {
  if (!/^https?:\/\//i.test(imageUrl || "")) return { ok: false, reason: "image URL is not HTTP" };
  try {
    const response = await fetch(imageUrl, { signal: AbortSignal.timeout(options.fetchTimeoutSeconds * 1000) });
    if (response.status === 403 || response.status === 429) return { ok: false, reason: `blocked with HTTP ${response.status}` };
    if (!response.ok) return { ok: false, reason: `image HTTP ${response.status}` };
    const contentType = response.headers.get("content-type") || "";
    if (contentType && !/^image\//i.test(contentType)) return { ok: false, reason: `not an image content-type: ${contentType}` };
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength && contentLength > options.maxImageBytes) return { ok: false, reason: `image too large: ${contentLength}` };
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > options.maxImageBytes) return { ok: false, reason: `image too large: ${bytes.length}` };
    const dimensions = detectImageDimensions(bytes);
    return {
      ok: true,
      bytes,
      base64: bytes.toString("base64"),
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      width: dimensions.width,
      height: dimensions.height
    };
  } catch (error) {
    return { ok: false, reason: error.message || "image fetch failed" };
  }
}

function normalizeOllamaJson(text, model) {
  const parsed = parseJsonObject(text);
  if (!parsed.category) {
    return {
      status: "error",
      model,
      category: "other",
      isFloorplan: false,
      isTopDownPlan: false,
      hasRoomLabels: false,
      hasWallsOrRoomBoundaries: false,
      visibleRooms: [],
      confidence: 0,
      reason: "Ollama did not return strict JSON category"
    };
  }
  const category = String(parsed.category || "other");
  return {
    status: "checked",
    model,
    category,
    isFloorplan: parsed.isFloorplan === true,
    isTopDownPlan: parsed.isTopDownPlan === true,
    hasRoomLabels: parsed.hasRoomLabels === true,
    hasWallsOrRoomBoundaries: parsed.hasWallsOrRoomBoundaries === true,
    visibleRooms: Array.isArray(parsed.visibleRooms) ? parsed.visibleRooms.slice(0, 20) : [],
    confidence: clamp(Number(parsed.confidence ?? 0)),
    reason: String(parsed.reason || "").slice(0, 400)
  };
}

function parseJsonObject(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = String(text || "").match(/\{[\s\S]*\}/);
    if (!match) return {};
    try {
      return JSON.parse(match[0]);
    } catch {
      return {};
    }
  }
}

function detectImageDimensions(bytes) {
  if (bytes.length >= 24 && bytes.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length >= 10 && bytes.slice(0, 3).toString("ascii") === "GIF") {
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  }
  if (bytes.length >= 12 && bytes.slice(0, 4).toString("ascii") === "RIFF" && bytes.slice(8, 12).toString("ascii") === "WEBP") {
    return detectWebpDimensions(bytes);
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return detectJpegDimensions(bytes);
  }
  return { width: null, height: null };
}

function detectJpegDimensions(bytes) {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    const length = bytes.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
    }
    offset += 2 + Math.max(2, length);
  }
  return { width: null, height: null };
}

function detectWebpDimensions(bytes) {
  const chunk = bytes.slice(12, 16).toString("ascii");
  if (chunk === "VP8X" && bytes.length >= 30) {
    return {
      width: 1 + bytes.readUIntLE(24, 3),
      height: 1 + bytes.readUIntLE(27, 3)
    };
  }
  if (chunk === "VP8 " && bytes.length >= 30) {
    return {
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff
    };
  }
  if (chunk === "VP8L" && bytes.length >= 25) {
    const bits = bytes.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1
    };
  }
  return { width: null, height: null };
}

function mergeAccepted(current, incoming) {
  return {
    ...current,
    lastSeenAt: incoming.lastSeenAt || current.lastSeenAt,
    currentSourceStatus: incoming.currentSourceStatus || current.currentSourceStatus,
    metadata: mergeMetadata(current.metadata || {}, incoming.metadata || {}),
    classification:
      Number(incoming.classification?.finalConfidence ?? 0) > Number(current.classification?.finalConfidence ?? 0)
        ? incoming.classification
        : current.classification
  };
}

function mergeMetadata(current, incoming) {
  const result = { ...current };
  for (const [key, value] of Object.entries(incoming)) {
    result[key] = pickBetterValue(current[key], value);
  }
  return result;
}

function isPdfCandidate(candidate) {
  return Boolean(candidate.pdfUrl || /\.pdf(?:$|[?#])/i.test(candidate.imageUrl || ""));
}

async function readOptionalJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return {};
  }
}

function parseBool(value, defaultValue = false) {
  if (value == null) return defaultValue;
  if (typeof value === "boolean") return value;
  return !/^(false|0|no|off)$/i.test(String(value));
}

function clamp(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
