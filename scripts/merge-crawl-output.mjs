#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const args = parseArgs(process.argv.slice(2));

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

async function main() {
  const basePath = args.base ?? args.out ?? "crawler-output/latest-crawl.json";
  const incomingPath = args.incoming ?? args.input;
  const outPath = args.out ?? basePath;
  if (!incomingPath) throw new Error("--incoming is required");

  const base = await readOptionalJson(basePath);
  const incoming = await readOptionalJson(incomingPath);
  const candidates = dedupeCandidates([...(base.candidates ?? []), ...(incoming.candidates ?? [])]).filter((candidate) => candidate.hasFloorplanImage);
  const result = {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: "local-crawler",
    candidates,
    logs: dedupeLogs([...(base.logs ?? []), ...(incoming.logs ?? [])])
  };

  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  const images = candidates.reduce((total, candidate) => total + (candidate.imageCandidates ?? []).length, 0);
  console.log(`Merged crawl output: candidates=${candidates.length} images=${images}`);
  console.log(`Output: ${outPath}`);
}

function dedupeCandidates(items) {
  const seen = new Set();
  return items.filter((item) => {
    const images = (item.imageCandidates ?? []).filter((image) => image?.url && isLikelyDisplayFloorplanImage(image));
    item.imageCandidates = images;
    item.imageUrlCandidates = images.map((image) => image.url);
    item.hasFloorplanImage = images.length > 0;
    const imageUrl = images[0]?.url || "";
    const key = `${item.sourceUrl || ""}:${imageUrl}`;
    if (!key.trim() || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isLikelyDisplayFloorplanImage(image) {
  if (looksDecorativeOrNonFloorplan(image)) return false;
  if (image.ollamaReview?.status === "checked" && image.ollamaReview.isFloorplan === false) return false;
  if (image.needsOllamaReview) return false;
  if (isOllamaAcceptedFloorplan(image)) return true;
  return hasStrongImageFloorplanSignal(image);
}

function isOllamaAcceptedFloorplan(image) {
  return image.ollamaReview?.status === "checked" && image.ollamaReview.isFloorplan === true && Number(image.ollamaReview.confidence ?? 0) >= 0.65;
}

function hasStrongImageFloorplanSignal(image) {
  const altSignal = `${image.alt || ""} ${image.title || ""}`;
  const fileSignal = imageFileSignal(image);
  const tailSignal = imageTailSignal(image);

  if (/間取り図|平面図|図面|プラン[0-9０-９]+.*間取り|間取り.*[12１２]階|floor\s*plan|floorplan/i.test(altSignal)) return true;
  if (/間取り/i.test(altSignal) && /[2-5]\s*LDK|[0-9]{2}\s*坪|平屋|二階建|2階建|プラン|家/i.test(altSignal)) return true;
  if (/madori|floor[-_]?plan|floor_plan|floorplan|layout|topview|top-view|zumen|drawing|heimen|hemen/i.test(fileSignal)) return true;
  if (/(?:^|[_-])plan[-_]?[0-9]+|collection_plan|madori_thm|N[0-9]+-[12]F/i.test(fileSignal)) return true;
  return /floor[-_]?plan/i.test(tailSignal) && /map[0-9]|plan|layout/i.test(fileSignal);
}

function looksDecorativeOrNonFloorplan(image) {
  const signal = `${image.url || ""} ${image.thumbnailUrl || ""} ${image.alt || ""} ${image.title || ""} ${imagePathSignal(image)}`;
  return (
    /logo|ロゴ|icon|ico[-_]|avatar|profile|staff|banner|baner|バナー|og画像|ogimage|ogp|catalog|カタログ|main_img|bn[-_]|bnr|blog[-_]?card|thumb|thumbnail|ranking|ランキング|月間ランキング|no[0-9]+__title|selected|pbmce|chart|graph|subnavi|nav[-_]|img_nav|youtube|ytimg|sddefault|hqdefault|mqdefault|img01\.suumo\.com\/front\/gazo\/chumon\/.+\/main\/[^/]+p[0-9]+|txt[-_]|takusan|hajimete|prev[-_]image|next[-_]image|point[-_]|childroom|laundryroom|genmai|rice|外観|外回り|外構|外装|外部|庭|駐車場|カーポート|アプローチ|エクステリア|内観|施工写真|写真のみ|リビング|キッチン|寝室|浴室|洗面|トイレ|frontview|front-view|sideview|side-view|facade|exterior|appearance|interior|garden|parking|carport|mainvisual|hero|features?_img|feature_img/i.test(
      signal
    ) || /[|｜]\s*(?:LDK|リビング|ダイニング|キッチン|寝室|洋室|和室|子ども部屋|洗面|浴室|トイレ|玄関|外観|内観|室内)(?:\s|$)/i.test(signal)
  );
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

function dedupeLogs(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = item.id || `${item.createdAt}:${item.siteName}:${item.url}:${item.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
    if (!next || next.startsWith("--")) {
      result[key] = true;
    } else {
      result[key] = next;
      i += 1;
    }
  }
  return result;
}
