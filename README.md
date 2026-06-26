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
- サイト管理、巡回設定、取得候補、巡回ログのデータ構造と画面

自動巡回処理はMVPでは未実装です。大手ポータルは初期OFF、画像自動取得OFF、アクセス制限回避なしの設計にしています。
