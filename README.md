# 間取り図ライブラリ PWA

新築住宅の間取り図を手動登録し、一覧・詳細・検索・比較できる個人用PWAです。データはブラウザのIndexedDBに保存します。

## 起動

PowerShellでこのフォルダを開き、次を実行します。

```powershell
.\start-app.ps1
```

表示された `http://127.0.0.1:5173/` をブラウザで開いてください。

## Web公開

Vercel、Netlify、GitHub Pages向けの設定を追加済みです。手順は [DEPLOY.md](./DEPLOY.md) を見てください。

## ローカル自動巡回

相手サイトに負荷をかけない低頻度巡回エンジンを追加済みです。手順は [CRAWLER.md](./CRAWLER.md) を見てください。
定期実行したい場合は `register-crawler-task.ps1` でWindowsタスクとして登録できます。
巡回後のJSONはWebアプリ側へ自動反映され、アプリは約5分ごとに新しい取得候補を確認します。

間取り図だけを効率よく増やしたい場合は、公式画像検索APIを使う [IMAGE_SEARCH.md](./IMAGE_SEARCH.md) の方法が向いています。APIキーが設定されていれば、通常巡回後に画像検索も自動で追加実行できます。
キー登録は `set-image-search-keys.ps1`、1000件目標の収集は `run-image-search.ps1 -TargetCount 1000` で実行できます。

## 実装済み

- React + Vite + TypeScript
- PWA manifest / service worker
- IndexedDB保存
- 間取り図の手動追加、画像URL登録
- サムネイル一覧、拡大表示、ピンチズーム、回転
- 物件情報編集、削除、お気に入り、タグ、メモ
- 絞り込み検索
- 2件比較
- 元ページURL保存
- サイト管理、巡回設定、取得候補、巡回ログ
- ローカル自動巡回
- Web公開済み巡回結果の自動同期

大手ポータルは初期OFF、画像自動取得OFF、アクセス制限回避なしの設計にしています。
