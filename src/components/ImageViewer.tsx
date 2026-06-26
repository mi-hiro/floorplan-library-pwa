import { Minus, RotateCcw, RotateCw, ZoomIn } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { PropertyImage } from "../types";
import { IMAGE_KIND_LABELS } from "../types";
import { getImageSrc } from "../utils/format";

interface ImageViewerProps {
  image?: PropertyImage;
  title: string;
  emptyText?: string;
}

export function ImageViewer({ image, title, emptyText = "間取り図未登録" }: ImageViewerProps) {
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const pointers = useRef(new Map<number, PointerEvent>());
  const lastPinchDistance = useRef<number | null>(null);
  const imageSrc = getImageSrc(image);

  useEffect(() => {
    setZoom(1);
    setRotation(0);
  }, [image?.id]);

  const transform = useMemo(() => `scale(${zoom}) rotate(${rotation}deg)`, [zoom, rotation]);

  function clampZoom(nextZoom: number) {
    return Math.min(4, Math.max(0.5, Math.round(nextZoom * 100) / 100));
  }

  function handleWheel(event: React.WheelEvent<HTMLDivElement>) {
    if (!imageSrc) return;
    event.preventDefault();
    setZoom((current) => clampZoom(current + (event.deltaY < 0 ? 0.12 : -0.12)));
  }

  function getPinchDistance() {
    const active = [...pointers.current.values()];
    if (active.length < 2) return null;
    const [first, second] = active;
    return Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY);
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    pointers.current.set(event.pointerId, event.nativeEvent);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, event.nativeEvent);
    const distance = getPinchDistance();
    if (!distance) return;

    if (lastPinchDistance.current) {
      const delta = distance / lastPinchDistance.current;
      setZoom((current) => clampZoom(current * delta));
    }
    lastPinchDistance.current = distance;
  }

  function handlePointerEnd(event: React.PointerEvent<HTMLDivElement>) {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) lastPinchDistance.current = null;
  }

  return (
    <section className="viewer" aria-label={`${title}の画像ビューア`}>
      <div className="viewer-toolbar">
        <div>
          <p className="viewer-title">{title}</p>
          {image ? <span className="mini-label">{IMAGE_KIND_LABELS[image.kind]}</span> : null}
        </div>
        <div className="icon-row">
          <button className="icon-button" type="button" title="拡大" onClick={() => setZoom((value) => clampZoom(value + 0.2))}>
            <ZoomIn size={18} />
          </button>
          <button className="icon-button" type="button" title="縮小" onClick={() => setZoom((value) => clampZoom(value - 0.2))}>
            <Minus size={18} />
          </button>
          <button className="icon-button" type="button" title="右回転" onClick={() => setRotation((value) => value + 90)}>
            <RotateCw size={18} />
          </button>
          <button
            className="icon-button"
            type="button"
            title="表示をリセット"
            onClick={() => {
              setZoom(1);
              setRotation(0);
            }}
          >
            <RotateCcw size={18} />
          </button>
        </div>
      </div>
      <div
        className="image-stage"
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
      >
        {imageSrc ? (
          <img
            src={imageSrc}
            alt={title}
            className="zoomable-image"
            style={{ transform }}
            draggable={false}
          />
        ) : (
          <div className="empty-image">
            <strong>{emptyText}</strong>
            <span>画像追加から間取り図を登録できます</span>
          </div>
        )}
      </div>
    </section>
  );
}
