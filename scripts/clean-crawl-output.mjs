#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";

const args = parseArgs(process.argv.slice(2));

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

async function main() {
  const inputPath = args.input ?? args.in ?? "crawler-output/latest-crawl.json";
  const outputPath = args.out ?? inputPath;
  const payload = JSON.parse(await readFile(inputPath, "utf8"));
  const beforeCandidates = payload.candidates?.length ?? 0;
  const beforeImages = countImages(payload.candidates ?? []);

  const candidates = (payload.candidates ?? [])
    .map((candidate) => {
      const images = (candidate.imageCandidates ?? []).filter((image) => !isHardRejectedImage(image));
      return {
        ...candidate,
        imageCandidates: images,
        imageUrlCandidates: images.map((image) => image.url),
        hasFloorplanImage: images.length > 0
      };
    })
    .filter((candidate) => candidate.hasFloorplanImage);

  const result = {
    ...payload,
    generatedAt: new Date().toISOString(),
    candidates,
    logs: [
      ...(payload.logs ?? []),
      {
        id: `log_clean_${Date.now()}`,
        createdAt: new Date().toISOString(),
        siteName: "clean-crawl-output",
        domain: "-",
        url: inputPath,
        action: "clean",
        result: "success",
        message: `Removed room/exterior image candidates. candidates ${beforeCandidates} -> ${candidates.length}, images ${beforeImages} -> ${countImages(candidates)}.`
      }
    ]
  };

  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(
    `Cleaned crawl output: candidates ${beforeCandidates} -> ${candidates.length}, images ${beforeImages} -> ${countImages(candidates)}`
  );
}

function countImages(candidates) {
  return candidates.reduce((total, candidate) => total + (candidate.imageCandidates?.length ?? 0), 0);
}

function isHardRejectedImage(image) {
  const signal = `${image.url || ""} ${image.thumbnailUrl || ""} ${image.alt || ""} ${image.title || ""}`;
  return (
    /logo|icon|banner|baner|og画像|ogimage|ogp|catalog|カタログ|無料プレゼント|main_img|bn[-_]|blog[-_]?card|thumb|childroom|laundryroom|genmai|rice|外観|外回り|外構|外装|外部|庭|駐車場|カーポート|アプローチ|エクステリア|内観|施工写真|写真のみ|リビング|キッチン|寝室|浴室|洗面|トイレ|子ども部屋|ランドリールーム|interior|exterior|facade|appearance|frontview|front-view|sideview|side-view|garden|parking|carport|hero|mainvisual/i.test(
      signal
    ) || /[|｜]\s*(?:LDK|リビング|ダイニング|キッチン|寝室|洋室|和室|子ども部屋|洗面|浴室|トイレ|玄関|外観|内観|室内)(?:\s|$)/i.test(signal)
  );
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
