import {
  ClipboardList,
  Database,
  Home,
  LayoutGrid,
  Plus,
  RotateCcw,
  Scale,
  Settings,
  ShieldCheck
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
  { key: "sites", label: "サイト管理", icon: ShieldCheck },
  { key: "crawlSettings", label: "巡回設定", icon: Settings },
  { key: "candidates", label: "取得候補", icon: ClipboardList },
  { key: "logs", label: "巡回ログ", icon: Database }
];

const AUTO_CRAWL_FEED_URL = `${import.meta.env.BASE_URL}crawler-output/latest-crawl.json`;
const LAST_AUTO_CRAWL_KEY = "floorplan-library:last-auto-crawl-generated-at";

function getInitialView(): ViewKey {
  if (typeof window === "undefined") return "library";
  const rawHashView = window.location.hash.replace("#", "");
  const hashView = rawHashView as ViewKey;
  if (rawHashView === "floorplans") return "library";
  return navItems.some((item) => item.key === hashView) ? hashView : "library";
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
  const imageCandidates = candidate.imageCandidates ?? [];
  const imageUrlCandidates = [
    ...new Set([
      ...(candidate.imageUrlCandidates ?? []),
      ...imageCandidates.map((image) => image.url)
    ])
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
    hasFloorplanImage: candidate.hasFloorplanImage || imageCandidates.some((image) => image.kind === "floorplan"),
    imageUrlCandidates,
    imageCandidates,
    fetchedAt: candidate.fetchedAt || nowIso(),
    errorInfo: candidate.errorInfo || "",
    memo: candidate.memo || ""
  };
}

function getCollectedFloorplans(candidates: CrawlCandidate[]) {
  return candidates.flatMap((candidate) =>
    (candidate.imageCandidates ?? [])
      .filter((image) => image.kind === "floorplan")
      .map((image) => ({
        id: `${candidate.id}:${image.id}`,
        title: image.alt || candidate.title || "自動収集した間取り図",
        imageUrl: image.dataUrl || image.url,
        imageLink: image.url,
        sourceUrl: candidate.sourceUrl,
        listingSource: candidate.listingSource,
        layout: candidate.layout,
        areaSqm: candidate.areaSqm,
        fetchedAt: candidate.fetchedAt,
        candidate
      }))
  );
}

export default function App() {
  const [view, setViewState] = useState<ViewKey>(getInitialView);
  const [properties, setProperties] = useState<FloorPlanProperty[]>([]);
  const [sites, setSites] = useState<CrawlSite[]>([]);
  const [candidates, setCandidates] = useState<CrawlCandidate[]>([]);
  const [logs, setLogs] = useState<CrawlLog[]>([]);
  const [filters, setFilters] = useState<FilterState>(defaultFilters);
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

  const filteredProperties = useMemo(() => filterProperties(properties, filters), [properties, filters]);
  const availableTags = useMemo(() => [...new Set(properties.flatMap((property) => property.tags))].sort(), [properties]);
  const listingSources = useMemo(() => [...new Set(properties.map((property) => property.listingSource).filter(Boolean))].sort(), [properties]);
  const companies = useMemo(() => [...new Set(properties.map((property) => property.company).filter(Boolean))].sort(), [properties]);
  const floorplanCount = useMemo(() => properties.filter((property) => getPrimaryFloorplan(property)).length, [properties]);
  const collectedFloorplans = useMemo(() => getCollectedFloorplans(candidates), [candidates]);

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

  async function importCrawlPackage(crawlPackage: CrawlResultPackage, options = { switchToCandidates: true }) {
    if (!crawlPackage.candidates || !Array.isArray(crawlPackage.candidates)) {
      throw new Error("巡回結果JSONの形式が違います。");
    }

    const importedCandidates = crawlPackage.candidates.map(normalizeImportedCandidate);
    const importedLogs = Array.isArray(crawlPackage.logs) ? crawlPackage.logs : [];

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
      const merged = new Map(current.map((candidate) => [candidate.id, candidate]));
      importedCandidates.forEach((candidate) => merged.set(candidate.id, candidate));
      return [...merged.values()].sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt));
    });
    setLogs((current) => {
      const merged = new Map(current.map((log) => [log.id, log]));
      importedLogs.forEach((log) => merged.set(log.id, log));
      return [...merged.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    });
    if (options.switchToCandidates) setView("candidates");
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

      const result = await importCrawlPackage(crawlPackage, { switchToCandidates: false });
      localStorage.setItem(LAST_AUTO_CRAWL_KEY, crawlPackage.generatedAt);
      setAutoSyncStatus(`巡回候補 ${result.candidateCount}件を自動同期`);
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
          <span>{properties.length}件登録</span>
          <span>{floorplanCount}件の間取り図</span>
          <span>自動収集 {collectedFloorplans.length}件</span>
          <span>{autoSyncStatus}</span>
          <span>最終更新 {formatDate(properties[0]?.updatedAt)}</span>
        </div>
        <button className="primary-button" type="button" onClick={() => setIsCreating(true)}>
          <Plus size={18} />
          新規登録
        </button>
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
          />
          <section className="library-main">
            <div className="section-heading">
              <div>
                <p className="eyebrow">一覧</p>
                <h2>間取り図一覧</h2>
              </div>
              <div className="section-actions">
                <button className="secondary-button" type="button" onClick={() => setFilters(defaultFilters)}>
                  <RotateCcw size={17} />
                  条件クリア
                </button>
                <button className="primary-button" type="button" onClick={() => setIsCreating(true)}>
                  <Plus size={17} />
                  追加
                </button>
              </div>
            </div>

            {collectedFloorplans.length > 0 ? (
              <section className="auto-floorplan-section" id="floorplans">
                <div className="section-heading compact">
                  <div>
                    <p className="eyebrow">自動収集</p>
                    <h3>収集した間取り図</h3>
                  </div>
                  <span className="status-pill on">{collectedFloorplans.length}件</span>
                </div>
                <div className="floorplan-gallery">
                  {collectedFloorplans.map((item) => (
                    <article className="floorplan-tile" key={item.id}>
                      <button className="floorplan-image-button" type="button" onClick={() => openExternalUrl(item.imageLink)}>
                        <img src={item.imageUrl} alt={item.title} loading="lazy" />
                      </button>
                      <div className="floorplan-tile-body">
                        <h3>{item.title}</h3>
                        <p className="muted-text">{item.listingSource || "掲載元未入力"} / {item.layout || "間取り未抽出"}</p>
                        <p className="muted-text">取得日時：{formatDate(item.fetchedAt)}</p>
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
              </section>
            ) : null}

            {properties.length === 0 && collectedFloorplans.length === 0 ? (
              <section className="empty-state">
                <h2>最初の間取り図を登録しましょう</h2>
                <p>端末内の画像、スクリーンショット、画像URLを使ってローカル保存できます。</p>
                <div className="empty-actions">
                  <button className="primary-button" type="button" onClick={() => setIsCreating(true)}>
                    <Plus size={17} />
                    新規登録
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

      {view === "sites" ? (
        <main className="single-main">
          <SitesView sites={sites} onSaveSite={saveSite} onDeleteSite={deleteSite} />
        </main>
      ) : null}

      {view === "crawlSettings" ? (
        <main className="single-main">
          <CrawlSettingsView sites={sites} onSaveSite={saveSite} />
        </main>
      ) : null}

      {view === "candidates" ? (
        <main className="single-main">
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
        </main>
      ) : null}

      {view === "logs" ? (
        <main className="single-main">
          <LogsView logs={logs} onClearLogs={clearLogs} />
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
