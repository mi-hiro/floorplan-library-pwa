#!/usr/bin/env node
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { candidateImageId, pickBetterValue, stableId, weakDhashSource } from "./lib/hash-utils.mjs";
import { readJsonl, upsertJsonlById } from "./lib/jsonl-store.mjs";
import { classifyImageCandidate } from "./lib/image-features.mjs";
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
    fetchTimeoutSeconds: Number(config.ollama?.fetchTimeoutSeconds ?? 20),
    ollamaTimeoutSeconds: Number(config.ollama?.ollamaTimeoutSeconds ?? 90),
    maxImageBytes: Number(config.ollama?.maxImageBytes ?? 3000000),
    maxImages: Number(args.maxImages ?? config.ollama?.maxImages ?? 1000)
  };

  const candidates = await readJsonl(paths.candidates);
  const rejectedExisting = new Set((await readJsonl(paths.rejected)).map((record) => record.id));
  const reviewExisting = new Map((await readJsonl(paths.review)).map((record) => [record.id, record]));
  const acceptedExisting = new Set((await readJsonl(paths.accepted)).map((record) => record.id));
  const accepted = [];
  const rejected = [];
  const review = [];
  const candidateUpdates = [];
  const now = new Date().toISOString();
  const ollamaRuntime = ollamaOptions.enabled ? await resolveOllamaRuntime(ollamaOptions) : { available: false, reason: "disabled" };
  const domainOllamaErrors = countDomainOllamaErrors(candidates);
  const maxOllamaErrorsPerDomain = Number(args.maxOllamaErrorsPerDomain ?? 3);
  let ollamaChecked = 0;

  for (const candidate of candidates) {
    if (!candidate?.imageUrl) continue;
    const id = candidate.id || candidateImageId(candidate);
    if (rejectedExisting.has(id)) continue;
    if (acceptedExisting.has(id)) {
      accepted.push({ id, lastSeenAt: now });
      continue;
    }

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

    if (isAccepted(visual, ollama, finalConfidence, thresholds.autoAccept)) {
      accepted.push(makeAccepted(candidate, visual, ollama, finalConfidence, now));
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

function isAccepted(visual, ollama, finalConfidence, minConfidence) {
  return (
    ollama.status === "checked" &&
    ollama.category === "floorplan" &&
    ollama.isFloorplan === true &&
    ollama.isTopDownPlan === true &&
    ollama.hasWallsOrRoomBoundaries === true &&
    finalConfidence >= minConfidence &&
    visual.hardRejectSignals.length === 0
  );
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
  const category = value.category || (value.isFloorplan ? "floorplan" : "other");
  return {
    status: value.status || "checked",
    category,
    isFloorplan: value.isFloorplan === true,
    isTopDownPlan: value.isTopDownPlan === true,
    hasRoomLabels: value.hasRoomLabels === true,
    hasWallsOrRoomBoundaries: value.hasWallsOrRoomBoundaries === true,
    confidence: Number(value.confidence ?? 0),
    reason: value.reason || "",
    raw: value
  };
}

function needsFreshOllamaReview(ollama) {
  if (ollama.status === "error") return parseBool(args.retryErrors, false);
  if (ollama.status !== "checked") return true;
  const raw = ollama.raw || {};
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
    return {
      imageSha256: image.sha256,
      width: image.width,
      height: image.height,
      ollamaReview: normalizeOllamaJson(payload.response, runtime.model)
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
      prompt: OLLAMA_PROMPT,
      images: [image.base64],
      stream: false,
      format
    }),
    signal: AbortSignal.timeout(options.ollamaTimeoutSeconds * 1000)
  });
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
