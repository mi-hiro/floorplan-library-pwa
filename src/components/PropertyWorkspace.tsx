import {
  ExternalLink,
  Heart,
  ImagePlus,
  Save,
  Trash2,
  X
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
  EntranceDirection,
  FloorCount,
  FloorPlanProperty,
  ImageKind,
  LayoutType,
  PropertyImage
} from "../types";
import {
  DIRECTION_OPTIONS,
  FLOOR_OPTIONS,
  IMAGE_KIND_LABELS,
  IMAGE_KIND_OPTIONS,
  LAYOUT_OPTIONS
} from "../types";
import {
  calculateTsubo,
  fileToDataUrl,
  getPrimaryFloorplan,
  makeId,
  normalizeNumber,
  nowIso,
  openExternalUrl,
  parseTags,
  tagsToText
} from "../utils/format";
import { ImageViewer } from "./ImageViewer";

interface PropertyWorkspaceProps {
  property?: FloorPlanProperty;
  onSave: (property: FloorPlanProperty) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

function createBlankProperty(): FloorPlanProperty {
  const createdAt = nowIso();
  return {
    id: makeId("property"),
    title: "",
    listingSource: "",
    sourceUrl: "",
    company: "",
    layout: "",
    floors: "",
    entranceDirection: "",
    hasFamilyCloset: false,
    hasLaundry: false,
    hasPantry: false,
    hasCircularFlow: false,
    images: [],
    favorite: false,
    tags: [],
    memo: "",
    createdAt,
    updatedAt: createdAt
  };
}

function textOrNumber(value?: number) {
  return value === undefined ? "" : String(value);
}

export function PropertyWorkspace({ property, onSave, onDelete, onClose }: PropertyWorkspaceProps) {
  const [draft, setDraft] = useState<FloorPlanProperty>(() => property ?? createBlankProperty());
  const [selectedImageId, setSelectedImageId] = useState<string>("");
  const [newImageKind, setNewImageKind] = useState<ImageKind>("floorplan");
  const [imageUrl, setImageUrl] = useState("");
  const [tagsText, setTagsText] = useState(tagsToText(property?.tags ?? []));

  useEffect(() => {
    const next = property ?? createBlankProperty();
    setDraft(next);
    setTagsText(tagsToText(next.tags));
    setSelectedImageId(getPrimaryFloorplan(next)?.id ?? next.images[0]?.id ?? "");
  }, [property]);

  useEffect(() => {
    if (selectedImageId && draft.images.some((image) => image.id === selectedImageId)) return;
    setSelectedImageId(getPrimaryFloorplan(draft)?.id ?? draft.images[0]?.id ?? "");
  }, [draft.images, selectedImageId, draft]);

  const selectedImage = useMemo(
    () => draft.images.find((image) => image.id === selectedImageId) ?? getPrimaryFloorplan(draft) ?? draft.images[0],
    [draft, selectedImageId]
  );

  function update<K extends keyof FloorPlanProperty>(key: K, value: FloorPlanProperty[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function updateNumber(key: keyof FloorPlanProperty, value: string) {
    const parsed = normalizeNumber(value);
    setDraft((current) => {
      const next = { ...current, [key]: parsed };
      if (key === "areaSqm") {
        next.tsubo = calculateTsubo(parsed);
      }
      return next;
    });
  }

  async function handleFiles(files: FileList | null) {
    if (!files?.length) return;
    const createdAt = nowIso();
    const images: PropertyImage[] = await Promise.all(
      [...files].map(async (file) => ({
        id: makeId("image"),
        kind: newImageKind,
        sourceType: "upload",
        storageMode: "dataUrl",
        dataUrl: await fileToDataUrl(file),
        label: file.name,
        noteLabels: ["個人メモ用", "外部共有不可"],
        createdAt
      }))
    );

    setDraft((current) => ({ ...current, images: [...current.images, ...images] }));
    setSelectedImageId(images[0]?.id ?? "");
  }

  function addUrlImage() {
    if (!imageUrl.trim()) return;
    const image: PropertyImage = {
      id: makeId("image"),
      kind: newImageKind,
      sourceType: "url",
      storageMode: "urlOnly",
      url: imageUrl.trim(),
      noteLabels: ["個人メモ用", "外部共有不可"],
      createdAt: nowIso()
    };
    setDraft((current) => ({ ...current, images: [...current.images, image] }));
    setSelectedImageId(image.id);
    setImageUrl("");
  }

  function changeImageKind(imageId: string, kind: ImageKind) {
    setDraft((current) => ({
      ...current,
      images: current.images.map((image) => (image.id === imageId ? { ...image, kind } : image))
    }));
  }

  function removeImage(imageId: string) {
    setDraft((current) => ({ ...current, images: current.images.filter((image) => image.id !== imageId) }));
  }

  function save() {
    const updatedAt = nowIso();
    onSave({
      ...draft,
      title: draft.title.trim() || "名称未設定",
      listingSource: draft.listingSource.trim(),
      sourceUrl: draft.sourceUrl.trim(),
      company: draft.company.trim(),
      tags: parseTags(tagsText),
      tsubo: calculateTsubo(draft.areaSqm),
      updatedAt
    });
  }

  return (
    <div className="workspace-backdrop" role="dialog" aria-modal="true" aria-label="物件詳細と編集">
      <div className="workspace-panel">
        <div className="workspace-header">
          <div>
            <p className="eyebrow">物件詳細</p>
            <h2>{draft.title || "新しい間取り図"}</h2>
          </div>
          <div className="header-actions">
            <button
              className={`icon-button ${draft.favorite ? "is-active" : ""}`}
              type="button"
              title="お気に入り"
              onClick={() => update("favorite", !draft.favorite)}
            >
              <Heart size={19} fill={draft.favorite ? "currentColor" : "none"} />
            </button>
            {draft.sourceUrl ? (
              <button className="ghost-button" type="button" onClick={() => openExternalUrl(draft.sourceUrl)}>
                <ExternalLink size={17} />
                元ページ
              </button>
            ) : null}
            <button className="primary-button" type="button" onClick={save}>
              <Save size={17} />
              保存
            </button>
            <button className="icon-button" type="button" title="閉じる" onClick={onClose}>
              <X size={19} />
            </button>
          </div>
        </div>

        <div className="workspace-grid">
          <div className="workspace-media">
            <ImageViewer image={selectedImage} title={draft.title || "間取り図"} />
            <div className="image-strip" aria-label="画像一覧">
              {draft.images.length === 0 ? (
                <span className="muted-text">画像はまだありません</span>
              ) : (
                draft.images.map((image) => (
                  <button
                    type="button"
                    key={image.id}
                    className={`image-chip ${image.id === selectedImage?.id ? "is-selected" : ""}`}
                    onClick={() => setSelectedImageId(image.id)}
                  >
                    {IMAGE_KIND_LABELS[image.kind]}
                  </button>
                ))
              )}
            </div>

            <section className="subpanel">
              <div className="subpanel-title">
                <ImagePlus size={18} />
                画像追加
              </div>
              <div className="image-add-grid">
                <label className="field">
                  <span>画像種別</span>
                  <select value={newImageKind} onChange={(event) => setNewImageKind(event.target.value as ImageKind)}>
                    {IMAGE_KIND_OPTIONS.map((kind) => (
                      <option key={kind} value={kind}>
                        {IMAGE_KIND_LABELS[kind]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="file-drop">
                  <input type="file" accept="image/*" multiple onChange={(event) => handleFiles(event.target.files)} />
                  端末内の画像・スクリーンショットを選択
                </label>
              </div>
              <div className="url-add-row">
                <input
                  value={imageUrl}
                  onChange={(event) => setImageUrl(event.target.value)}
                  placeholder="画像URLを手動登録"
                />
                <button className="secondary-button" type="button" onClick={addUrlImage}>
                  追加
                </button>
              </div>
            </section>

            {draft.images.length > 0 ? (
              <section className="subpanel">
                <div className="subpanel-title">画像管理</div>
                <div className="image-manager">
                  {draft.images.map((image) => (
                    <div className="image-row" key={image.id}>
                      <select value={image.kind} onChange={(event) => changeImageKind(image.id, event.target.value as ImageKind)}>
                        {IMAGE_KIND_OPTIONS.map((kind) => (
                          <option key={kind} value={kind}>
                            {IMAGE_KIND_LABELS[kind]}
                          </option>
                        ))}
                      </select>
                      <span>{image.sourceType === "url" ? "URL参照" : "ローカル保存"}</span>
                      <div className="label-row">
                        {image.noteLabels.map((label) => (
                          <span className="warning-label" key={label}>
                            {label}
                          </span>
                        ))}
                      </div>
                      <button className="icon-button danger" type="button" title="画像削除" onClick={() => removeImage(image.id)}>
                        <Trash2 size={17} />
                      </button>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}
          </div>

          <form className="edit-form" onSubmit={(event) => event.preventDefault()}>
            <div className="form-section">
              <h3>基本情報</h3>
              <label className="field">
                <span>物件名</span>
                <input value={draft.title} onChange={(event) => update("title", event.target.value)} placeholder="例：回遊動線のある4LDK" />
              </label>
              <div className="form-grid two">
                <label className="field">
                  <span>掲載元名</span>
                  <input value={draft.listingSource} onChange={(event) => update("listingSource", event.target.value)} />
                </label>
                <label className="field">
                  <span>会社名</span>
                  <input value={draft.company} onChange={(event) => update("company", event.target.value)} />
                </label>
              </div>
              <label className="field">
                <span>元ページURL</span>
                <input value={draft.sourceUrl} onChange={(event) => update("sourceUrl", event.target.value)} placeholder="https://..." />
              </label>
            </div>

            <div className="form-section">
              <h3>間取り情報</h3>
              <div className="form-grid two">
                <label className="field">
                  <span>間取り</span>
                  <select value={draft.layout} onChange={(event) => update("layout", event.target.value as LayoutType)}>
                    <option value="">未選択</option>
                    {LAYOUT_OPTIONS.map((layout) => (
                      <option key={layout} value={layout}>
                        {layout}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>階数</span>
                  <select value={draft.floors} onChange={(event) => update("floors", event.target.value as FloorCount)}>
                    <option value="">未選択</option>
                    {FLOOR_OPTIONS.map((floor) => (
                      <option key={floor} value={floor}>
                        {floor}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>建物床面積㎡</span>
                  <input inputMode="decimal" value={textOrNumber(draft.areaSqm)} onChange={(event) => updateNumber("areaSqm", event.target.value)} />
                </label>
                <label className="field">
                  <span>坪数</span>
                  <input value={draft.tsubo ? draft.tsubo.toFixed(2) : ""} readOnly />
                </label>
                <label className="field">
                  <span>玄関の向き</span>
                  <select value={draft.entranceDirection} onChange={(event) => update("entranceDirection", event.target.value as EntranceDirection)}>
                    <option value="">未選択</option>
                    {DIRECTION_OPTIONS.map((direction) => (
                      <option key={direction} value={direction}>
                        {direction}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>価格（万円）</span>
                  <input inputMode="numeric" value={textOrNumber(draft.priceManYen)} onChange={(event) => updateNumber("priceManYen", event.target.value)} />
                </label>
                <label className="field">
                  <span>LDK帖数</span>
                  <input inputMode="decimal" value={textOrNumber(draft.ldkTatami)} onChange={(event) => updateNumber("ldkTatami", event.target.value)} />
                </label>
                <label className="field">
                  <span>主寝室帖数</span>
                  <input
                    inputMode="decimal"
                    value={textOrNumber(draft.masterBedroomTatami)}
                    onChange={(event) => updateNumber("masterBedroomTatami", event.target.value)}
                  />
                </label>
                <label className="field">
                  <span>子供部屋数</span>
                  <input
                    inputMode="numeric"
                    value={textOrNumber(draft.childrenRoomCount)}
                    onChange={(event) => updateNumber("childrenRoomCount", event.target.value)}
                  />
                </label>
              </div>
            </div>

            <div className="form-section">
              <h3>特徴</h3>
              <div className="toggle-grid">
                <label className="toggle">
                  <input type="checkbox" checked={draft.hasFamilyCloset} onChange={(event) => update("hasFamilyCloset", event.target.checked)} />
                  ファミクロ
                </label>
                <label className="toggle">
                  <input type="checkbox" checked={draft.hasLaundry} onChange={(event) => update("hasLaundry", event.target.checked)} />
                  ランドリー
                </label>
                <label className="toggle">
                  <input type="checkbox" checked={draft.hasPantry} onChange={(event) => update("hasPantry", event.target.checked)} />
                  パントリー
                </label>
                <label className="toggle">
                  <input type="checkbox" checked={draft.hasCircularFlow} onChange={(event) => update("hasCircularFlow", event.target.checked)} />
                  回遊動線
                </label>
              </div>
            </div>

            <div className="form-section">
              <h3>メモ・タグ</h3>
              <label className="field">
                <span>タグ</span>
                <input value={tagsText} onChange={(event) => setTagsText(event.target.value)} placeholder="平屋, ランドリー, 南玄関" />
              </label>
              <label className="field">
                <span>メモ</span>
                <textarea value={draft.memo} onChange={(event) => update("memo", event.target.value)} rows={5} />
              </label>
            </div>

            <div className="form-footer">
              {property ? (
                <button className="danger-button" type="button" onClick={() => onDelete(draft.id)}>
                  <Trash2 size={17} />
                  削除
                </button>
              ) : (
                <span />
              )}
              <button className="primary-button" type="button" onClick={save}>
                <Save size={17} />
                保存
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
