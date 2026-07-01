#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { readJsonl } from "./lib/jsonl-store.mjs";

const args = parseArgs(process.argv.slice(2));

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

async function main() {
  const input = args.input ?? "data/accepted-floorplans.jsonl";
  const out = args.out ?? "public/data/floorplans.json";
  const statsOut = args.statsOut ?? "public/data/floorplan-stats.json";
  const accepted = (await readJsonl(input)).filter((record) => record.status === "accepted");
  const now = new Date().toISOString();
  const groupedAccepted = groupAcceptedRecords(accepted);
  const candidates = groupedAccepted.map(toCrawlCandidate);
  const payload = {
    version: 2,
    generatedAt: now,
    source: "accepted-floorplans",
    candidates,
    logs: [
      {
        id: `accepted_public_${Date.now()}`,
        createdAt: now,
        siteName: "accepted-floorplans",
        domain: "-",
        url: input,
        action: "候補保存",
        result: "成功",
        message: `Accepted floorplan images: ${accepted.length}. Public plan groups: ${candidates.length}.`
      }
    ]
  };
  const stats = buildStats(accepted, candidates, now);
  await mkdir(path.dirname(out), { recursive: true });
  await mkdir(path.dirname(statsOut), { recursive: true });
  await writeFile(out, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await writeFile(statsOut, `${JSON.stringify(stats, null, 2)}\n`, "utf8");
  console.log(`Built public floorplans: ${accepted.length} images -> ${candidates.length} groups -> ${out}`);
}

function groupAcceptedRecords(records) {
  const groups = new Map();
  for (const record of records) {
    const key = acceptedGroupKey(record);
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => group.sort(compareFloorRecords));
}

function acceptedGroupKey(record) {
  const imageUrl = record.source?.imageUrl || "";
  const splitImageKey = floorSplitImageGroupKey(imageUrl);
  if (splitImageKey) return `image:${record.source?.sourceDomain || ""}:${splitImageKey}`;

  const sequenceKey = floorSequenceGroupKey(record);
  if (sequenceKey) return `sequence:${record.source?.sourceDomain || ""}:${sequenceKey}`;

  const pageImageKey = pageImageGroupKey(record);
  if (pageImageKey) return `page-image:${record.source?.sourceDomain || ""}:${pageImageKey}`;

  const detailPageKey = detailPageFloorGroupKey(record);
  if (detailPageKey) return `detail-page:${record.source?.sourceDomain || ""}:${detailPageKey}`;

  return `record:${record.id}`;
}

function floorSplitImageGroupKey(rawUrl) {
  const normalized = normalizeUrl(rawUrl);
  if (!normalized) return "";
  const extensionPattern = /\.(?:jpe?g|png|webp|gif)$/i;
  let grouped = normalized
    .replace(/-\d+x\d+(?=\.(?:jpe?g|png|webp|gif)$)/i, "")
    .replace(/(_heimen)[0-9]+(?=\.(?:jpe?g|png|webp|gif)$)/i, "$1")
    .replace(/(plan[0-9]+)-img0[23](?=\.(?:jpe?g|png|webp|gif)$)/i, "$1-img")
    .replace(/(\/case\/[^/]+\/images\/img_plan_)0?[1-3](?:_sp)?(?=\.(?:jpe?g|png|webp|gif)$)/i, "$1floor")
    .replace(/([_-])(?:[1-3]|[1-3]f|[1-3]F|[１２３]|[１２３]f|[１２３]F|[一二三]階|[1-3]階)(?=\.(?:jpe?g|png|webp|gif)$)/i, "");

  if (grouped === normalized) return "";
  if (!extensionPattern.test(grouped)) return "";
  if (!/madori|floor[-_]?plan|floorplan|floor_plan|heimen|zumen|drawing|collection_plan|topview|plan|間取り|間取|平面|図面/i.test(grouped)) return "";
  return grouped;
}

function floorSequenceGroupKey(record) {
  const pageUrl = normalizeUrl(record.source?.pageUrl || "");
  const imageUrl = normalizeUrl(record.source?.imageUrl || "");
  const floor = floorOrder(record);
  if (!pageUrl || floor >= 9) return "";

  const sfcMatch = imageUrl.match(/\/ie\/myhome\/img\/([0-9]+)_([0-9]+)\.(?:jpe?g|png|webp)$/i);
  if (sfcMatch) {
    const imageNumber = Number(sfcMatch[2]);
    if (!Number.isFinite(imageNumber)) return "";
    const floorOffset = floor === 1.5 ? 1 : Math.max(0, Math.floor(floor) - 1);
    const groupStart = imageNumber - floorOffset;
    return `${pageUrl}:sfc-${sfcMatch[1]}-${groupStart}`;
  }

  if (/cleverlyhome\.com\/kurashi\/plan\//i.test(pageUrl)) {
    const layout = record.metadata?.layout?.value || "layout-unknown";
    const area = record.metadata?.totalFloorAreaSqm?.value ? Number(record.metadata.totalFloorAreaSqm.value).toFixed(2) : "area-unknown";
    const title = normalizePlanTitleBase(record.title || record.context?.alt || "");
    return `${pageUrl}:${layout}:${area}:${title || "floorplan"}`;
  }

  return "";
}

function pageImageGroupKey(record) {
  const pageUrl = normalizeUrl(record.source?.pageUrl || "");
  const imageUrl = normalizeUrl(record.source?.imageUrl || "");
  if (!pageUrl || !imageUrl) return "";

  const forumuPlanPage = pageUrl.match(/forumu\.co\.jp\/madori\/madori-([0-9]+)\.html$/i);
  const forumuImage = imageUrl.match(/\/(?:[^/]+\/)?(madori[_-][0-9]+)\.(?:jpe?g|png|webp)$/i);
  if (forumuPlanPage && forumuImage) return `${pageUrl}:${forumuImage[1]}`;

  return "";
}

function detailPageFloorGroupKey(record) {
  const pageUrl = normalizeUrl(record.source?.pageUrl || "");
  if (!pageUrl || floorOrder(record) >= 9) return "";
  if (/\/case\/[^/?#]+\/?$/i.test(pageUrl) || /\/works?\/[^/?#]+\/?$/i.test(pageUrl)) {
    return pageUrl;
  }
  return "";
}

function compareFloorRecords(a, b) {
  return floorOrder(a) - floorOrder(b) || String(a.source?.imageUrl || "").localeCompare(String(b.source?.imageUrl || ""));
}

function floorOrder(record) {
  const signal = `${record.title || ""} ${record.context?.alt || ""} ${record.source?.imageUrl || ""}`;
  return floorOrderFromSignal(signal);
}

function floorOrderFromImage(image) {
  return floorOrderFromSignal(`${image.alt || ""} ${image.url || ""}`);
}

function floorOrderFromSignal(signal) {
  if (/be-enough\.jp\/.+\/plan[0-9]+-img02(?:-\d+x\d+)?\.(?:jpe?g|png|webp)/i.test(signal)) return 1;
  if (/be-enough\.jp\/.+\/plan[0-9]+-img03(?:-\d+x\d+)?\.(?:jpe?g|png|webp)/i.test(signal)) return 2;
  if (/(?:^|[^0-9０-９])(?:1|１|一)階(?:部分|間取り)|(?:^|[^0-9０-９])(?:1|１|一)F(?:\s|$)/i.test(signal)) return 1;
  if (/(?:1\.5|１\.５)階(?:部分|間取り)|(?:1\.5|１\.５)F(?:\s|$)/i.test(signal)) return 1.5;
  if (/(?:^|[^0-9０-９])(?:2|２|二)階(?:部分|間取り)|(?:^|[^0-9０-９])(?:2|２|二)F(?:\s|$)/i.test(signal)) return 2;
  if (/(?:^|[^0-9０-９])(?:3|３|三)階(?:部分|間取り)|(?:^|[^0-9０-９])(?:3|３|三)F(?:\s|$)/i.test(signal)) return 3;
  if (/1\.5階|１\.５階/.test(signal)) return 1.5;
  if (/(?:^|[_-])1f|(?:^|[_-])1F|1階|１階|一階|_heimen1|-[1１](?=\.)/.test(signal)) return 1;
  if (/(?:^|[_-])2f|(?:^|[_-])2F|2階|２階|二階|_heimen2|-[2２](?=\.)/.test(signal)) return 2;
  if (/(?:^|[_-])3f|(?:^|[_-])3F|3階|３階|三階|_heimen3|-[3３](?=\.)/.test(signal)) return 3;
  return 9;
}

function toCrawlCandidate(group) {
  const record = group[0];
  const imageCandidates = addCompanionImages(group.map((item, index) => toImageCandidate(item, index)));
  const layout = record.metadata?.layout?.value || inferLayoutFromGroup(group);
  const floors = record.metadata?.floors?.value || inferFloorsFromImages(imageCandidates, group);
  return {
    id: group.length > 1 ? `group:${acceptedGroupKey(record)}` : record.id,
    title: displayTitle(group),
    listingSource: `accepted ${record.source?.sourceDomain || ""}`.trim(),
    sourceUrl: record.source?.pageUrl || "",
    company: record.source?.companyName || record.source?.sourceDomain || "",
    priceManYen: record.metadata?.price?.value || undefined,
    layout,
    areaSqm: record.metadata?.totalFloorAreaSqm?.value || undefined,
    tsubo: record.metadata?.totalFloorAreaSqm?.value ? Number((record.metadata.totalFloorAreaSqm.value / 3.305785).toFixed(2)) : undefined,
    floors,
    entranceDirection: record.metadata?.entranceDirection?.value || "",
    hasFloorplanImage: true,
    imageUrlCandidates: imageCandidates.map((image) => image.url).filter(Boolean),
    imageCandidates,
    fetchedAt: maxDate(group.map((item) => item.lastSeenAt || item.firstSeenAt)),
    errorInfo: "",
    memo: group.length > 1
      ? `accepted-floorplans.jsonl から生成。${group.length}枚の階別画像を同じプランにまとめています。`
      : "accepted-floorplans.jsonl から生成"
  };
}

function inferLayoutFromGroup(group) {
  const text = group
    .map((record) => [
      record.title,
      record.context?.alt,
      record.context?.caption,
      record.context?.nearImageText,
      record.context?.sourceSnippet
    ].filter(Boolean).join(" "))
    .join(" ");
  const match = text.match(/[1-7]\s*S?\s*LDK|[1-7]\s*DK/i);
  return match ? match[0].replace(/\s+/g, "").toUpperCase() : "";
}

function inferFloorsFromImages(images, group) {
  const text = group
    .map((record) => `${record.title || ""} ${record.context?.alt || ""} ${record.context?.nearImageText || ""}`)
    .join(" ");
  if (/平屋/.test(text)) return "平屋";

  const orders = new Set(images.map(floorOrderFromImage).filter((value) => value < 9));
  if (orders.has(3)) return "3階建て";
  if (orders.has(1.5)) return "1.5階建て";
  if (orders.has(1) && orders.has(2)) return "2階建";
  if (/3階|三階|3F/i.test(text)) return "3階建て";
  if (/2階|二階|2F/i.test(text)) return "2階建";
  return "";
}

function addCompanionImages(images) {
  const byUrl = new Set(images.map((image) => normalizeUrl(image.url)));
  const next = [];

  for (const image of images) {
    const toyotaSecondFloor = String(image.url || "").match(
      /^(https:\/\/www\.toyotahome\.co\.jp\/housing\/howto\/madori\/design\/assets\/img\/floorplan\/)([0-9]+)_heimen2(\.webp)$/i
    );
    if (toyotaSecondFloor) {
      const firstFloorUrl = `${toyotaSecondFloor[1]}${toyotaSecondFloor[2]}_heimen1${toyotaSecondFloor[3]}`;
      const firstFloorKey = normalizeUrl(firstFloorUrl);
      if (!byUrl.has(firstFloorKey)) {
        next.push({
          ...image,
          id: `${image.id}:companion-1f`,
          url: firstFloorUrl,
          alt: image.alt.replace(/2階/g, "1階") || "1階の間取り図",
          ollamaReview: {
            ...image.ollamaReview,
            model: "accepted-pipeline-companion",
            confidence: Math.max(0.85, Number(image.ollamaReview?.confidence ?? 0.85)),
            reason: "ToyotaHome same plan companion floor image"
          }
        });
        byUrl.add(firstFloorKey);
      }
    }
    next.push(image);
  }

  return next.sort((a, b) => floorOrderFromImage(a) - floorOrderFromImage(b) || String(a.url || "").localeCompare(String(b.url || "")));
}

function toImageCandidate(record, index) {
  return {
    id: `${record.id}:image`,
    kind: "floorplan",
    url: record.source?.imageUrl || "",
    alt: imageAlt(record, index),
    sourceUrl: record.source?.pageUrl || "",
    ollamaReview: {
      status: "checked",
      model: "accepted-pipeline",
      isFloorplan: true,
      confidence: record.classification?.finalConfidence ?? 0.85,
      reason: "accepted-floorplans only"
    }
  };
}

function imageAlt(record, index) {
  const floor = floorOrder(record);
  const floorLabel = floor === 1 ? "1階" : floor === 1.5 ? "1.5階" : floor === 2 ? "2階" : floor === 3 ? "3階" : "";
  const title = record.context?.alt || record.title || "間取り図";
  if (!floorLabel) return title;
  return title.includes(floorLabel) ? title : `${title} ${floorLabel}`;
}

function displayTitle(group) {
  const first = group[0];
  if (group.length === 1) return first.title || "間取り図";
  const titleCandidates = [
    first.title,
    first.context?.alt,
    first.context?.caption,
    first.context?.pageTitle,
    ...group.map((record) => record.title)
  ]
    .map((value) => normalizePlanTitleBase(value || ""))
    .map((value) => value.replace(/\s*[｜|].*$/, "").trim())
    .filter((value) => value && !isGenericPlanTitle(value));
  return titleCandidates[0] || normalizePlanTitleBase(first.context?.pageTitle || "") || "間取り図";
}

function normalizePlanTitleBase(value) {
  return normalizeWhitespace(value || "")
    .replace(/[（(【\[]\s*(?:1\.5階|１\.５階|[1-3１２３]\s*(?:階|F|f)|[一二三]階)(?:部分)?\s*[）)】\]]/g, " ")
    .replace(/の(?:1\.5階|１\.５階|[1-3１２３]\s*階|[一二三]階)部分/g, "")
    .replace(/(?:1\.5階|１\.５階|[1-3１２３]\s*階|[一二三]階)部分/g, "")
    .replace(/(間取り図?)\s*(?:[1-3]F|[1-3]f)$/g, "$1")
    .replace(/\s+(?:[1-3]F|[1-3]f)$/g, "")
    .replace(/の部分/g, "")
    .replace(/^(?:1\.5階|１\.５階|[1-3１２３]\s*階|[一二三]階)の間取り$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isGenericPlanTitle(value) {
  const normalized = normalizeWhitespace(value);
  return !normalized || /^(?:間取り|間取り図|平面図|の間取り|imgsrc[0-9_]+)$/i.test(normalized);
}

function buildStats(records, candidates, generatedAt) {
  const byDomain = {};
  for (const record of records) {
    const domain = record.source?.sourceDomain || "unknown";
    byDomain[domain] ??= { acceptedCount: 0 };
    byDomain[domain].acceptedCount += 1;
  }
  return {
    generatedAt,
    acceptedCount: records.length,
    publicCandidateCount: candidates.length,
    multiImageCandidateCount: candidates.filter((candidate) => (candidate.imageCandidates || []).length > 1).length,
    domains: byDomain
  };
}

function normalizeUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().toLowerCase();
  } catch {
    return String(value || "").split(/[?#]/)[0].toLowerCase();
  }
}

function normalizeWhitespace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function maxDate(values) {
  return values.filter(Boolean).sort().at(-1) || new Date().toISOString();
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
