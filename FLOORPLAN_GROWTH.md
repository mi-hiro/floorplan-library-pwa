# 間取り図をさらに増やす

有料APIなしで、次の流れをまとめて実行します。

1. DuckDuckGoの公式Instant Answer APIで候補サイトを探す
2. 候補サイトと既存サイトの `sitemap.xml` から間取り・施工事例URLを増やす
3. サイトマップで見つけたURLを低頻度に直接巡回する
4. Common Crawlの保存済みHTMLから間取り画像候補を抜き出す
5. Ollamaが起動していれば、画像が本当に間取り図か判定する

Chrome検索で見つけた元ページURLを発見候補に足す場合は、先に `CHROME_DISCOVERY.md` の手順で `.tmp/chrome-search-links.txt` を作り、次を実行します。

```powershell
.\run-chrome-discovery.ps1
```

Chromeは画像保存ではなく、住宅会社・工務店・間取りページの発見補助として使います。

都道府県ごとに地域の住宅会社・工務店を少しずつ探す場合は、次を実行します。

```powershell
.\run-prefecture-discovery.ps1
```

次の検索語が `.tmp/prefecture-search-queries.txt` に出ます。Chromeで集めた元ページURLを `.tmp/prefecture-search-links.json` に保存して、もう一度実行すると既存候補へ追記されます。詳しくは `PREFECTURE_DISCOVERY.md` を見てください。

## 実行

PowerShellでこのフォルダを開いて実行します。

```powershell
.\run-floorplan-growth.ps1
```

多めに試す場合:

```powershell
.\run-floorplan-growth.ps1 -TargetCount 1000 -PerQuery 80 -MaxQueries 32 -MaxArchivedPages 120 -OllamaMaxImages 120
```

サイトマップで見つけた実ページの直接巡回量は次で調整できます。

```powershell
.\run-floorplan-growth.ps1 -LiveSitemapDomains 4 -LiveSitemapUrlsPerDomain 12 -LiveSitemapDelaySeconds 8
```

Ollamaを使わずに候補収集だけ行う場合:

```powershell
.\run-floorplan-growth.ps1 -NoOllama
```

公開せずローカルだけ確認する場合:

```powershell
.\run-floorplan-growth.ps1 -NoPublish
```

## Ollama

Ollamaは必須ではありません。起動していない場合やvision modelがない場合は、候補は消さずにスキップします。

推奨モデル例:

```powershell
ollama pull llama3.2-vision
```

設定は `ollama-filter.config.json` で変えられます。

## DuckDuckGoについて

DuckDuckGoは画像URLを大量取得する主役ではありません。公式Instant Answer APIから得られるURLだけを、候補サイト発見の補助として使います。検索画面や非公式内部エンドポイントは巡回しません。

## 出力

- 候補URL: `crawler-output/discovered-sources.json`
- アプリ用候補: `crawler-output/latest-crawl.json`

取得候補は確認待ちです。正式登録前に元ページと利用条件を確認してください。
