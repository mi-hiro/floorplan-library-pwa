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
import type { CrawlCandidate, CrawlLog, CrawlSite, FilterState, FloorPlanProperty, ViewKey } from "./types";
import {
  calculateTsubo,
  formatDate,
  getPrimaryFloorplan,
  makeId,
  normalizeNumber,
  nowIso
} from "./utils/format";

const navItems: { key: ViewKey; label: string; icon: React.ElementType }[] = [
  { key: "library", label: "ライブラリ", icon: LayoutGrid },
  { key: "compare", label: "比較", icon: Scale },
  { key: "sites", label: "サイト管理", icon: ShieldCheck },
  { key: "crawlSettings", label: "巡回設定", icon: Settings },
  { key: "candidates", label: "取得候補", icon: ClipboardList },
  { key: "logs", label: "巡回ログ", icon: Database }
];

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
    images: [],
    favorite: false,
    tags: ["確認済み候補"],
    memo: candidate.memo || "取得候補から正式登録。必要に応じて間取り図を手動追加してください。",
    createdAt,
    updatedAt: createdAt,
    lastCheckedAt: candidate.fetchedAt
  };
}

export default function App() {
  const [view, setView] = useState<ViewKey>("library");
  const [properties, setProperties] = useState<FloorPlanProperty[]>([]);
  const [sites, setSites] = useState<CrawlSite[]>([]);
  const [candidates, setCandidates] = useState<CrawlCandidate[]>([]);
  const [logs, setLogs] = useState<CrawlLog[]>([]);
  const [filters, setFilters] = useState<FilterState>(defaultFilters);
  const [editingProperty, setEditingProperty] = useState<FloorPlanProperty | undefined>();
  const [isCreating, setIsCreating] = useState(false);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

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

    async function boot() {
      await ensureDefaultSites();
      await addInitialLog();
      if (!cancelled) {
        await refreshData();
        setLoading(false);
      }
    }

    boot();
    return () => {
      cancelled = true;
    };
  }, []);

  const filteredProperties = useMemo(() => filterProperties(properties, filters), [properties, filters]);
  const availableTags = useMemo(() => [...new Set(properties.flatMap((property) => property.tags))].sort(), [properties]);
  const listingSources = useMemo(() => [...new Set(properties.map((property) => property.listingSource).filter(Boolean))].sort(), [properties]);
  const companies = useMemo(() => [...new Set(properties.map((property) => property.company).filter(Boolean))].sort(), [properties]);
  const floorplanCount = useMemo(() => properties.filter((property) => getPrimaryFloorplan(property)).length, [properties]);

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
      message: "サイト設定を保存しました。自動巡回処理はMVPでは実行されません。"
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
                <h2>間取り図サムネイル</h2>
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

            {properties.length === 0 ? (
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
            ) : filteredProperties.length === 0 ? (
              <section className="empty-state">
                <h2>条件に合う間取り図がありません</h2>
                <p>検索条件を少しゆるめると見つかるかもしれません。</p>
                <button className="secondary-button" type="button" onClick={() => setFilters(defaultFilters)}>
                  条件をクリア
                </button>
              </section>
            ) : (
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
            )}
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
