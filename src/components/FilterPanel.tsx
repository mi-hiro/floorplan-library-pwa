import { RotateCcw, Search } from "lucide-react";
import type { EntranceDirection, FilterState, FloorCount, LayoutType } from "../types";
import { DIRECTION_OPTIONS, FLOOR_OPTIONS, LAYOUT_OPTIONS } from "../types";

interface FilterPanelProps {
  filters: FilterState;
  onChange: (filters: FilterState) => void;
  availableTags: string[];
  listingSources: string[];
  companies: string[];
}

export const defaultFilters: FilterState = {
  keyword: "",
  layout: "all",
  minArea: "",
  maxArea: "",
  minTsubo: "",
  maxTsubo: "",
  minPrice: "",
  maxPrice: "",
  entranceDirection: "all",
  floors: "all",
  floorplanStatus: "all",
  exteriorStatus: "all",
  listingSource: "",
  company: "",
  favoriteOnly: false,
  tag: "",
  minLdkTatami: "",
  hasFamilyCloset: false,
  hasLaundry: false,
  hasPantry: false,
  hasCircularFlow: false
};

export function FilterPanel({ filters, onChange, availableTags, listingSources, companies }: FilterPanelProps) {
  function update<K extends keyof FilterState>(key: K, value: FilterState[K]) {
    onChange({ ...filters, [key]: value });
  }

  return (
    <aside className="filter-panel" aria-label="絞り込み検索">
      <div className="filter-header">
        <div>
          <p className="eyebrow">絞り込み</p>
          <h2>間取り図を探す</h2>
        </div>
        <button className="icon-button" type="button" title="条件クリア" onClick={() => onChange(defaultFilters)}>
          <RotateCcw size={18} />
        </button>
      </div>

      <label className="search-field">
        <Search size={18} />
        <input
          value={filters.keyword}
          onChange={(event) => update("keyword", event.target.value)}
          placeholder="物件名・会社・メモ検索"
        />
      </label>

      <div className="filter-grid">
        <label className="field">
          <span>間取り</span>
          <select value={filters.layout} onChange={(event) => update("layout", event.target.value as LayoutType | "all")}>
            <option value="all">すべて</option>
            {LAYOUT_OPTIONS.map((layout) => (
              <option key={layout} value={layout}>
                {layout}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>階数</span>
          <select value={filters.floors} onChange={(event) => update("floors", event.target.value as FloorCount | "all")}>
            <option value="all">すべて</option>
            {FLOOR_OPTIONS.map((floor) => (
              <option key={floor} value={floor}>
                {floor}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>玄関向き</span>
          <select
            value={filters.entranceDirection}
            onChange={(event) => update("entranceDirection", event.target.value as EntranceDirection | "all")}
          >
            <option value="all">すべて</option>
            {DIRECTION_OPTIONS.map((direction) => (
              <option key={direction} value={direction}>
                {direction}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>間取り図</span>
          <select value={filters.floorplanStatus} onChange={(event) => update("floorplanStatus", event.target.value as FilterState["floorplanStatus"])}>
            <option value="all">すべて</option>
            <option value="with">あり</option>
            <option value="without">なし</option>
          </select>
        </label>
        <label className="field">
          <span>外観写真</span>
          <select value={filters.exteriorStatus} onChange={(event) => update("exteriorStatus", event.target.value as FilterState["exteriorStatus"])}>
            <option value="all">すべて</option>
            <option value="with">あり</option>
            <option value="without">なし</option>
          </select>
        </label>
      </div>

      <div className="range-grid">
        <label className="field">
          <span>最小㎡</span>
          <input inputMode="decimal" value={filters.minArea} onChange={(event) => update("minArea", event.target.value)} />
        </label>
        <label className="field">
          <span>最大㎡</span>
          <input inputMode="decimal" value={filters.maxArea} onChange={(event) => update("maxArea", event.target.value)} />
        </label>
        <label className="field">
          <span>最小坪</span>
          <input inputMode="decimal" value={filters.minTsubo} onChange={(event) => update("minTsubo", event.target.value)} />
        </label>
        <label className="field">
          <span>最大坪</span>
          <input inputMode="decimal" value={filters.maxTsubo} onChange={(event) => update("maxTsubo", event.target.value)} />
        </label>
        <label className="field">
          <span>最低価格</span>
          <input inputMode="numeric" value={filters.minPrice} onChange={(event) => update("minPrice", event.target.value)} />
        </label>
        <label className="field">
          <span>最高価格</span>
          <input inputMode="numeric" value={filters.maxPrice} onChange={(event) => update("maxPrice", event.target.value)} />
        </label>
      </div>

      <div className="filter-grid">
        <label className="field">
          <span>掲載元</span>
          <input list="listing-source-options" value={filters.listingSource} onChange={(event) => update("listingSource", event.target.value)} />
          <datalist id="listing-source-options">
            {listingSources.map((source) => (
              <option key={source} value={source} />
            ))}
          </datalist>
        </label>
        <label className="field">
          <span>会社名</span>
          <input list="company-options" value={filters.company} onChange={(event) => update("company", event.target.value)} />
          <datalist id="company-options">
            {companies.map((company) => (
              <option key={company} value={company} />
            ))}
          </datalist>
        </label>
        <label className="field">
          <span>タグ</span>
          <input list="tag-options" value={filters.tag} onChange={(event) => update("tag", event.target.value)} />
          <datalist id="tag-options">
            {availableTags.map((tag) => (
              <option key={tag} value={tag} />
            ))}
          </datalist>
        </label>
        <label className="field">
          <span>LDK最小帖数</span>
          <input inputMode="decimal" value={filters.minLdkTatami} onChange={(event) => update("minLdkTatami", event.target.value)} />
        </label>
      </div>

      <div className="toggle-grid compact">
        <label className="toggle">
          <input type="checkbox" checked={filters.favoriteOnly} onChange={(event) => update("favoriteOnly", event.target.checked)} />
          お気に入りのみ
        </label>
        <label className="toggle">
          <input type="checkbox" checked={filters.hasFamilyCloset} onChange={(event) => update("hasFamilyCloset", event.target.checked)} />
          ファミクロあり
        </label>
        <label className="toggle">
          <input type="checkbox" checked={filters.hasLaundry} onChange={(event) => update("hasLaundry", event.target.checked)} />
          ランドリーあり
        </label>
        <label className="toggle">
          <input type="checkbox" checked={filters.hasPantry} onChange={(event) => update("hasPantry", event.target.checked)} />
          パントリーあり
        </label>
        <label className="toggle">
          <input type="checkbox" checked={filters.hasCircularFlow} onChange={(event) => update("hasCircularFlow", event.target.checked)} />
          回遊動線あり
        </label>
      </div>
    </aside>
  );
}
