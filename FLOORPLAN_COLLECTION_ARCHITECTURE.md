# Floorplan Collection Architecture

This project separates collection from acceptance.

- `data/candidate-images.jsonl`: broad image/PDF candidates. These are not shown in the normal PWA list.
- `data/accepted-floorplans.jsonl`: accepted floorplans only. Records are upserted and are not deleted during normal updates.
- `data/rejected-images.jsonl`: non-floorplan images and block-list records.
- `data/review-queue.jsonl`: uncertain images that need review or a working vision model.
- `public/data/floorplans.json`: accepted-only public feed consumed by the PWA.

The accepted pipeline is intentionally conservative. URL text and page titles can create candidates, but they do not create accepted records by themselves. Accepted records require a checked floorplan classification with confidence at or above `0.85` and no hard reject signals.

## Commands

```powershell
npm run floorplans:backfill
npm run floorplans:daily
npm run floorplans:promote
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

## Ollama

When Ollama is unavailable, unchecked candidates stay in `candidate-images.jsonl` or `review-queue.jsonl`; they are not promoted to `accepted-floorplans.jsonl`.

## PDF

PDF URLs are collected as candidates and placed into review unless a local PDF renderer is available and wired into visual/Ollama classification. PDF pages are never accepted wholesale.
