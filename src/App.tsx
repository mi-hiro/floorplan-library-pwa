import {
  ClipboardList,
  Database,
  Home,
  LayoutGrid,
  Plus,
  Scale,
  Settings,
  ShieldCheck,
  SlidersHorizontal
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { CandidatesView, CrawlSettingsView, LogsView, SitesView } from "./components/AdminViews";
import { CompareView } from "./components/CompareView";
import { defaultFilters, FilterPanel } from "./components/FilterPanel";
import { PropertyCard } from "./components/PropertyCard";
import { PropertyWorkspace } from "./components/PropertyWorkspace";
import { addInitialLog, addSampleProperties, ensureDefaultSites } from "./data/seeds";
import { clearStore, deleteItem, getAllItems, putItem } from "./data/db";
import type {
  CrawlCandidate,
  CrawlLog,
  CrawlResultPackage,
  CrawlSite,
  FilterState,
  FloorPlanProperty,
  PropertyImage,
  ViewKey
} from "./types";
import {
  calculateTsubo,
  formatDate,
  getPrimaryFloorplan,
  makeId,
  normalizeNumber,
  nowIso,
  openExternalUrl
} from "./utils/format";

const navItems: { key: ViewKey; label: string; icon: React.ElementType }[] = [
  { key: "library", label: "ライブラリ", icon: LayoutGrid },
  { key: "compare", label: "比較", icon: Scale },
  { key: "settings", label: "設定", icon: Settings }
];

type SettingsTabKey = "sites" | "crawlSettings" | "candidates" | "logs";
type SortKey = "newest" | "oldest" | "source" | "layout";
type PageSize = 20 | 40 | 60;
type FloorplanDisplayMode = "cards" | "compact";

const settingsTabs: { key: SettingsTabKey; label: string; icon: React.ElementType }[] = [
  { key: "sites", label: "サイト管理", icon: ShieldCheck },
  { key: "crawlSettings", label: "巡回設定", icon: SlidersHorizontal },
  { key: "candidates", label: "取得候補", icon: ClipboardList },
  { key: "logs", label: "巡回ログ", icon: Database }
];

const AUTO_CRAWL_FEED_URL = `${import.meta.env.BASE_URL}data/floorplans.json`;
const LAST_AUTO_CRAWL_KEY = "floorplan-library:last-auto-crawl-generated-at:v3";

type ImportCrawlOptions = {
  switchToCandidates?: boolean;
  replaceCandidates?: boolean;
};

type CollectedFloorplanItem = {
  id: string;
  title: string;
  imageUrl: string;
  imageLink: string;
  images: CollectedFloorplanImage[];
  sourceUrl: string;
  listingSource: string;
  company: string;
  layout: string;
  floors: string;
  areaSqm?: number;
  tsubo?: number;
  priceManYen?: number;
  fetchedAt: string;
  candidate: CrawlCandidate;
};

type CollectedFloorplanImage = {
  id: string;
  title: string;
  imageUrl: string;
  imageLink: string;
};

function getInitialView(): ViewKey {
  if (typeof window === "undefined") return "library";
  const rawHashView = window.location.hash.replace("#", "");
  const hashView = rawHashView as ViewKey;
  if (rawHashView === "floorplans") return "library";
  if (settingsTabs.some((item) => item.key === rawHashView)) return "settings";
  return navItems.some((item) => item.key === hashView) ? hashView : "library";
}

function getInitialSettingsTab(): SettingsTabKey {
  if (typeof window === "undefined") return "sites";
  const rawHashView = window.location.hash.replace("#", "");
  return settingsTabs.some((item) => item.key === rawHashView) ? (rawHashView as SettingsTabKey) : "sites";
}

function includesText(value: string | undefined, keyword: string) {
  return (value ?? "").toLowerCase().includes(keyword.toLowerCase());
}

function inRange(value: number | undefined, minText: string, maxText: string) {
  const min = normalizeNumber(minText);
  const max = normalizeNumber(maxText);
  if (min !== undefined && (value === undefined || value < min)) return false;
  if (max !== undefined && (value === undefined || value > max)) return false;
  return true;
}

function inferLayoutLabel(text: string) {
  const match = text.match(/\b([2-5]\s*LDK)\b/i);
  return match ? match[1].replace(/\s+/g, "").toUpperCase() : "";
}

function inferFloorLabel(text: string) {
  if (/平屋/.test(text)) return "平屋";
  if (/2階|二階|2F/i.test(text)) return "2階建";
  if (/3階|三階|3F/i.test(text)) return "3階建";
  return "";
}

function filterProperties(properties: FloorPlanProperty[], filters: FilterState) {
  return properties.filter((property) => {
    const keyword = filters.keyword.trim();
    const hasFloorplan = property.images.some((image) => image.kind === "floorplan");
    const hasExterior = property.images.some((image) => image.kind === "exterior");

    if (keyword) {
      const matched =
        includesText(property.title, keyword) ||
        includesText(property.listingSource, keyword) ||
        includesText(property.company, keyword) ||
        includesText(property.memo, keyword) ||
        property.tags.some((tag) => includesText(tag, keyword));
      if (!matched) return false;
    }

    if (filters.layout !== "all" && property.layout !== filters.layout) return false;
    if (filters.floors !== "all" && property.floors !== filters.floors) return false;
    if (filters.entranceDirection !== "all" && property.entranceDirection !== filters.entranceDirection) return false;
    if (!inRange(property.areaSqm, filters.minArea, filters.maxArea)) return false;
    if (!inRange(property.tsubo, filters.minTsubo, filters.maxTsubo)) return false;
    if (!inRange(property.priceManYen, filters.minPrice, filters.maxPrice)) return false;
    if (filters.floorplanStatus === "with" && !hasFloorplan) return false;
    if (filters.floorplanStatus === "without" && hasFloorplan) return false;
    if (filters.exteriorStatus === "with" && !hasExterior) return false;
    if (filters.exteriorStatus === "without" && hasExterior) return false;
    if (filters.listingSource && !includesText(property.listingSource, filters.listingSource)) return false;
    if (filters.company && !includesText(property.company, filters.company)) return false;
    if (filters.favoriteOnly && !property.favorite) return false;
    if (filters.tag && !property.tags.some((tag) => includesText(tag, filters.tag))) return false;
    if (!inRange(property.ldkTatami, filters.minLdkTatami, "")) return false;
    if (filters.hasFamilyCloset && !property.hasFamilyCloset) return false;
    if (filters.hasLaundry && !property.hasLaundry) return false;
    if (filters.hasPantry && !property.hasPantry) return false;
    if (filters.hasCircularFlow && !property.hasCircularFlow) return false;

    return true;
  });
}

function filterCollectedFloorplans(items: CollectedFloorplanItem[], filters: FilterState) {
  return items.filter((item) => {
    const keyword = filters.keyword.trim();
    const candidate = item.candidate;

    if (keyword) {
      const matched =
        includesText(item.title, keyword) ||
        includesText(item.listingSource, keyword) ||
        includesText(item.company, keyword) ||
        includesText(item.sourceUrl, keyword) ||
        includesText(item.imageLink, keyword) ||
        includesText(candidate.memo, keyword);
      if (!matched) return false;
    }

    if (filters.layout !== "all" && item.layout !== filters.layout) return false;
    if (filters.floors !== "all" && item.floors !== filters.floors) return false;
    if (filters.entranceDirection !== "all" && candidate.entranceDirection !== filters.entranceDirection) return false;
    if (!inRange(item.areaSqm, filters.minArea, filters.maxArea)) return false;
    if (!inRange(item.tsubo, filters.minTsubo, filters.maxTsubo)) return false;
    if (!inRange(item.priceManYen, filters.minPrice, filters.maxPrice)) return false;
    if (filters.floorplanStatus === "without") return false;
    if (filters.exteriorStatus === "with") return false;
    if (filters.listingSource && !includesText(item.listingSource, filters.listingSource)) return false;
    if (filters.company && !includesText(item.company || item.listingSource, filters.company)) return false;
    if (filters.favoriteOnly) return false;
    if (filters.tag) return false;
    if (!inRange(undefined, filters.minLdkTatami, "")) return false;
    if (filters.hasFamilyCloset || filters.hasLaundry || filters.hasPantry || filters.hasCircularFlow) return false;

    return true;
  });
}

function sortCollectedFloorplans(items: CollectedFloorplanItem[], sortKey: SortKey) {
  return [...items].sort((a, b) => {
    if (sortKey === "oldest") return a.fetchedAt.localeCompare(b.fetchedAt);
    if (sortKey === "source") return `${a.listingSource}${a.title}`.localeCompare(`${b.listingSource}${b.title}`, "ja");
    if (sortKey === "layout") return `${a.layout || "zzz"}${a.title}`.localeCompare(`${b.layout || "zzz"}${b.title}`, "ja");
    return b.fetchedAt.localeCompare(a.fetchedAt);
  });
}

function floorplanMetaLabels(item: CollectedFloorplanItem) {
  return [
    item.layout,
    item.floors,
    item.images.length > 1 ? `${item.images.length}枚` : "",
    item.candidate.entranceDirection ? `玄関${item.candidate.entranceDirection}` : "",
    item.areaSqm ? `${item.areaSqm}㎡` : "",
    item.tsubo ? `${item.tsubo}坪` : "",
    item.priceManYen ? `${item.priceManYen.toLocaleString("ja-JP")}万円` : ""
  ].filter(Boolean);
}

function candidateToProperty(candidate: CrawlCandidate): FloorPlanProperty {
  const createdAt = nowIso();
  const imageCandidates = candidate.imageCandidates ?? [];
  const images: PropertyImage[] = imageCandidates.map((image) => ({
    id: makeId("image"),
    kind: image.kind,
    sourceType: "autoCandidate",
    storageMode: image.dataUrl ? "dataUrl" : "urlOnly",
    dataUrl: image.dataUrl,
    url: image.url,
    label: image.alt || "巡回候補画像",
    noteLabels: ["個人メモ用", "外部共有不可", "URL参照"],
    createdAt
  }));

  return {
    id: makeId("property"),
    title: candidate.title || "名称未設定",
    listingSource: candidate.listingSource,
    sourceUrl: candidate.sourceUrl,
    company: candidate.company,
    priceManYen: candidate.priceManYen,
    layout: candidate.layout,
    areaSqm: candidate.areaSqm,
    tsubo: calculateTsubo(candidate.areaSqm),
    floors: candidate.floors,
    entranceDirection: candidate.entranceDirection,
    hasFamilyCloset: false,
    hasLaundry: false,
    hasPantry: false,
    hasCircularFlow: false,
    images,
    favorite: false,
    tags: ["確認済み候補"],
    memo:
      candidate.memo ||
      "取得候補から正式登録。画像はURL参照として登録しています。権利や利用条件を確認してから利用してください。",
    createdAt,
    updatedAt: createdAt,
    lastCheckedAt: candidate.fetchedAt
  };
}

function normalizeImportedCandidate(candidate: CrawlCandidate): CrawlCandidate {
  const imageCandidates = sanitizeImageCandidates(candidate.imageCandidates ?? []);
  const imageUrlCandidates = [
    ...new Set([
      ...(candidate.imageUrlCandidates ?? []),
      ...imageCandidates.map((image) => image.url),
      ...imageCandidates.map((image) => image.thumbnailUrl ?? "")
    ].filter(Boolean))
  ];

  return {
    ...candidate,
    id: candidate.id || makeId("candidate"),
    title: candidate.title || "確認待ち候補",
    listingSource: candidate.listingSource || "",
    sourceUrl: candidate.sourceUrl || "",
    company: candidate.company || "",
    layout: candidate.layout || "",
    floors: candidate.floors || "",
    entranceDirection: candidate.entranceDirection || "",
    hasFloorplanImage: imageCandidates.some((image) => image.kind === "floorplan"),
    imageUrlCandidates,
    imageCandidates,
    fetchedAt: candidate.fetchedAt || nowIso(),
    errorInfo: candidate.errorInfo || "",
    memo: candidate.memo || ""
  };
}

function getCollectedFloorplans(candidates: CrawlCandidate[]) {
  const floorplans = new Map<string, CollectedFloorplanItem>();

  candidates.forEach((candidate) => {
    const images = sanitizeImageCandidates(candidate.imageCandidates ?? [])
      .filter((image) => image.kind === "floorplan")
      .map((image) => ({
        source: image,
        imageUrl: image.dataUrl || image.thumbnailUrl || image.url,
        key: floorplanDedupeKey(image)
      }))
      .filter((image) => image.imageUrl);

    const seen = new Set<string>();
    const uniqueImages = images
      .filter((image) => {
        if (seen.has(image.key)) return false;
        seen.add(image.key);
        return true;
      })
      .map(({ source, imageUrl }) => ({
        id: source.id,
        title: source.alt || candidate.title || "自動収集した間取り図",
        imageUrl,
        imageLink: source.url
      }));

    if (!uniqueImages.length) return;
    const primary = uniqueImages[0];
    const title = candidate.title || primary.title || "自動収集した間取り図";
    const signalText = `${title} ${uniqueImages.map((image) => image.title).join(" ")} ${candidate.layout} ${candidate.floors}`;
    floorplans.set(candidate.id, {
      id: candidate.id,
      title,
      imageUrl: primary.imageUrl,
      imageLink: primary.imageLink,
      images: uniqueImages,
      sourceUrl: candidate.sourceUrl,
      listingSource: candidate.listingSource,
      company: candidate.company || candidate.listingSource,
      layout: inferLayoutLabel(signalText) || candidate.layout,
      floors: inferFloorLabel(signalText) || candidate.floors,
      areaSqm: candidate.areaSqm,
      tsubo: candidate.tsubo,
      priceManYen: candidate.priceManYen,
      fetchedAt: candidate.fetchedAt,
      candidate
      });
  });

  return [...floorplans.values()];
}

function floorplanImageBadge(image: CollectedFloorplanImage, index: number) {
  const signal = `${image.title} ${image.imageLink}`;
  if (/1\.5階|１\.５階/.test(signal)) return "1.5F";
  if (/(?:^|[_-])1f|(?:^|[_-])1F|1階|１階|一階|_heimen1|-[1１](?=\.)/.test(signal)) return "1F";
  if (/(?:^|[_-])2f|(?:^|[_-])2F|2階|２階|二階|_heimen2|-[2２](?=\.)/.test(signal)) return "2F";
  if (/(?:^|[_-])3f|(?:^|[_-])3F|3階|３階|三階|_heimen3|-[3３](?=\.)/.test(signal)) return "3F";
  return `${index + 1}`;
}

function sanitizeImageCandidates(images: NonNullable<CrawlCandidate["imageCandidates"]>) {
  const floorplans = images.filter((image) => image.kind === "floorplan" && isDisplayFloorplanImage(image));
  const hasLayoutImage = floorplans.some(
    (image) => isOllamaAcceptedFloorplan(image) || hasStrongFloorplanSignal(image)
  );
  const filtered = hasLayoutImage
    ? floorplans.filter((image) => {
        const signal = imageSignalText(image);
        if (hasHardNonFloorplanSignal(image)) return false;
        if (isOllamaAcceptedFloorplan(image)) return true;
        if (/\/photo\/estate\/.+_[0-9]+[bsz]\.(?:jpe?g|png|webp)/i.test(signal) && /layout/i.test(floorplans.map(imageSignalText).join(" "))) {
          return false;
        }
        return hasStrongFloorplanSignal(image);
      })
    : floorplans;

  const seen = new Set<string>();
  return filtered.filter((image) => {
    const key = floorplanDedupeKey(image);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isDisplayFloorplanImage(image: NonNullable<CrawlCandidate["imageCandidates"]>[number]) {
  if (hasHardNonFloorplanSignal(image)) return false;
  if (image.ollamaReview?.status === "checked" && image.ollamaReview.isFloorplan === false) return false;
  if (image.needsOllamaReview) return false;
  if (isOllamaAcceptedFloorplan(image)) return true;
  return hasStrongFloorplanSignal(image);
}

function isOllamaAcceptedFloorplan(image: NonNullable<CrawlCandidate["imageCandidates"]>[number]) {
  return image.ollamaReview?.status === "checked" && image.ollamaReview.isFloorplan === true && Number(image.ollamaReview.confidence ?? 0) >= 0.65;
}

function hasStrongFloorplanSignal(image: NonNullable<CrawlCandidate["imageCandidates"]>[number]) {
  const altSignal = image.alt || "";
  const fileSignal = imageFileSignal(image);
  const tailSignal = imageTailSignal(image);

  if (/間取り図|平面図|図面|プラン[0-9０-９]+.*間取り|間取り.*[12１２]階|floor\s*plan|floorplan/i.test(altSignal)) return true;
  if (/間取り/i.test(altSignal) && /[2-5]\s*LDK|[0-9]{2}\s*坪|平屋|二階建|2階建|プラン|家/i.test(altSignal)) return true;
  if (/madori|floor[-_]?plan|floor_plan|floorplan|layout|topview|top-view|zumen|drawing|heimen|hemen/i.test(fileSignal)) return true;
  if (/(?:^|[_-])plan[-_]?[0-9]+|collection_plan|madori_thm|N[0-9]+-[12]F/i.test(fileSignal)) return true;
  return /floor[-_]?plan/i.test(tailSignal) && /map[0-9]|plan|layout/i.test(fileSignal);
}

function hasHardNonFloorplanSignal(image: NonNullable<CrawlCandidate["imageCandidates"]>[number]) {
  const signal = `${imageSignalText(image)} ${imagePathSignal(image)}`;
  return (
    /logo|ロゴ|icon|avatar|profile|staff|banner|baner|バナー|campaign|キャンペーン|gift|ギフト|catalog|カタログ|og画像|ogimage|ogp|blogcard|thumb|thumbnail|ranking|ランキング|月間ランキング|no[0-9]+__title|selected|pbmce|chart|graph|subnavi|nav[-_]|img_nav|bnr|youtube|ytimg|sddefault|hqdefault|mqdefault|img01\.suumo\.com\/front\/gazo\/chumon\/.+\/main\/[^/]+p[0-9]+|外観|外回り|外構|外装|外部|庭|駐車場|カーポート|アプローチ|エクステリア|内観|施工写真|写真のみ|インテリア|リビング|寝室|キッチン|浴室|洗面|トイレ|frontview|front-view|sideview|side-view|facade|exterior|appearance|interior|garden|parking|carport|features?_img|feature_img|point_img|mainvisual|hero/i.test(
      signal
    ) || looksLikeRoomPhotoLabel(signal)
  );
}

function looksLikeRoomPhotoLabel(signal: string) {
  return /[|｜]\s*(?:LDK|リビング|ダイニング|キッチン|寝室|洋室|和室|子ども部屋|洗面|浴室|トイレ|玄関|外観|内観|室内)(?:\s|$)/i.test(
    signal
  );
}

function floorplanDedupeKey(image: NonNullable<CrawlCandidate["imageCandidates"]>[number]) {
  const signal = imageSignalText(image);
  const url = normalizeImageUrl(image.url);
  const planNumber = signal.match(/plan[-_\s]?([0-9]+)/i)?.[1];
  if (planNumber && /zerohome/i.test(url)) return `zerohome-plan-${planNumber}`;
  const eyefulPlan = url.match(/eyefulhome\.jp\/.+\/madori(?:_thm)?([0-9]+)/i)?.[1];
  if (eyefulPlan) return `eyefulhome-madori-${eyefulPlan}`;
  const tanakenLayout = url.match(/tanaken\.co\.jp\/photo\/estate\/([0-9]+)\/([^/?#]+?)(?:_(?:layout|[0-9]+[bsz]))?\.(?:jpe?g|png|webp)/i);
  if (tanakenLayout) return `tanaken-${tanakenLayout[1]}-${tanakenLayout[2]}`;
  return url;
}

function normalizeImageUrl(url: string) {
  try {
    const parsed = new URL(url);
    parsed.search = "";
    parsed.hash = "";
    return decodeURIComponent(parsed.toString()).toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

function imageSignalText(image: NonNullable<CrawlCandidate["imageCandidates"]>[number]) {
  return `${image.alt || ""} ${normalizeImageUrl(image.url)} ${normalizeImageUrl(image.thumbnailUrl || "")}`;
}

function imageFileSignal(image: NonNullable<CrawlCandidate["imageCandidates"]>[number]) {
  const primary = getUrlSignalParts(image.url);
  const thumbnail = getUrlSignalParts(image.thumbnailUrl || "");
  return `${image.alt || ""} ${primary.fileName} ${thumbnail.fileName}`.toLowerCase();
}

function imageTailSignal(image: NonNullable<CrawlCandidate["imageCandidates"]>[number]) {
  const primary = getUrlSignalParts(image.url);
  const thumbnail = getUrlSignalParts(image.thumbnailUrl || "");
  return `${primary.parentName}/${primary.fileName} ${thumbnail.parentName}/${thumbnail.fileName}`.toLowerCase();
}

function imagePathSignal(image: NonNullable<CrawlCandidate["imageCandidates"]>[number]) {
  return `${getUrlSignalParts(image.url).pathName} ${getUrlSignalParts(image.thumbnailUrl || "").pathName}`.toLowerCase();
}

function getUrlSignalParts(url: string) {
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

export default function App() {
  const [view, setViewState] = useState<ViewKey>(getInitialView);
  const [settingsView, setSettingsViewState] = useState<SettingsTabKey>(getInitialSettingsTab);
  const [properties, setProperties] = useState<FloorPlanProperty[]>([]);
  const [sites, setSites] = useState<CrawlSite[]>([]);
  const [candidates, setCandidates] = useState<CrawlCandidate[]>([]);
  const [logs, setLogs] = useState<CrawlLog[]>([]);
  const [filters, setFilters] = useState<FilterState>(defaultFilters);
  const [floorplanPageSize, setFloorplanPageSize] = useState<PageSize>(20);
  const [floorplanSort, setFloorplanSort] = useState<SortKey>("newest");
  const [floorplanDisplay, setFloorplanDisplay] = useState<FloorplanDisplayMode>("compact");
  const [floorplanPage, setFloorplanPage] = useState(1);
  const [editingProperty, setEditingProperty] = useState<FloorPlanProperty | undefined>();
  const [isCreating, setIsCreating] = useState(false);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [autoSyncStatus, setAutoSyncStatus] = useState("巡回データ確認待ち");
  const [loading, setLoading] = useState(true);

  function setView(nextView: ViewKey) {
    setViewState(nextView);
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", `#${nextView}`);
    }
  }

  function setSettingsView(nextView: SettingsTabKey) {
    setSettingsViewState(nextView);
    setViewState("settings");
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", `#${nextView}`);
    }
  }

  async function refreshData() {
    const [nextProperties, nextSites, nextCandidates, nextLogs] = await Promise.all([
      getAllItems("properties"),
      getAllItems("sites"),
      getAllItems("candidates"),
      getAllItems("logs")
    ]);
    setProperties(nextProperties.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    setSites(nextSites.sort((a, b) => a.siteName.localeCompare(b.siteName, "ja")));
    setCandidates(nextCandidates.sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt)));
    setLogs(nextLogs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  }

  useEffect(() => {
    let cancelled = false;

    function handleHashChange() {
      setViewState(getInitialView());
      setSettingsViewState(getInitialSettingsTab());
    }

    async function boot() {
      await ensureDefaultSites();
      await addInitialLog();
      if (!cancelled) {
        await refreshData();
        setLoading(false);
      }
    }

    window.addEventListener("hashchange", handleHashChange);
    boot();
    return () => {
      cancelled = true;
      window.removeEventListener("hashchange", handleHashChange);
    };
  }, []);

  const collectedFloorplans = useMemo(() => getCollectedFloorplans(candidates), [candidates]);
  const filteredProperties = useMemo(() => filterProperties(properties, filters), [properties, filters]);
  const filteredCollectedFloorplans = useMemo(
    () => filterCollectedFloorplans(collectedFloorplans, filters),
    [collectedFloorplans, filters]
  );
  const sortedCollectedFloorplans = useMemo(
    () => sortCollectedFloorplans(filteredCollectedFloorplans, floorplanSort),
    [filteredCollectedFloorplans, floorplanSort]
  );
  const totalFloorplanPages = Math.max(1, Math.ceil(sortedCollectedFloorplans.length / floorplanPageSize));
  const pagedCollectedFloorplans = useMemo(() => {
    const start = (floorplanPage - 1) * floorplanPageSize;
    return sortedCollectedFloorplans.slice(start, start + floorplanPageSize);
  }, [sortedCollectedFloorplans, floorplanPage, floorplanPageSize]);
  const availableTags = useMemo(() => [...new Set(properties.flatMap((property) => property.tags))].sort(), [properties]);
  const listingSources = useMemo(
    () => [
      ...new Set([
        ...properties.map((property) => property.listingSource),
        ...collectedFloorplans.map((item) => item.listingSource)
      ].filter(Boolean))
    ].sort(),
    [properties, collectedFloorplans]
  );
  const companies = useMemo(
    () => [
      ...new Set([
        ...properties.map((property) => property.company),
        ...collectedFloorplans.map((item) => item.company || item.listingSource)
      ].filter(Boolean))
    ].sort(),
    [properties, collectedFloorplans]
  );
  const floorplanCount = useMemo(() => properties.filter((property) => getPrimaryFloorplan(property)).length, [properties]);

  useEffect(() => {
    setFloorplanPage(1);
  }, [filters, floorplanPageSize, floorplanSort]);

  useEffect(() => {
    setFloorplanPage((current) => Math.min(current, totalFloorplanPages));
  }, [totalFloorplanPages]);

  function moveFloorplanPage(nextPage: number) {
    const targetPage = Math.min(totalFloorplanPages, Math.max(1, nextPage));
    setFloorplanPage(targetPage);
    if (typeof window === "undefined") return;
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        document.getElementById("floorplans")?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
  }

  async function addLog(log: Omit<CrawlLog, "id" | "createdAt">) {
    const next: CrawlLog = { ...log, id: makeId("log"), createdAt: nowIso() };
    await putItem("logs", next);
    setLogs((current) => [next, ...current]);
  }

  async function saveProperty(property: FloorPlanProperty) {
    await putItem("properties", property);
    setProperties((current) => {
      const exists = current.some((item) => item.id === property.id);
      const next = exists ? current.map((item) => (item.id === property.id ? property : item)) : [property, ...current];
      return next.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    });
    setEditingProperty(undefined);
    setIsCreating(false);
  }

  async function deleteProperty(id: string) {
    if (!confirm("この物件を削除しますか？")) return;
    await deleteItem("properties", id);
    setProperties((current) => current.filter((property) => property.id !== id));
    setCompareIds((current) => current.filter((compareId) => compareId !== id));
    setEditingProperty(undefined);
    setIsCreating(false);
  }

  async function toggleFavorite(property: FloorPlanProperty) {
    await saveProperty({ ...property, favorite: !property.favorite, updatedAt: nowIso() });
  }

  function toggleCompare(id: string) {
    setCompareIds((current) => {
      if (current.includes(id)) return current.filter((item) => item !== id);
      return [...current.slice(-1), id];
    });
  }

  async function saveSite(site: CrawlSite) {
    const next = { ...site, updatedAt: nowIso() };
    await putItem("sites", next);
    setSites((current) => {
      const exists = current.some((item) => item.id === next.id);
      return (exists ? current.map((item) => (item.id === next.id ? next : item)) : [...current, next]).sort((a, b) =>
        a.siteName.localeCompare(b.siteName, "ja")
      );
    });
    await addLog({
      siteName: next.siteName,
      domain: next.domain,
      url: next.searchUrl || "-",
      action: "停止",
      result: next.enabled ? "成功" : "停止中",
      message: "サイト設定を保存しました。ローカル巡回エンジン用の設定として利用できます。"
    });
  }

  async function deleteSite(id: string) {
    if (!confirm("このサイト設定を削除しますか？")) return;
    await deleteItem("sites", id);
    setSites((current) => current.filter((site) => site.id !== id));
  }

  async function saveCandidate(candidate: CrawlCandidate) {
    await putItem("candidates", candidate);
    setCandidates((current) => {
      const exists = current.some((item) => item.id === candidate.id);
      return exists ? current.map((item) => (item.id === candidate.id ? candidate : item)) : [candidate, ...current];
    });
    await addLog({
      siteName: candidate.listingSource || "手動候補",
      domain: candidate.sourceUrl ? new URL(candidate.sourceUrl).hostname : "-",
      url: candidate.sourceUrl || "-",
      action: "候補保存",
      result: "成功",
      message: "確認待ち候補を保存しました。"
    }).catch(() => undefined);
  }

  async function deleteCandidate(id: string) {
    await deleteItem("candidates", id);
    setCandidates((current) => current.filter((candidate) => candidate.id !== id));
  }

  async function promoteCandidate(candidate: CrawlCandidate) {
    const property = candidateToProperty(candidate);
    await saveProperty(property);
    await deleteCandidate(candidate.id);
    setView("library");
  }

  async function importCrawlPackage(crawlPackage: CrawlResultPackage, options: ImportCrawlOptions = { switchToCandidates: true }) {
    if (!crawlPackage.candidates || !Array.isArray(crawlPackage.candidates)) {
      throw new Error("巡回結果JSONの形式が違います。");
    }

    const importedCandidates = crawlPackage.candidates.map(normalizeImportedCandidate);
    const importedLogs = Array.isArray(crawlPackage.logs) ? crawlPackage.logs : [];

    if (options.replaceCandidates) {
      await clearStore("candidates");
    }

    await Promise.all([
      ...importedCandidates.map((candidate) => putItem("candidates", candidate)),
      ...importedLogs.map((log) =>
        putItem("logs", {
          ...log,
          id: log.id || makeId("log"),
          createdAt: log.createdAt || nowIso()
        })
      )
    ]);

    setCandidates((current) => {
      if (options.replaceCandidates) {
        return importedCandidates.sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt));
      }
      const merged = new Map(current.map((candidate) => [candidate.id, candidate]));
      importedCandidates.forEach((candidate) => merged.set(candidate.id, candidate));
      return [...merged.values()].sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt));
    });
    setLogs((current) => {
      const merged = new Map(current.map((log) => [log.id, log]));
      importedLogs.forEach((log) => merged.set(log.id, log));
      return [...merged.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    });
    if (options.switchToCandidates) setSettingsView("candidates");
    return {
      candidateCount: importedCandidates.length,
      logCount: importedLogs.length,
      generatedAt: crawlPackage.generatedAt
    };
  }

  async function syncHostedCrawlPackage(showNoUpdate = false) {
    try {
      const response = await fetch(`${AUTO_CRAWL_FEED_URL}?ts=${Date.now()}`, {
        cache: "no-store"
      });
      if (response.status === 404) {
        setAutoSyncStatus("巡回データ未公開");
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const crawlPackage = (await response.json()) as CrawlResultPackage;
      const lastGeneratedAt = localStorage.getItem(LAST_AUTO_CRAWL_KEY);
      if (!crawlPackage.generatedAt || crawlPackage.generatedAt === lastGeneratedAt) {
        if (showNoUpdate) setAutoSyncStatus("新しい巡回データなし");
        return;
      }

      const result = await importCrawlPackage(crawlPackage, { switchToCandidates: false, replaceCandidates: true });
      localStorage.setItem(LAST_AUTO_CRAWL_KEY, crawlPackage.generatedAt);
      setAutoSyncStatus(`巡回候補 ${result.candidateCount}件に更新`);
    } catch {
      setAutoSyncStatus("巡回データ確認エラー");
    }
  }

  useEffect(() => {
    if (loading) return;
    syncHostedCrawlPackage();
    const timer = window.setInterval(() => syncHostedCrawlPackage(), 5 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [loading]);

  useEffect(() => {
    if (loading || window.location.hash !== "#floorplans") return;
    window.setTimeout(() => document.getElementById("floorplans")?.scrollIntoView({ block: "start" }), 0);
  }, [loading, collectedFloorplans.length]);

  async function clearLogs() {
    if (!confirm("巡回ログをすべて削除しますか？")) return;
    await clearStore("logs");
    setLogs([]);
  }

  async function handleAddSamples() {
    const next = await addSampleProperties();
    setProperties(next.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  }

  if (loading) {
    return (
      <main className="loading-screen">
        <Home size={30} />
        <p>間取り図ライブラリを読み込み中...</p>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <div className="brand-mark">
            <Home size={22} />
          </div>
          <div>
            <p className="eyebrow">PWA / IndexedDB</p>
            <h1>間取り図ライブラリ</h1>
          </div>
        </div>
        <div className="summary-strip">
          <span>登録 {properties.length}件</span>
          <span>間取り {floorplanCount}件</span>
          <span>自動 {collectedFloorplans.length}件</span>
          <span>{autoSyncStatus === "巡回データ確認待ち" ? "巡回待ち" : autoSyncStatus}</span>
          <span>更新 {formatDate(properties[0]?.updatedAt)}</span>
        </div>
      </header>

      <nav className="app-nav" aria-label="画面切り替え">
        {navItems.map(({ key, label, icon: Icon }) => (
          <button key={key} className={view === key ? "is-current" : ""} type="button" onClick={() => setView(key)}>
            <Icon size={18} />
            {label}
            {key === "compare" && compareIds.length > 0 ? <span className="nav-badge">{compareIds.length}</span> : null}
          </button>
        ))}
      </nav>

      {view === "library" ? (
        <main className="library-layout">
          <FilterPanel
            filters={filters}
            onChange={setFilters}
            availableTags={availableTags}
            listingSources={listingSources}
            companies={companies}
            onAdd={() => setIsCreating(true)}
          />
          <section className="library-main">
            {collectedFloorplans.length > 0 ? (
              <section className="auto-floorplan-section" id="floorplans">
                <div className="section-heading compact floorplan-list-heading">
                  <h2>収集した間取り図</h2>
                  <span className="status-pill on">
                    {filteredCollectedFloorplans.length} / {collectedFloorplans.length}件
                  </span>
                </div>
                <div className="list-toolbar">
                  <label className="field compact-field">
                    <span>並び替え</span>
                    <select value={floorplanSort} onChange={(event) => setFloorplanSort(event.target.value as SortKey)}>
                      <option value="newest">新着順</option>
                      <option value="oldest">古い順</option>
                      <option value="source">掲載元順</option>
                      <option value="layout">間取り順</option>
                    </select>
                  </label>
                  <label className="field compact-field">
                    <span>表示件数</span>
                    <select value={floorplanPageSize} onChange={(event) => setFloorplanPageSize(Number(event.target.value) as PageSize)}>
                      <option value={20}>20件</option>
                      <option value={40}>40件</option>
                      <option value={60}>60件</option>
                    </select>
                  </label>
                  <label className="field compact-field">
                    <span>表示</span>
                    <select value={floorplanDisplay} onChange={(event) => setFloorplanDisplay(event.target.value as FloorplanDisplayMode)}>
                      <option value="cards">カード表示</option>
                      <option value="compact">リスト表示</option>
                    </select>
                  </label>
                  <div className="pager-controls">
                    <button className="secondary-button" type="button" disabled={floorplanPage <= 1} onClick={() => moveFloorplanPage(floorplanPage - 1)}>
                      前へ
                    </button>
                    <span>{floorplanPage} / {totalFloorplanPages}</span>
                    <button className="secondary-button" type="button" disabled={floorplanPage >= totalFloorplanPages} onClick={() => moveFloorplanPage(floorplanPage + 1)}>
                      次へ
                    </button>
                  </div>
                </div>
                {filteredCollectedFloorplans.length > 0 ? (
                  <>
                    <div className={`floorplan-gallery ${floorplanDisplay === "compact" ? "is-compact-list" : ""}`}>
                      {pagedCollectedFloorplans.map((item) => (
                        <article className="floorplan-tile" key={item.id}>
                          <button className="floorplan-image-button" type="button" onClick={() => openExternalUrl(item.imageLink)}>
                            <img src={item.imageUrl} alt={item.title} loading="lazy" />
                          </button>
                          {item.images.length > 1 ? (
                            <div className="floorplan-image-strip" aria-label="階別の間取り図">
                              {item.images.slice(0, 6).map((image, imageIndex) => (
                                <button
                                  className="floorplan-image-chip"
                                  key={image.id}
                                  type="button"
                                  onClick={() => openExternalUrl(image.imageLink)}
                                  title={image.title}
                                >
                                  <img src={image.imageUrl} alt={image.title} loading="lazy" />
                                  <span>{floorplanImageBadge(image, imageIndex)}</span>
                                </button>
                              ))}
                            </div>
                          ) : null}
                          <div className="floorplan-tile-body">
                            <h3>{item.title}</h3>
                            {floorplanMetaLabels(item).length > 0 ? (
                              <div className="floorplan-meta">
                                {floorplanMetaLabels(item).map((label) => (
                                  <span key={label}>{label}</span>
                                ))}
                              </div>
                            ) : null}
                            <p className="muted-text">{item.listingSource || "掲載元未入力"} / {item.layout || "間取り未抽出"}</p>
                            <p className="muted-text floorplan-date">取得日時：{formatDate(item.fetchedAt)}</p>
                            <div className="card-actions">
                              <button className="ghost-button" type="button" onClick={() => openExternalUrl(item.sourceUrl || item.imageLink)}>
                                元ページ
                              </button>
                              <button className="primary-button" type="button" onClick={() => promoteCandidate(item.candidate)}>
                                正式登録
                              </button>
                            </div>
                          </div>
                        </article>
                      ))}
                    </div>
                    <div className="pager-controls pager-controls-bottom">
                      <button className="secondary-button" type="button" disabled={floorplanPage <= 1} onClick={() => moveFloorplanPage(floorplanPage - 1)}>
                        前へ
                      </button>
                      <span>{floorplanPage} / {totalFloorplanPages}</span>
                      <button className="secondary-button" type="button" disabled={floorplanPage >= totalFloorplanPages} onClick={() => moveFloorplanPage(floorplanPage + 1)}>
                        次へ
                      </button>
                    </div>
                  </>
                ) : (
                  <section className="empty-state compact">
                    <h2>条件に一致する自動収集の間取り図がありません</h2>
                    <p>検索語や掲載元、間取りの条件を少し広げると見つかりやすくなります。</p>
                  </section>
                )}
              </section>
            ) : null}

            {properties.length === 0 && collectedFloorplans.length === 0 ? (
              <section className="empty-state">
                <h2>最初の間取り図を登録しましょう</h2>
                <p>端末内の画像、スクリーンショット、画像URLを使ってローカル保存できます。</p>
                <div className="empty-actions">
                  <button className="primary-button" type="button" onClick={() => setIsCreating(true)}>
                    <Plus size={17} />
                    追加
                  </button>
                  <button className="secondary-button" type="button" onClick={handleAddSamples}>
                    サンプルを追加
                  </button>
                </div>
              </section>
            ) : properties.length > 0 && filteredProperties.length === 0 ? (
              <section className="empty-state">
                <h2>条件に合う間取り図がありません</h2>
                <p>検索条件を少しゆるめると見つかるかもしれません。</p>
                <button className="secondary-button" type="button" onClick={() => setFilters(defaultFilters)}>
                  条件をクリア
                </button>
              </section>
            ) : properties.length > 0 ? (
              <div className="card-grid">
                {filteredProperties.map((property) => (
                  <PropertyCard
                    key={property.id}
                    property={property}
                    selectedForCompare={compareIds.includes(property.id)}
                    onOpen={() => setEditingProperty(property)}
                    onEdit={() => setEditingProperty(property)}
                    onToggleFavorite={() => toggleFavorite(property)}
                    onToggleCompare={() => toggleCompare(property.id)}
                  />
                ))}
              </div>
            ) : null}
          </section>
        </main>
      ) : null}

      {view === "compare" ? (
        <main className="single-main">
          <CompareView properties={properties} compareIds={compareIds} onRemove={toggleCompare} onOpenLibrary={() => setView("library")} />
        </main>
      ) : null}

      {view === "settings" ? (
        <main className="single-main settings-page">
          <section className="section-heading">
            <div>
              <p className="eyebrow">管理</p>
              <h2>設定</h2>
            </div>
          </section>
          <nav className="settings-tabs" aria-label="設定メニュー">
            {settingsTabs.map(({ key, label, icon: Icon }) => (
              <button key={key} className={settingsView === key ? "is-current" : ""} type="button" onClick={() => setSettingsView(key)}>
                <Icon size={17} />
                {label}
              </button>
            ))}
          </nav>
          {settingsView === "sites" ? <SitesView sites={sites} onSaveSite={saveSite} onDeleteSite={deleteSite} /> : null}
          {settingsView === "crawlSettings" ? <CrawlSettingsView sites={sites} onSaveSite={saveSite} /> : null}
          {settingsView === "candidates" ? (
            <CandidatesView
              candidates={candidates}
              sites={sites}
              onSaveCandidate={saveCandidate}
              onDeleteCandidate={deleteCandidate}
              onPromoteCandidate={promoteCandidate}
              onImportCrawlPackage={async (crawlPackage) => {
                await importCrawlPackage(crawlPackage);
              }}
            />
          ) : null}
          {settingsView === "logs" ? <LogsView logs={logs} onClearLogs={clearLogs} /> : null}
        </main>
      ) : null}

      {(editingProperty || isCreating) ? (
        <PropertyWorkspace
          property={editingProperty}
          onSave={saveProperty}
          onDelete={deleteProperty}
          onClose={() => {
            setEditingProperty(undefined);
            setIsCreating(false);
          }}
        />
      ) : null}
    </div>
  );
}
