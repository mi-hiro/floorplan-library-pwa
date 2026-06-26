# 都道府県ローテーション発見モード

都道府県ごとに住宅会社・建設会社・工務店の元ページを探し、取得済みURLを消さずに蓄積します。

## 使い方

```powershell
.\run-prefecture-discovery.ps1
```

実行すると、次に検索する都道府県と検索語が `.tmp/prefecture-search-queries.txt` に出ます。

Chromeで検索し、元ページURLを `.tmp/prefecture-search-links.json` に保存してから、もう一度実行します。

取り込みが終わると、検索済みリンクは `.tmp/prefecture-search-links-imported-日時.json` に退避され、次の都道府県の検索語が作られます。

## 進み方

- 初期設定では1回に3県
- 1県あたり4検索語
- 47都道府県を最後まで回ると、また最初に戻る
- URLを取り込めた時だけ次の都道府県へ進む
- 進み具合は `crawler-output/prefecture-discovery-state.json` に保存
- 発見済みURLは `crawler-output/discovered-sources.json` に追記

## 方針

Google画像のサムネイル画像そのものは保存しません。地域検索は、住宅会社・工務店の元ページを見つける入口として使います。

元ページを低頻度で巡回し、Ollamaで本当に間取り図か判定した画像だけアプリに追加します。

施工事例一覧ページは、1ページで終わらせず、詳細ページを少しだけたどる設定にします。写真中心のページはOllamaで落とします。

## 毎日自動で進める

```powershell
.\run-auto-floorplan-growth.ps1
```

このスクリプトは、次の都道府県分を少しずつ進めます。

- 県別の住宅会社・工務店候補を追加
- サイトマップから施工事例・プラン集の奥ページを追加
- Common Crawlの保存ページも確認
- Ollamaで間取り図候補を確認
- `crawler-output/latest-crawl.json` を公開先へ反映

公開だけ止めたい場合:

```powershell
.\run-auto-floorplan-growth.ps1 -NoPublish
```
