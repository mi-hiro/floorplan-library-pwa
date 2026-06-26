import type { FloorPlanProperty, PropertyImage } from "../types";

export function makeId(prefix: string) {
  const random = crypto.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `${prefix}_${random}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function calculateTsubo(areaSqm?: number) {
  if (!areaSqm || Number.isNaN(areaSqm)) return undefined;
  return Math.round((areaSqm / 3.305785) * 100) / 100;
}

export function formatNumber(value?: number, suffix = "") {
  if (value === undefined || value === null || Number.isNaN(value)) return "-";
  return `${value.toLocaleString("ja-JP", { maximumFractionDigits: 2 })}${suffix}`;
}

export function formatDate(value?: string) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(value));
}

export function getPrimaryFloorplan(property: FloorPlanProperty) {
  return property.images.find((image) => image.kind === "floorplan");
}

export function getImageSrc(image?: PropertyImage) {
  if (!image) return "";
  return image.dataUrl || image.url || "";
}

export function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function parseTags(value: string) {
  return value
    .split(/[,\n、#]+/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

export function tagsToText(tags: string[]) {
  return tags.join(", ");
}

export function normalizeNumber(value: string) {
  if (!value.trim()) return undefined;
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : undefined;
}

export function openExternalUrl(url: string) {
  if (!url) return;
  window.open(url, "_blank", "noopener,noreferrer");
}
