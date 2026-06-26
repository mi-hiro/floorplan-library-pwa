# Web公開方法

このアプリは静的なPWAなので、Vercel、Netlify、GitHub Pagesで公開できます。

## 重要

現在のデータ保存先はブラウザ内のIndexedDBです。Web公開しても、登録した物件や画像は端末ごとに保存されます。PCとスマホで同じデータを見たい場合は、次段階でFirebase、Supabase、SQLite同期などを追加してください。

## 一番簡単: Vercel

1. この `floorplan-library-pwa` フォルダをGitHubリポジトリにします。
2. VercelでそのリポジトリをImportします。
3. FrameworkはVite、Build Commandは `pnpm build`、Output Directoryは `dist` です。
4. 公開URLが発行されます。

`vercel.json` は追加済みです。

## Netlify

1. NetlifyでこのリポジトリをImportします。
2. Build command: `pnpm build`
3. Publish directory: `dist`

`netlify.toml` は追加済みです。

## GitHub Pages

1. このフォルダをGitHubリポジトリとしてpushします。
2. GitHubの Settings > Pages で Source を GitHub Actions にします。
3. `main` ブランチへpushすると `.github/workflows/deploy-pages.yml` がビルドして公開します。

## 公開時の注意

- URLを知っている人はアプリ画面を開けます。
- ただしIndexedDBの中身は各端末内だけに保存されるため、他人から自分の登録データは見えません。
- 大手ポータル画像の自動保存やアクセス制限回避は実装していません。
- 画像を共有・公開する用途ではなく、個人メモ用として扱ってください。
