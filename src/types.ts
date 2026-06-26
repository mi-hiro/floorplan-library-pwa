export type ImageKind = "floorplan" | "exterior" | "interior" | "sitePlan" | "other";

export type ImageSourceType = "upload" | "url" | "autoCandidate";

export type ImageStorageMode = "dataUrl" | "urlOnly" | "metadataOnly";

export type LayoutType = "2LDK" | "3LDK" | "4LDK" | "5LDK" | "その他" | "";

export type FloorCount = "平屋" | "2階建" | "3階建" | "その他" | "";

export type EntranceDirection = "東" | "西" | "南" | "北" | "不明" | "";

export interface PropertyImage {
  id: string;
  kind: ImageKind;
  sourceType: ImageSourceType;
  storageMode: ImageStorageMode;
  dataUrl?: string;
  url?: string;
  label?: string;
  noteLabels: string[];
  createdAt: string;
}

export interface FloorPlanProperty {
  id: string;
  title: string;
  listingSource: string;
  sourceUrl: string;
  company: string;
  priceManYen?: number;
  layout: LayoutType;
  areaSqm?: number;
  tsubo?: number;
  floors: FloorCount;
  entranceDirection: EntranceDirection;
  ldkTatami?: number;
  masterBedroomTatami?: number;
  childrenRoomCount?: number;
  hasFamilyCloset: boolean;
  hasLaundry: boolean;
  hasPantry: boolean;
  hasCircularFlow: boolean;
  images: PropertyImage[];
  favorite: boolean;
  tags: string[];
  memo: string;
  createdAt: string;
  updatedAt: string;
  lastCheckedAt?: string;
}

export type CrawlMode = "manualOnly" | "veryLowFrequency" | "lowFrequency" | "permitted";

export type ImageSaveMode = "none" | "urlOnly" | "storeImage";

export type RobotsStatus = "unchecked" | "allowed" | "disallowed" | "error";

export interface CrawlImageCandidate {
  id: string;
  kind: ImageKind;
  url: string;
  thumbnailUrl?: string;
  dataUrl?: string;
  alt: string;
  sourceUrl: string;
}

export interface CrawlSite {
  id: string;
  siteName: string;
  domain: string;
  searchUrl: string;
  enabled: boolean;
  crawlMode: CrawlMode;
  perRunLimit: number;
  perDayLimit: number;
  delaySeconds: number;
  recrawlIntervalDays: number;
  robotsStatus: RobotsStatus;
  sitemapUrl: string;
  imageAutoFetch: boolean;
  imageSaveMode: ImageSaveMode;
  majorPortal: boolean;
  stopped: boolean;
  stopReason: string;
  lastCrawledAt?: string;
  nextCrawlAt?: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface CrawlCandidate {
  id: string;
  title: string;
  listingSource: string;
  sourceUrl: string;
  siteId?: string;
  company: string;
  priceManYen?: number;
  layout: LayoutType;
  areaSqm?: number;
  tsubo?: number;
  floors: FloorCount;
  entranceDirection: EntranceDirection;
  hasFloorplanImage: boolean;
  imageUrlCandidates: string[];
  imageCandidates?: CrawlImageCandidate[];
  fetchedAt: string;
  errorInfo: string;
  memo: string;
}

export interface CrawlResultPackage {
  version: number;
  generatedAt: string;
  source: "local-crawler";
  candidates: CrawlCandidate[];
  logs: CrawlLog[];
}

export type CrawlAction =
  | "robots確認"
  | "sitemap確認"
  | "一覧取得"
  | "詳細取得"
  | "候補保存"
  | "画像候補検出"
  | "エラー"
  | "停止";

export type CrawlResult =
  | "成功"
  | "robots禁止"
  | "403"
  | "429"
  | "5xx"
  | "CAPTCHA検出"
  | "ログイン要求"
  | "上限到達"
  | "停止中";

export interface CrawlLog {
  id: string;
  createdAt: string;
  siteName: string;
  domain: string;
  url: string;
  action: CrawlAction;
  result: CrawlResult;
  message: string;
}

export interface FilterState {
  keyword: string;
  layout: LayoutType | "all";
  minArea: string;
  maxArea: string;
  minTsubo: string;
  maxTsubo: string;
  minPrice: string;
  maxPrice: string;
  entranceDirection: EntranceDirection | "all";
  floors: FloorCount | "all";
  floorplanStatus: "all" | "with" | "without";
  exteriorStatus: "all" | "with" | "without";
  listingSource: string;
  company: string;
  favoriteOnly: boolean;
  tag: string;
  minLdkTatami: string;
  hasFamilyCloset: boolean;
  hasLaundry: boolean;
  hasPantry: boolean;
  hasCircularFlow: boolean;
}

export type ViewKey = "library" | "compare" | "settings";

export const IMAGE_KIND_LABELS: Record<ImageKind, string> = {
  floorplan: "間取り図",
  exterior: "外観",
  interior: "内観",
  sitePlan: "配置図",
  other: "その他"
};

export const IMAGE_KIND_OPTIONS: ImageKind[] = ["floorplan", "exterior", "interior", "sitePlan", "other"];

export const LAYOUT_OPTIONS: LayoutType[] = ["2LDK", "3LDK", "4LDK", "5LDK", "その他"];

export const FLOOR_OPTIONS: FloorCount[] = ["平屋", "2階建", "3階建", "その他"];

export const DIRECTION_OPTIONS: EntranceDirection[] = ["東", "西", "南", "北", "不明"];

export const CRAWL_MODE_LABELS: Record<CrawlMode, string> = {
  manualOnly: "手動URLのみ",
  veryLowFrequency: "超低頻度巡回",
  lowFrequency: "通常低頻度巡回",
  permitted: "許可済み巡回"
};

export const IMAGE_SAVE_MODE_LABELS: Record<ImageSaveMode, string> = {
  none: "保存しない",
  urlOnly: "画像URLのみ",
  storeImage: "画像本体を保存"
};
