#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { candidateImageId, pickBetterValue, stableId, weakDhashSource } from "./lib/hash-utils.mjs";
import { readJsonl, upsertJsonlById } from "./lib/jsonl-store.mjs";
import { classifyImageCandidate } from "./lib/image-features.mjs";
import { extractMetadata } from "./lib/metadata-extractor.mjs";

const args = parseArgs(process.argv.slice(2));
const CLASSIFIER_VERSION = "2026-06-27";

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
    reviewMin: Number(config.classification?.reviewMinConfidence ?? 0.6)
  };

  const candidates = await readJsonl(paths.candidates);
  const rejectedExisting = new Set((await readJsonl(paths.rejected)).map((record) => record.id));
  const acceptedExisting = new Set((await readJsonl(paths.accepted)).map((record) => record.id));
  const accepted = [];
  const rejected = [];
  const review = [];
  const now = new Date().toISOString();

  for (const candidate of candidates) {
    if (!candidate?.imageUrl) continue;
    const id = candidate.id || candidateImageId(candidate);
    if (rejectedExisting.has(id)) continue;
    if (acceptedExisting.has(id)) {
      accepted.push({ id, lastSeenAt: now });
      continue;
    }

    const visual = classifyImageCandidate(candidate);
    const ollama = normalizeOllama(candidate.ollamaReview);
    const finalConfidence = finalConfidenceFrom(visual, ollama);
    const hardRejectSignals = visual.hardRejectSignals;

    if (hardRejectSignals.length) {
      rejected.push(makeRejected(candidate, visual, ollama, now, "hard-reject-signal"));
      continue;
    }

    if (ollama.status === "checked" && !ollama.isFloorplan) {
      rejected.push(makeRejected(candidate, visual, ollama, now, "ollama-rejected"));
      continue;
    }

    if (isAccepted(visual, ollama, finalConfidence, thresholds.autoAccept)) {
      accepted.push(makeAccepted(candidate, visual, ollama, finalConfidence, now));
      continue;
    }

    if (finalConfidence >= thresholds.reviewMin || visual.visualScore >= Number(config.classification?.minVisualScoreForOllama ?? 0.45)) {
      review.push(makeReview(candidate, visual, ollama, finalConfidence, now));
    } else {
      rejected.push(makeRejected(candidate, visual, ollama, now, "low-confidence"));
    }
  }

  const acceptedResult = await upsertJsonlById(paths.accepted, accepted, mergeAccepted);
  const rejectedResult = await upsertJsonlById(paths.rejected, rejected);
  const reviewResult = await upsertJsonlById(paths.review, review);
  console.log(
    `Promoted candidates: accepted +${acceptedResult.added} (${acceptedResult.after}), review ${reviewResult.after}, rejected ${rejectedResult.after}`
  );
}

function isAccepted(visual, ollama, finalConfidence, minConfidence) {
  return (
    ollama.status === "checked" &&
    ollama.category === "floorplan" &&
    ollama.isFloorplan === true &&
    ollama.isTopDownPlan !== false &&
    ollama.hasWallsOrRoomBoundaries !== false &&
    finalConfidence >= minConfidence &&
    visual.hardRejectSignals.length === 0
  );
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
      isTopDownPlan: ollama.isTopDownPlan !== false,
      hasRoomLabels: ollama.hasRoomLabels === true,
      hasWallsOrRoomBoundaries: ollama.hasWallsOrRoomBoundaries !== false,
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
    category: visual.finalCategory === "unknown" ? ollama.category || "other" : visual.finalCategory,
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
    reason: ollama.status === "checked" ? "ollama-uncertain" : "unchecked-or-visual-only",
    ollamaReview: ollama.raw ?? null,
    context: {
      pageTitle: candidate.pageTitle || "",
      nearImageText: candidate.nearImageText || "",
      alt: candidate.alt || ""
    }
  };
}

function normalizeOllama(value) {
  if (!value) return { status: "unchecked", confidence: 0, raw: null };
  const category = value.category || (value.isFloorplan ? "floorplan" : "other");
  return {
    status: value.status || "checked",
    category,
    isFloorplan: value.isFloorplan === true,
    isTopDownPlan: value.isTopDownPlan,
    hasRoomLabels: value.hasRoomLabels,
    hasWallsOrRoomBoundaries: value.hasWallsOrRoomBoundaries,
    confidence: Number(value.confidence ?? 0),
    reason: value.reason || "",
    raw: value
  };
}

function finalConfidenceFrom(visual, ollama) {
  if (ollama.status === "checked") return Math.min(1, Math.max(0, ollama.confidence * 0.8 + visual.visualScore * 0.2));
  return Math.min(0.84, visual.visualScore);
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

async function readOptionalJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return {};
  }
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
