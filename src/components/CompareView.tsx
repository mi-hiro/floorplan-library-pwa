import { X } from "lucide-react";
import type { FloorPlanProperty } from "../types";
import { formatNumber, getPrimaryFloorplan } from "../utils/format";
import { ImageViewer } from "./ImageViewer";

interface CompareViewProps {
  properties: FloorPlanProperty[];
  compareIds: string[];
  onRemove: (id: string) => void;
  onOpenLibrary: () => void;
}

function FeatureValue({ active }: { active: boolean }) {
  return <span className={active ? "yes-value" : "no-value"}>{active ? "あり" : "なし"}</span>;
}

export function CompareView({ properties, compareIds, onRemove, onOpenLibrary }: CompareViewProps) {
  const selected = compareIds.map((id) => properties.find((property) => property.id === id)).filter(Boolean) as FloorPlanProperty[];

  if (selected.length < 2) {
    return (
      <section className="empty-state">
        <h2>2件の間取り図を選んで比較</h2>
        <p>一覧カードの「比較」ボタンから2件まで追加できます。</p>
        <button className="primary-button" type="button" onClick={onOpenLibrary}>
          一覧で選ぶ
        </button>
      </section>
    );
  }

  return (
    <section className="compare-view">
      <div className="section-heading">
        <div>
          <p className="eyebrow">比較</p>
          <h2>間取り図2件比較</h2>
        </div>
        <button className="secondary-button" type="button" onClick={onOpenLibrary}>
          一覧へ戻る
        </button>
      </div>
      <div className="compare-grid">
        {selected.map((property) => (
          <article className="compare-panel" key={property.id}>
            <button className="icon-button compare-remove" type="button" title="比較から外す" onClick={() => onRemove(property.id)}>
              <X size={17} />
            </button>
            <ImageViewer image={getPrimaryFloorplan(property)} title={property.title} />
            <div className="compare-info">
              <h3>{property.title}</h3>
              <dl className="detail-list">
                <div>
                  <dt>間取り</dt>
                  <dd>{property.layout || "-"}</dd>
                </div>
                <div>
                  <dt>建物床面積</dt>
                  <dd>{formatNumber(property.areaSqm, "㎡")}</dd>
                </div>
                <div>
                  <dt>坪数</dt>
                  <dd>{formatNumber(property.tsubo, "坪")}</dd>
                </div>
                <div>
                  <dt>階数</dt>
                  <dd>{property.floors || "-"}</dd>
                </div>
                <div>
                  <dt>玄関向き</dt>
                  <dd>{property.entranceDirection || "-"}</dd>
                </div>
                <div>
                  <dt>価格</dt>
                  <dd>{formatNumber(property.priceManYen, "万円")}</dd>
                </div>
                <div>
                  <dt>LDK帖数</dt>
                  <dd>{formatNumber(property.ldkTatami, "帖")}</dd>
                </div>
                <div>
                  <dt>ファミクロ</dt>
                  <dd><FeatureValue active={property.hasFamilyCloset} /></dd>
                </div>
                <div>
                  <dt>ランドリー</dt>
                  <dd><FeatureValue active={property.hasLaundry} /></dd>
                </div>
                <div>
                  <dt>パントリー</dt>
                  <dd><FeatureValue active={property.hasPantry} /></dd>
                </div>
                <div>
                  <dt>回遊動線</dt>
                  <dd><FeatureValue active={property.hasCircularFlow} /></dd>
                </div>
              </dl>
              <div className="memo-box">{property.memo || "メモなし"}</div>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
