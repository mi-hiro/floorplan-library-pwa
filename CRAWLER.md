# ローカル自動巡回

公開PWA単体では外部サイト巡回はできないため、巡回はPC上のローカルエンジンで実行します。結果はJSONとして出力し、Webアプリが定期的に確認して自動取り込みします。

## 初回準備

PowerShellでこのフォルダを開きます。

```powershell
.\run-crawler.ps1
```

初回は `crawler.config.json` が作成されます。巡回したいサイトだけ `enabled: true` にし、`searchUrl` または `manualUrls` を設定してください。

## 実行

```powershell
.\run-crawler.ps1
```

結果は `crawler-output/latest-crawl.json` に保存されます。GitHub CLIにログイン済みの場合は、巡回後にWebアプリ用のJSONも自動更新されます。

Webアプリは約5分ごとに公開済みJSONを確認し、新しい巡回結果があれば「取得候補」と「巡回ログ」に自動反映します。手動で取り込みたい場合は、従来どおり「取得候補」画面の「JSON選択」も使えます。

APIキーが設定されている場合、`run-crawler.ps1` は通常巡回の後に公式画像検索APIも実行し、間取り図候補を追加します。詳しくは [IMAGE_SEARCH.md](./IMAGE_SEARCH.md) を見てください。

## 定期実行

Windowsのタスクスケジューラへ登録する場合は次を実行します。

```powershell
.\register-crawler-task.ps1
```

初期設定では毎週日曜 03:30 に `run-crawler.ps1` を実行します。毎日実行したい場合は次のように指定できます。

```powershell
.\register-crawler-task.ps1 -Schedule Daily -At 03:30
```

## 大手ポータルの扱い

SUUMO、アットホーム、HOME'Sなどは初期OFFです。ONにする場合は、設定内で次の両方が必要です。

```json
"enabled": true,
"userAcknowledgedMajorPortal": true
```

大手ポータルでは画像本体保存は行いません。画像はURL候補として保存し、正式登録前に元ページと利用条件を確認してください。

## 安全設計

- robots.txtを確認します。
- robots.txtで禁止されたURLは取得しません。
- sitemap.xmlがある場合は優先します。
- 同時アクセスは1です。
- `delaySeconds` の待機時間を各アクセス間に入れます。
- `perRunLimit` で1回あたりの取得数を制限します。
- 403、429、5xx、CAPTCHA、ログイン要求を検出したらそのサイトを停止します。
- IP変更、User-Agent偽装、CAPTCHA突破、ログイン突破は実装していません。
- 正式登録ではなく、まず確認待ち候補として保存します。

## 画像について

通常は画像URL候補を収集します。画像本体を保存するのは、次の条件をすべて満たす場合だけです。

- `crawlMode` が `permitted`
- `imageAutoFetch` が `true`
- `imageSaveMode` が `storeImage`
- `majorPortal` が `false`

この設定は、自社サイトや許可を得た工務店サイト向けです。

表示できない画像URLを減らすため、巡回時に間取り画像URLを軽く確認します。画像として読めないURLやrobots.txtで禁止された画像URLは候補から外します。

## 設定例

地方工務店を低頻度で候補化する例です。

```json
{
  "id": "site_local_builder",
  "siteName": "地域工務店",
  "domain": "example-builder.jp",
  "searchUrl": "https://example-builder.jp/works/",
  "manualUrls": [],
  "enabled": true,
  "crawlMode": "lowFrequency",
  "perRunLimit": 10,
  "delaySeconds": 60,
  "recrawlIntervalDays": 7,
  "sitemapUrl": "https://example-builder.jp/sitemap.xml",
  "imageAutoFetch": false,
  "imageSaveMode": "urlOnly",
  "majorPortal": false
}
```
