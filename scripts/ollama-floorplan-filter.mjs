#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const args = parseArgs(process.argv.slice(2));
const logs = [];

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

async function main() {
  const configPath = args.config ?? "ollama-filter.config.json";
  const inputPath = args.input ?? args.in ?? path.join("crawler-output", "latest-crawl.json");
  const outputPath = args.out ?? inputPath;
  const config = await readOptionalJson(configPath);
  if (config.enabled === false || parseBool(args.enabled, true) === false) {
    console.log("Ollama filter is disabled.");
    return;
  }

  const payload = await readOptionalJson(inputPath);
  const candidates = payload.candidates ?? [];
  const endpoint = String(args.endpoint ?? config.endpoint ?? "http://127.0.0.1:11434").replace(/\/$/, "");
  const model = await resolveVisionModel(endpoint, config);
  if (!model) {
    const result = appendLogs(payload, logs);
    await writeJson(outputPath, result);
    console.log("Ollama vision model is not available. Kept existing candidates unchanged.");
    return;
  }

  const maxImages = Number(args.maxImages ?? config.maxImages ?? 80);
  const minConfidence = Number(args.minConfidence ?? config.minConfidence ?? 0.65);
  const keepUnchecked = parseBool(args.keepUnchecked ?? config.keepUnchecked, true);
  const removeRejected = parseBool(args.removeRejected ?? config.removeRejected, true);
  const requestDelayMs = Number(args.requestDelayMs ?? config.requestDelayMs ?? 700);
  const fetchTimeoutMs = Number(args.fetchTimeoutSeconds ?? config.fetchTimeoutSeconds ?? 20) * 1000;
  const ollamaTimeoutMs = Number(args.ollamaTimeoutSeconds ?? config.ollamaTimeoutSeconds ?? 60) * 1000;
  const maxImageBytes = Number(args.maxImageBytes ?? config.maxImageBytes ?? 3000000);
  const checkpointEveryCandidates = Number(args.checkpointEveryCandidates ?? config.checkpointEveryCandidates ?? 1);
  const checkpointEveryImages = Number(args.checkpointEveryImages ?? config.checkpointEveryImages ?? 1);
  const reviewKeys = buildReviewKeySet(candidates, maxImages);
  let checked = 0;

  const filteredCandidates = [];
  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
    const candidate = candidates[candidateIndex];
    const candidateImages = candidate.imageCandidates ?? [];
    const filteredImages = [];
    for (let imageIndex = 0; imageIndex < candidateImages.length; imageIndex += 1) {
      const image = candidateImages[imageIndex];
      if (image.ollamaReview?.status === "checked") {
        if (image.ollamaReview.isFloorplan !== false || !removeRejected) filteredImages.push(image);
        continue;
      }
      if (!reviewKeys.has(imageKey(image))) {
        if (keepUnchecked) filteredImages.push(image);
        continue;
      }

      const review = await reviewImage(endpoint, model, image, { fetchTimeoutMs, ollamaTimeoutMs, maxImageBytes });
      checked += 1;
      if (requestDelayMs > 0) await wait(requestDelayMs);

      if (review.status !== "checked") {
        if (keepUnchecked) filteredImages.push({ ...image, ollamaReview: review });
        continue;
      }

      const accepted = review.isFloorplan && review.confidence >= minConfidence && !isHardRejectedImageSignal(image);
      if (accepted || !removeRejected) {
        filteredImages.push({ ...image, ollamaReview: review });
      } else {
        addLog("Ollama", image.url, "image-review", "rejected", review.reason || "Rejected as non-floorplan");
      }

      if (checkpointEveryImages > 0 && checked > 0 && checked % checkpointEveryImages === 0) {
        const partialCandidate = makeCandidateWithImages(candidate, [...filteredImages, ...candidateImages.slice(imageIndex + 1)]);
        await writeCheckpoint(outputPath, payload, [...filteredCandidates, partialCandidate], candidates.slice(candidateIndex + 1), logs);
      }
    }

    const nextCandidate = makeCandidateWithImages(candidate, filteredImages, checked > 0 ? `Ollama reviewed with ${model}.` : "");
    if (nextCandidate.hasFloorplanImage || keepUnchecked) filteredCandidates.push(nextCandidate);

    if (checkpointEveryCandidates > 0 && checked > 0 && (candidateIndex + 1) % checkpointEveryCandidates === 0) {
      await writeCheckpoint(outputPath, payload, filteredCandidates, candidates.slice(candidateIndex + 1), logs);
    }
  }

  const result = appendLogs(
    {
      ...payload,
      generatedAt: new Date().toISOString(),
      candidates: filteredCandidates
    },
    logs
  );
  await writeJson(outputPath, result);
  console.log(`Ollama filter finished: checked ${checked} images / candidates ${filteredCandidates.length}`);
  console.log(`Output: ${outputPath}`);
}

function makeCandidateWithImages(candidate, images, memoAddition = "") {
  return {
    ...candidate,
    imageCandidates: images,
    imageUrlCandidates: images.map((image) => image.url),
    hasFloorplanImage: images.length > 0,
    memo: appendMemo(candidate.memo, memoAddition)
  };
}

async function writeCheckpoint(outputPath, payload, filteredCandidates, remainingCandidates, newLogs) {
  const result = appendLogs(
    {
      ...payload,
      generatedAt: new Date().toISOString(),
      candidates: [...filteredCandidates, ...remainingCandidates]
    },
    newLogs
  );
  await writeJson(outputPath, result);
}

async function resolveVisionModel(endpoint, config) {
  try {
    const response = await fetchWithTimeout(`${endpoint}/api/tags`, {}, 5000);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const models = (payload.models ?? []).map((model) => model.name).filter(Boolean);
    const requested = config.model || "llama3.2-vision:latest";
    if (models.includes(requested)) {
      addLog("Ollama", endpoint, "model", "success", `Using ${requested}`);
      return requested;
    }
    const fallbackNeedles = config.fallbackVisionModels ?? ["llama3.2-vision", "llava", "minicpm-v", "moondream", "bakllava"];
    const fallback = models.find((name) => fallbackNeedles.some((needle) => name.toLowerCase().includes(String(needle).toLowerCase())));
    if (fallback) {
      addLog("Ollama", endpoint, "model", "success", `Using ${fallback}`);
      return fallback;
    }
    addLog("Ollama", endpoint, "model", "skipped", "No local vision model found");
    return "";
  } catch (error) {
    addLog("Ollama", endpoint, "model", "skipped", `Ollama is not reachable: ${error.message}`);
    return "";
  }
}

async function reviewImage(endpoint, model, image, settings) {
  const imageUrl = image.url;
  try {
    const base64 = await fetchImageBase64(imageUrl, settings.fetchTimeoutMs, settings.maxImageBytes);
    const prompt = [
      "You are classifying real-estate images.",
      "Return strict JSON only. Do not include markdown.",
      "Classify the image into exactly one category: floorplan, site_plan_only, exterior_photo, interior_photo, kitchen_photo, bathroom_photo, bedroom_photo, living_room_photo, 3d_render, map, chart, banner, logo, youtube_thumbnail, other.",
      "A valid floorplan must be a top-down architectural plan of a house or apartment.",
      "It usually contains rooms, walls, doors, stairs, labels, dimensions, or room names.",
      "Reject exterior photos, interior photos, perspective renderings, maps, banners, thumbnails, logos, charts, decorative images, and photographs.",
      "Important: If the image is only an exterior or interior photo, isFloorplan must be false.",
      "Important: If the page context says floor plan but the image itself is a photo, isFloorplan must be false.",
      "Important: If unsure, use confidence below 0.85.",
      "Return: {\"category\":\"...\",\"isFloorplan\":true,\"isTopDownPlan\":true,\"hasRoomLabels\":true,\"hasWallsOrRoomBoundaries\":true,\"visibleRooms\":[\"LDK\"],\"confidence\":0.0,\"reason\":\"short reason\"}"
    ].join(" ");
    const response = await fetchWithTimeout(
      `${endpoint}/api/generate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          prompt,
          images: [base64],
          stream: false,
          options: { temperature: 0 }
        })
      },
      settings.ollamaTimeoutMs
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const parsed = parseReview(payload.response || "");
    addLog("Ollama", imageUrl, "image-review", parsed.isFloorplan ? "accepted" : "rejected", parsed.reason);
    return { status: "checked", model, ...parsed };
  } catch (error) {
    addLog("Ollama", imageUrl, "image-review", "skipped", error.message);
    return { status: "unchecked", model, reason: error.message };
  }
}

async function fetchImageBase64(url, timeoutMs, maxImageBytes) {
  const response = await fetchWithTimeout(
    url,
    {
      headers: {
        accept: "image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8"
      }
    },
    timeoutMs
  );
  if (!response.ok) throw new Error(`image HTTP ${response.status}`);
  const contentType = response.headers.get("content-type") || "";
  if (contentType && !contentType.startsWith("image/")) throw new Error(`not an image response: ${contentType}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > maxImageBytes) throw new Error(`image too large: ${buffer.byteLength}`);
  return buffer.toString("base64");
}

function parseReview(text) {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        category: String(parsed.category ?? (parsed.isFloorplan ? "floorplan" : "other")),
        isFloorplan: Boolean(parsed.isFloorplan),
        isTopDownPlan: parsed.isTopDownPlan === true,
        hasRoomLabels: parsed.hasRoomLabels === true,
        hasWallsOrRoomBoundaries: parsed.hasWallsOrRoomBoundaries === true,
        visibleRooms: Array.isArray(parsed.visibleRooms) ? parsed.visibleRooms.slice(0, 12).map(String) : [],
        confidence: clampConfidence(parsed.confidence),
        reason: String(parsed.reason ?? "").slice(0, 180)
      };
    } catch {
      // Fall through to yes/no parsing.
    }
  }
  const isFloorplan = /\btrue\b|yes|floor plan|blueprint|layout|間取り|平面図/i.test(text) && !/\bfalse\b|not a|photo|logo|icon/i.test(text);
  return {
    category: isFloorplan ? "floorplan" : "other",
    isFloorplan,
    isTopDownPlan: isFloorplan,
    hasRoomLabels: false,
    hasWallsOrRoomBoundaries: isFloorplan,
    visibleRooms: [],
    confidence: isFloorplan ? 0.7 : 0.3,
    reason: text.replace(/\s+/g, " ").trim().slice(0, 180)
  };
}

function clampConfidence(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
}

function buildReviewKeySet(candidates, maxImages) {
  if (maxImages <= 0) return new Set();
  const items = [];
  let order = 0;
  for (const candidate of candidates) {
    for (const image of candidate.imageCandidates ?? []) {
      if (image.ollamaReview?.status === "checked") continue;
      items.push({ key: imageKey(image), priority: imageReviewPriority(image), order });
      order += 1;
    }
  }
  return new Set(
    items
      .filter((item) => item.key)
      .sort((a, b) => a.priority - b.priority || a.order - b.order)
      .slice(0, maxImages)
      .map((item) => item.key)
  );
}

function imageReviewPriority(image) {
  if (image.ollamaReview?.status === "checked") return 4;
  if (image.needsOllamaReview || image.reviewReason) return 0;
  if (isHardRejectedImageSignal(image)) return 5;
  if (looksLikeStrongPlanSignal(image)) return 1;
  if (!image.ollamaReview) return 2;
  return 2;
}

function looksLikeStrongPlanSignal(image) {
  const altSignal = `${image.alt || ""} ${image.title || ""}`;
  const fileSignal = imageFileSignal(image);
  const tailSignal = imageTailSignal(image);

  if (/間取り図|平面図|図面|プラン[0-9０-９]+.*間取り|間取り.*[12１２]階|floor\s*plan|floorplan/i.test(altSignal)) return true;
  if (/間取り/i.test(altSignal) && /[2-5]\s*LDK|[0-9]{2}\s*坪|平屋|二階建|2階建|プラン|家/i.test(altSignal)) return true;
  if (/madori|floor[-_]?plan|floor_plan|floorplan|layout|topview|top-view|zumen|drawing|heimen|hemen/i.test(fileSignal)) return true;
  if (/(?:^|[_-])plan[-_]?[0-9]+|collection_plan|madori_thm|N[0-9]+-[12]F/i.test(fileSignal)) return true;
  return /floor[-_]?plan/i.test(tailSignal) && /map[0-9]|plan|layout/i.test(fileSignal);
}

function isHardRejectedImageSignal(image) {
  const signal = `${imageSignalText(image)} ${imagePathSignal(image)}`;
  return (
    /logo|ロゴ|icon|avatar|profile|staff|banner|baner|バナー|campaign|キャンペーン|gift|ギフト|catalog|カタログ|無料プレゼント|og画像|ogimage|ogp|blog[-_]?card|thumb|thumbnail|ranking|ランキング|月間ランキング|no[0-9]+__title|selected|pbmce|chart|graph|subnavi|nav[-_]|img_nav|main_img|bn[-_]|bnr|youtube|ytimg|sddefault|hqdefault|mqdefault|img01\.suumo\.com\/front\/gazo\/chumon\/.+\/main\/[^/]+p[0-9]+|childroom|laundryroom|genmai|rice|外観|外回り|外構|外装|外部|庭|駐車場|カーポート|アプローチ|エクステリア|内観|施工写真|写真のみ|リビング|キッチン|寝室|浴室|洗面|トイレ|子ども部屋|ランドリールーム|interior|exterior|facade|appearance|frontview|front-view|sideview|side-view|garden|parking|carport|hero|mainvisual|features?_img|feature_img|point_img/i.test(
      signal
    ) || /[|｜]\s*(?:LDK|リビング|ダイニング|キッチン|寝室|洋室|和室|子ども部屋|洗面|浴室|トイレ|玄関|外観|内観|室内)(?:\s|$)/i.test(signal)
  );
}

function imageSignalText(image) {
  return `${image.url || ""} ${image.alt || ""} ${image.title || ""}`;
}

function imageFileSignal(image) {
  const primary = getUrlSignalParts(image.url);
  const thumbnail = getUrlSignalParts(image.thumbnailUrl || "");
  return `${image.alt || ""} ${image.title || ""} ${primary.fileName} ${thumbnail.fileName}`.toLowerCase();
}

function imageTailSignal(image) {
  const primary = getUrlSignalParts(image.url);
  const thumbnail = getUrlSignalParts(image.thumbnailUrl || "");
  return `${primary.parentName}/${primary.fileName} ${thumbnail.parentName}/${thumbnail.fileName}`.toLowerCase();
}

function imagePathSignal(image) {
  return `${getUrlSignalParts(image.url).pathName} ${getUrlSignalParts(image.thumbnailUrl || "").pathName}`.toLowerCase();
}

function getUrlSignalParts(url) {
  try {
    const parsed = new URL(url);
    const pathName = decodeURIComponent(parsed.pathname);
    const segments = pathName.split("/").filter(Boolean);
    const fileName = segments[segments.length - 1] || "";
    const parentName = segments[segments.length - 2] || "";
    return { pathName, fileName, parentName };
  } catch {
    return { pathName: url || "", fileName: url || "", parentName: "" };
  }
}

function imageKey(image) {
  return image.id || image.url || "";
}

async function fetchWithTimeout(url, init = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function readOptionalJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return {};
  }
}

async function writeJson(filePath, payload) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function appendLogs(payload, newLogs) {
  return {
    ...payload,
    logs: dedupeLogs([...(payload.logs ?? []), ...newLogs])
  };
}

function appendMemo(memo, addition) {
  if (!addition) return memo || "";
  if ((memo || "").includes(addition)) return memo || "";
  return `${memo || ""}${memo ? " " : ""}${addition}`.trim();
}

function dedupeLogs(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = item.id || `${item.createdAt}:${item.siteName}:${item.url}:${item.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function addLog(siteName, url, action, result, message) {
  logs.push({
    id: `log_${crypto.randomUUID()}`,
    createdAt: new Date().toISOString(),
    siteName,
    domain: safeHostname(url),
    url,
    action,
    result,
    message
  });
  console.log(`[${siteName}] ${action} ${result}: ${message}`);
}

function safeHostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "-";
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      result[key] = true;
    } else {
      result[key] = next;
      i += 1;
    }
  }
  return result;
}

function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return !/^(false|0|no|off)$/i.test(String(value));
}
