# Floorplan Collection Architecture

This project separates collection from acceptance.

- `data/candidate-images.jsonl`: broad image/PDF candidates. These are not shown in the normal PWA list.
- `data/accepted-floorplans.jsonl`: accepted floorplans only. Records are upserted and are not deleted during normal updates.
- `data/rejected-images.jsonl`: non-floorplan images and block-list records.
- `data/review-queue.jsonl`: uncertain images that need review or a working vision model.
- `public/data/floorplans.json`: accepted-only public feed consumed by the PWA.

The accepted pipeline is intentionally conservative. URL text and page titles can create candidates, but they do not create accepted records by themselves. Accepted records require a checked floorplan classification with confidence at or above `0.85`, image-specific floorplan evidence, and no hard reject signals.

## Data Flow

1. Collect many candidates from Common Crawl, sitemap/image sitemap, WordPress REST, PDF links, and domain adapters.
2. Save every broad candidate to `data/candidate-images.jsonl`.
3. Remove obvious noise such as exterior photos, interior photos, banners, logos, maps, charts, and YouTube thumbnails to `data/rejected-images.jsonl`.
4. Run local byte-level checks for JPEG/PNG files to reject photo-like color/texture and banner-like aspect ratios before promotion. WebP files are converted to PNG with `sharp` before byte checks and Ollama review.
5. Send plausible images to Ollama Vision when available.
6. Promote only images classified as top-down floorplans with room/wall boundaries and confidence `>= 0.85`.
7. Keep uncertain or unchecked items in `data/review-queue.jsonl`.
8. Build `public/data/floorplans.json` only from `data/accepted-floorplans.jsonl`.

`crawler-output/latest-crawl.json` is no longer the permanent accepted database. It can still be imported as a candidate source, but the PWA's standard feed is generated from accepted records only.

## Commands

```powershell
npm run floorplans:backfill
npm run floorplans:daily
npm run floorplans:promote
npm run floorplans:sitemap
npm run floorplans:wordpress
npm run floorplans:build-public
npm run floorplans:validate
```

Windows helpers:

```powershell
.\run-floorplan-backfill.ps1
.\run-floorplan-daily.ps1
.\register-floorplan-daily-task.ps1
```

## Safety

The pipeline keeps the existing rules: respect robots.txt, stop on 403/429/CAPTCHA/login requirements, do not bypass blocks, do not scrape Google Images result pages, and keep major portals off by default.

Daily runs are intentionally small. They prefer domains with good past results, store crawl state in `data/crawl-state.json`, and avoid repeatedly hitting domains that recently returned a block or timeout.

## Ollama

When Ollama is unavailable, unchecked candidates stay in `candidate-images.jsonl` or `review-queue.jsonl`; they are not promoted to `accepted-floorplans.jsonl`.

The repository example keeps `llama3.2-vision:11b` as the preferred high-quality model. On this PC, the active config uses `moondream:latest` first because it is much faster than `llava:latest`. Missing confidence is not accepted automatically.

WebP images are common on builder sites. `sharp` is used only to convert WebP to PNG before sending images to Ollama, because some local vision models reject WebP input. If `sharp` is unavailable, WebP candidates remain in review/candidate data and are not accepted.

## PDF

PDF URLs are collected as candidates and placed into review unless a local PDF renderer is available and wired into visual/Ollama classification. PDF pages are never accepted wholesale.

## Backfill vs Daily

Backfill is for first run or monthly expansion:

```powershell
.\run-floorplan-backfill.ps1
```

Daily is for low-frequency growth:

```powershell
.\run-floorplan-daily.ps1
```

Register the daily task:

```powershell
.\register-floorplan-daily-task.ps1
```

The accepted database is append/upsert based. Existing accepted floorplans are not deleted when new candidates are collected.
