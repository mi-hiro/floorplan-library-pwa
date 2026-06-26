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
    const images = (item.imageCandidates ?? []).filter((image) => image?.url && !looksDecorative(image));
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

function looksDecorative(image) {
  return /logo|icon|ico[-_]|banner|baner|og画像|ogimage|ogp|catalog|カタログ|main_img|bn[-_]|blog[-_]?card|thumb|txt[-_]|takusan|hajimete|prev[-_]image|next[-_]image|point[-_]|childroom|laundryroom|genmai|rice|外観|外回り|外構|外装|外部|庭|駐車場|カーポート|アプローチ|エクステリア|内観|施工写真|写真のみ|リビング|キッチン|寝室|浴室|洗面|トイレ|frontview|front-view|sideview|side-view|facade|exterior|appearance|interior|garden|parking|carport|mainvisual|hero/i.test(
    `${image.url || ""} ${image.alt || ""}`
  );
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
