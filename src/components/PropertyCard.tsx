import { ExternalLink, Heart, ImagePlus, Maximize2, Pencil, Scale } from "lucide-react";
import type { FloorPlanProperty } from "../types";
import { formatNumber, getImageSrc, getPrimaryFloorplan, openExternalUrl } from "../utils/format";

interface PropertyCardProps {
  property: FloorPlanProperty;
  selectedForCompare: boolean;
  onOpen: () => void;
  onEdit: () => void;
  onToggleFavorite: () => void;
  onToggleCompare: () => void;
}

export function PropertyCard({
  property,
  selectedForCompare,
  onOpen,
  onEdit,
  onToggleFavorite,
  onToggleCompare
}: PropertyCardProps) {
  const floorplan = getPrimaryFloorplan(property);
  const imageSrc = getImageSrc(floorplan);

  return (
    <article className="property-card">
      <button className="thumbnail-button" type="button" onClick={onOpen} aria-label={`${property.title}を詳細表示`}>
        {imageSrc ? (
          <img src={imageSrc} alt={`${property.title}の間取り図`} />
        ) : (
          <div className="thumbnail-empty">
            <strong>間取り図未登録</strong>
            <span>元ページで確認 / 画像を追加</span>
          </div>
        )}
      </button>
      <div className="card-body">
        <div className="card-title-row">
          <h3>{property.title}</h3>
          <button className={`icon-button ${property.favorite ? "is-active" : ""}`} type="button" title="お気に入り" onClick={onToggleFavorite}>
            <Heart size={18} fill={property.favorite ? "currentColor" : "none"} />
          </button>
        </div>
        <p className="source-line">
          {property.listingSource || "掲載元未入力"} / {property.company || "会社未入力"}
        </p>
        <dl className="spec-grid">
          <div>
            <dt>価格</dt>
            <dd>{formatNumber(property.priceManYen, "万円")}</dd>
          </div>
          <div>
            <dt>間取り</dt>
            <dd>{property.layout || "-"}</dd>
          </div>
          <div>
            <dt>面積</dt>
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
            <dt>玄関</dt>
            <dd>{property.entranceDirection || "-"}</dd>
          </div>
        </dl>
        <div className="tag-row">
          {property.tags.length > 0 ? property.tags.map((tag) => <span key={tag}>{tag}</span>) : <span>タグなし</span>}
        </div>
        <div className="card-actions">
          {property.sourceUrl ? (
            <button className="ghost-button" type="button" onClick={() => openExternalUrl(property.sourceUrl)}>
              <ExternalLink size={16} />
              元ページ
            </button>
          ) : null}
          <button className="ghost-button" type="button" onClick={onOpen}>
            <Maximize2 size={16} />
            詳細
          </button>
          {!imageSrc ? (
            <button className="ghost-button" type="button" onClick={onEdit}>
              <ImagePlus size={16} />
              画像追加
            </button>
          ) : null}
          <button className="ghost-button" type="button" onClick={onEdit}>
            <Pencil size={16} />
            編集
          </button>
          <button className={`ghost-button ${selectedForCompare ? "is-selected" : ""}`} type="button" onClick={onToggleCompare}>
            <Scale size={16} />
            比較
          </button>
        </div>
      </div>
    </article>
  );
}
