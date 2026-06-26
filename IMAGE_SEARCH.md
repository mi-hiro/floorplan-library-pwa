# 公式画像検索APIで間取り図を集める

通常のサイト巡回だけでは、サイト構造、robots.txt、画像の外部表示制限に左右されるため、間取り図を大量に集める用途には限界があります。

数を増やす場合は、Google画像検索画面を直接巡回するのではなく、公式APIを使います。画像URL、サムネイルURL、元ページURLをまとめて取得し、Webアプリの「収集した間取り図」に表示します。

## 対応API

今から新しく進める場合は `BRAVE_SEARCH_API_KEY` を使う方法が一番進めやすいです。Google Custom Search JSON APIは既存利用者向けになっているため、既に使えるキーがある場合の選択肢として残しています。

- Brave Search API
  - 画像検索エンドポイントを使います。
  - 必要な環境変数: `BRAVE_SEARCH_API_KEY`
  - 公式資料: https://api-dashboard.search.brave.com/app/documentation/image-search/get-started
- Google Custom Search JSON API
  - `searchType=image` を使います。
  - 必要な環境変数: `GOOGLE_CUSTOM_SEARCH_API_KEY`, `GOOGLE_CUSTOM_SEARCH_CX`
  - 公式資料: https://developers.google.com/custom-search/v1/reference/rest/v1/cse/list
- Bing Image Search API
  - 必要な環境変数: `BING_IMAGE_SEARCH_KEY`
  - 公式資料: https://learn.microsoft.com/en-us/previous-versions/bing/search-apis/bing-image-search/reference/endpoints

## 実行

PowerShellでこのフォルダを開いて、APIキーを設定したうえで実行します。

```powershell
.\set-image-search-keys.ps1
.\run-image-search.ps1
```

結果は `crawler-output/latest-crawl.json` に保存され、GitHub CLIにログイン済みであればWebアプリにも反映されます。

1000件を目標に明示して実行する場合は次のように指定できます。

```powershell
.\run-image-search.ps1 -TargetCount 1000
```

## 定期巡回との連動

`run-crawler.ps1` は、通常巡回のあとに公式画像検索APIキーが見つかった場合だけ、画像検索も自動で追加実行します。既存のWindowsタスクが `run-crawler.ps1` を呼んでいる場合、APIキーを環境変数に入れておけば次回巡回から同時に動きます。

## 検索語の調整

初回実行時に `image-search.config.json` が作成されます。検索語はこのファイルの `queries` で調整できます。
現在の初期設定は、500〜1000件規模を狙うために検索語を多めに入れています。

```json
[
  "新築 間取り図 3LDK",
  "新築 間取り図 4LDK",
  "注文住宅 間取り図 3LDK",
  "平屋 間取り図 3LDK"
]
```

`perQuery` は検索語ごとの取得目安、`targetCount` は保存する最大候補数です。

```json
{
  "perQuery": 20,
  "targetCount": 1000
}
```

Google Custom Search JSON APIは1回のAPI呼び出しで最大10件ずつ取得します。検索語を50個、`perQuery` を20にすると最大1000件を狙えますが、API利用枠を消費します。枠が少ない場合は `perQuery` を10程度に下げてください。

## 注意

- Google画像検索の画面そのものは直接巡回対象にしません。
- 取得した画像は確認待ち候補です。正式登録前に元ページと利用条件を確認してください。
- APIキーが未設定の場合は、通常の低頻度サイト巡回だけが動きます。
