import type { CrawlLog, CrawlSite, FloorPlanProperty } from "../types";
import { calculateTsubo, makeId, nowIso } from "../utils/format";
import { getAllItems, putMany } from "./db";

export async function ensureDefaultSites() {
  const existing = await getAllItems("sites");
  if (existing.length > 0) return;

  const createdAt = nowIso();
  const majorPortalDefaults: CrawlSite[] = [
    {
      id: "site_suumo",
      siteName: "SUUMO",
      domain: "suumo.jp",
      searchUrl: "",
      enabled: false,
      crawlMode: "manualOnly",
      perRunLimit: 3,
      perDayLimit: 3,
      delaySeconds: 180,
      recrawlIntervalDays: 30,
      robotsStatus: "unchecked",
      sitemapUrl: "",
      imageAutoFetch: false,
      imageSaveMode: "none",
      majorPortal: true,
      stopped: false,
      stopReason: "",
      notes: "大手ポータルは初期OFF。原則は元ページ確認と手動画像追加。",
      createdAt,
      updatedAt: createdAt
    },
    {
      id: "site_athome",
      siteName: "アットホーム",
      domain: "athome.co.jp",
      searchUrl: "",
      enabled: false,
      crawlMode: "manualOnly",
      perRunLimit: 3,
      perDayLimit: 3,
      delaySeconds: 180,
      recrawlIntervalDays: 30,
      robotsStatus: "unchecked",
      sitemapUrl: "",
      imageAutoFetch: false,
      imageSaveMode: "none",
      majorPortal: true,
      stopped: false,
      stopReason: "",
      notes: "CAPTCHA、ログイン要求、403、429を検出したら停止する前提。",
      createdAt,
      updatedAt: createdAt
    },
    {
      id: "site_homes",
      siteName: "HOME'S",
      domain: "homes.co.jp",
      searchUrl: "",
      enabled: false,
      crawlMode: "manualOnly",
      perRunLimit: 3,
      perDayLimit: 3,
      delaySeconds: 180,
      recrawlIntervalDays: 30,
      robotsStatus: "unchecked",
      sitemapUrl: "",
      imageAutoFetch: false,
      imageSaveMode: "none",
      majorPortal: true,
      stopped: false,
      stopReason: "",
      notes: "画像本体の自動保存は初期OFF。",
      createdAt,
      updatedAt: createdAt
    }
  ];

  await putMany("sites", majorPortalDefaults);
}

function sampleFloorplanSvg(title: string, accent: string) {
  const encodedTitle = title.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `data:image/svg+xml;utf8,${encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" width="960" height="680" viewBox="0 0 960 680">
      <rect width="960" height="680" fill="#fbfdff"/>
      <rect x="72" y="58" width="816" height="560" fill="#ffffff" stroke="#22384a" stroke-width="10"/>
      <path d="M72 236h816M72 428h326M398 236v382M636 58v370M398 428h490" fill="none" stroke="#22384a" stroke-width="7"/>
      <path d="M636 236h252M224 58v178M224 428v190M72 428h152" fill="none" stroke="${accent}" stroke-width="7"/>
      <text x="110" y="154" font-family="Arial, sans-serif" font-size="34" fill="#22384a">LDK 18.0</text>
      <text x="680" y="154" font-family="Arial, sans-serif" font-size="31" fill="#22384a">主寝室</text>
      <text x="112" y="338" font-family="Arial, sans-serif" font-size="31" fill="#22384a">水回り</text>
      <text x="462" y="338" font-family="Arial, sans-serif" font-size="31" fill="#22384a">収納</text>
      <text x="672" y="538" font-family="Arial, sans-serif" font-size="31" fill="#22384a">子供室</text>
      <text x="108" y="540" font-family="Arial, sans-serif" font-size="31" fill="#22384a">玄関</text>
      <text x="72" y="650" font-family="Arial, sans-serif" font-size="24" fill="#546878">${encodedTitle} / サンプル間取り図</text>
    </svg>
  `)}`;
}

export async function addSampleProperties() {
  const existing = await getAllItems("properties");
  if (existing.length > 0) return existing;

  const createdAt = nowIso();
  const properties: FloorPlanProperty[] = [
    {
      id: makeId("property"),
      title: "回遊動線のある4LDK",
      listingSource: "サンプル",
      sourceUrl: "",
      company: "サンプル工務店",
      priceManYen: 3480,
      layout: "4LDK",
      areaSqm: 104.34,
      tsubo: calculateTsubo(104.34),
      floors: "2階建",
      entranceDirection: "南",
      ldkTatami: 18,
      masterBedroomTatami: 7.5,
      childrenRoomCount: 2,
      hasFamilyCloset: true,
      hasLaundry: true,
      hasPantry: true,
      hasCircularFlow: true,
      images: [
        {
          id: makeId("image"),
          kind: "floorplan",
          sourceType: "upload",
          storageMode: "dataUrl",
          dataUrl: sampleFloorplanSvg("回遊動線のある4LDK", "#4488b5"),
          noteLabels: ["個人メモ用", "外部共有不可"],
          createdAt
        }
      ],
      favorite: true,
      tags: ["回遊動線", "ファミクロ", "南玄関"],
      memo: "比較用のサンプル。実データは削除して使えます。",
      createdAt,
      updatedAt: createdAt
    },
    {
      id: makeId("property"),
      title: "平屋ランドリー重視プラン",
      listingSource: "サンプル",
      sourceUrl: "",
      company: "サンプル住宅",
      priceManYen: 2980,
      layout: "3LDK",
      areaSqm: 88.6,
      tsubo: calculateTsubo(88.6),
      floors: "平屋",
      entranceDirection: "東",
      ldkTatami: 20,
      masterBedroomTatami: 6.5,
      childrenRoomCount: 2,
      hasFamilyCloset: false,
      hasLaundry: true,
      hasPantry: true,
      hasCircularFlow: false,
      images: [
        {
          id: makeId("image"),
          kind: "floorplan",
          sourceType: "upload",
          storageMode: "dataUrl",
          dataUrl: sampleFloorplanSvg("平屋ランドリー重視プラン", "#5f9b72"),
          noteLabels: ["個人メモ用", "外部共有不可"],
          createdAt
        }
      ],
      favorite: false,
      tags: ["平屋", "ランドリー", "パントリー"],
      memo: "平屋比較用のサンプル。",
      createdAt,
      updatedAt: createdAt
    }
  ];

  await putMany("properties", properties);
  return properties;
}

export async function addInitialLog() {
  const existing = await getAllItems("logs");
  if (existing.length > 0) return;

  const createdAt = nowIso();
  const log: CrawlLog = {
    id: makeId("log"),
    createdAt,
    siteName: "システム",
    domain: "-",
    url: "-",
    action: "停止",
    result: "停止中",
    message: "ローカル巡回エンジンを利用できます。結果JSONを取得候補画面から取り込んでください。"
  };

  await putMany("logs", [log]);
}
