import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const BUNDLED_NODE_MODULES = "C:/Users/fujis/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules";
let jpegDecoder = null;
let pngDecoder = null;

export async function analyzeImageBytes(bytes) {
  const decoded = decodeRaster(bytes);
  if (!decoded.ok) return { available: false, hardReject: false, reason: decoded.reason };

  const { data, width, height } = decoded;
  if (width < 220 || height < 160) return { available: true, hardReject: true, category: "other", reason: "image too small", width, height };

  const maxSamplesPerAxis = 96;
  const stepX = Math.max(1, Math.floor(width / maxSamplesPerAxis));
  const stepY = Math.max(1, Math.floor(height / maxSamplesPerAxis));
  let pixels = 0;
  let white = 0;
  let dark = 0;
  let saturated = 0;
  let colorDistance = 0;
  let grayish = 0;
  let lightColored = 0;

  for (let y = 0; y < height; y += stepY) {
    for (let x = 0; x < width; x += stepX) {
      const i = (y * width + x) * 4;
      const alpha = data[i + 3] ?? 255;
      if (alpha < 32) continue;
      const r = data[i] / 255;
      const g = data[i + 1] / 255;
      const b = data[i + 2] / 255;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const saturation = max === 0 ? 0 : (max - min) / max;
      if (luma > 0.82 && saturation < 0.18) white += 1;
      if (luma < 0.22) dark += 1;
      if (saturation > 0.25 && luma > 0.18) saturated += 1;
      if (saturation < 0.12) grayish += 1;
      if (luma > 0.55 && saturation > 0.2) lightColored += 1;
      colorDistance += Math.abs(r - g) + Math.abs(g - b) + Math.abs(b - r);
      pixels += 1;
    }
  }

  pixels = Math.max(1, pixels);
  const whiteRatio = white / pixels;
  const darkRatio = dark / pixels;
  const saturatedRatio = saturated / pixels;
  const grayishRatio = grayish / pixels;
  const lightColoredRatio = lightColored / pixels;
  const colorfulness = colorDistance / pixels / 3;
  const aspectRatio = width / Math.max(1, height);
  const bannerLike = aspectRatio > 3.5 || aspectRatio < 0.22;
  const floorplanLike = whiteRatio > 0.45 && grayishRatio > 0.55 && saturatedRatio < 0.22 && darkRatio > 0.01 && !bannerLike;
  const photoLike =
    (saturatedRatio > 0.32 && whiteRatio < 0.68) ||
    (colorfulness > 0.16 && lightColoredRatio > 0.28) ||
    (whiteRatio < 0.28 && saturatedRatio > 0.18);

  return {
    available: true,
    width,
    height,
    whiteRatio: round(whiteRatio),
    darkRatio: round(darkRatio),
    saturatedRatio: round(saturatedRatio),
    grayishRatio: round(grayishRatio),
    colorfulness: round(colorfulness),
    bannerLike,
    floorplanLike,
    photoLike,
    hardReject: bannerLike || photoLike,
    category: bannerLike ? "banner" : photoLike ? "interior_photo" : "unknown",
    reason: bannerLike ? "banner-like aspect ratio" : photoLike ? "photo-like color and texture" : "no hard visual reject"
  };
}

function decodeRaster(bytes) {
  if (isPng(bytes)) {
    try {
      pngDecoder ??= require(`${BUNDLED_NODE_MODULES}/pngjs`);
      const decoded = pngDecoder.PNG.sync.read(bytes);
      return { ok: true, width: decoded.width, height: decoded.height, data: decoded.data };
    } catch (error) {
      return { ok: false, reason: `png decode failed: ${error.message}` };
    }
  }
  if (isJpeg(bytes)) {
    try {
      jpegDecoder ??= require(`${BUNDLED_NODE_MODULES}/jpeg-js`);
      const decoded = jpegDecoder.decode(bytes, { useTArray: true, maxMemoryUsageInMB: 512 });
      return { ok: true, width: decoded.width, height: decoded.height, data: decoded.data };
    } catch (error) {
      return { ok: false, reason: `jpeg decode failed: ${error.message}` };
    }
  }
  return { ok: false, reason: "unsupported image format for byte features" };
}

function isPng(bytes) {
  return bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
}

function isJpeg(bytes) {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function round(value) {
  return Number((Number(value) || 0).toFixed(4));
}
