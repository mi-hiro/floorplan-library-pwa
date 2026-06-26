# 無料の候補集め

有料APIを使わず、Common Crawlの公開インデックスから間取り図らしいURL候補を集めます。

これは検索画面の直接巡回ではありません。公開インデックスに登録済みのURLから、`madori`、`間取り`、`floorplan`、`plan` などを含む候補を拾い、さらにCommon Crawlに保存済みのHTMLから間取り画像らしいURLを抜き出して、Webアプリの「収集した間取り図」に表示できるJSONへ混ぜます。

## 実行

PowerShellでこのフォルダを開いて実行します。

```powershell
.\run-common-crawl.ps1
```

1000件を目標にする場合は次の指定もできます。

```powershell
.\run-common-crawl.ps1 -TargetCount 1000
```

多めに試す場合は、見る入口URL数と保存済みHTML数を増やします。

```powershell
.\run-common-crawl.ps1 -TargetCount 1000 -PerQuery 80 -MaxQueries 24 -MaxArchivedPages 80
```

結果は `crawler-output/latest-crawl.json` に保存され、GitHub CLIにログイン済みであればWebアプリにも反映されます。

## 調整

初回実行時に `common-crawl.config.json` が作成されます。候補の探し方は `queries` で調整できます。

```json
[
  "*.jp/*madori*",
  "*.jp/*間取り*",
  "*.jp/*floorplan*",
  "*.jp/*施工事例*間取り*"
]
```

特定サイトだけを優先したい場合は `allowedDomains` にドメインを入れます。空のままなら幅広く探します。

```json
{
  "allowedDomains": [
    "ichijo.co.jp",
    "eyefulhome.jp"
  ]
}
```

保存済みHTMLから画像候補を抜く動きは `fetchArchivedPages` でON/OFFできます。相手サイトへ直接ページ取得しないため低負荷ですが、Common Crawl側の応答が遅い日は候補が増えないことがあります。

```json
{
  "fetchArchivedPages": true,
  "maxArchivedPages": 40,
  "indexTimeoutSeconds": 15,
  "archiveTimeoutSeconds": 20
}
```

## 注意

- Common Crawlは過去の公開インデックスなので、元ページや画像が現在も表示できるとは限りません。
- 画像URLから元ページを完全に特定できない場合があります。その場合は近いフォルダURLを元ページ候補として保存します。
- 保存された候補は確認待ちです。正式登録前に元ページと利用条件を確認してください。
- Google画像検索画面の直接巡回、CAPTCHA回避、403/429回避は行いません。
