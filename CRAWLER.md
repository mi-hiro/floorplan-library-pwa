# ローカル自動巡回

公開PWA単体では外部サイト巡回はできないため、巡回はPC上のローカルエンジンで実行します。結果はJSONとして出力し、PWAの「取得候補」画面から取り込みます。

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

結果は `crawler-output/latest-crawl.json` に保存されます。Webアプリの「取得候補」画面で「JSON選択」から取り込んでください。

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
