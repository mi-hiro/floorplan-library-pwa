# Chrome発見モード

Chrome検索は、画像を直接保存するためではなく、住宅会社・工務店・間取りページの元URLを見つけるために使います。

## 使い方

1. Chromeで検索します。
   - `新築 間取り図 3LDK`
   - `注文住宅 間取り プラン集`
   - `工務店 間取り 実例`
   - `平屋 間取り図 4LDK`
2. 良さそうな検索結果ページで、元ページURLをまとめてコピーします。
3. コピーした内容を `.tmp/chrome-search-links.txt` に保存します。
4. 次を実行します。

```powershell
.\run-chrome-discovery.ps1
```

## ChromeでURLをコピーする補助スクリプト

検索結果ページを開いた状態で、Chromeのアドレスバーに次を貼り付けて実行すると、ページ上のリンク候補をクリップボードにコピーします。

```text
javascript:(()=>{const unwrap=h=>{try{let u=new URL(h);for(const k of["imgrefurl","url","q","u","uddg","ru"]){const v=u.searchParams.get(k);if(v&&/^https?:\/\//i.test(v))return v}return h}catch{return h}};const blocked=/google|bing|yahoo|duckduckgo|pinterest|instagram|facebook|twitter|youtube|amazon|rakuten|suumo|homes|athome/i;const terms=/間取り|間取|平面図|図面|madori|floor.?plan|layout|注文住宅|新築|工務店|住宅会社|ハウスメーカー|平屋|3LDK|4LDK|施工事例|建築実例|works|case|plan/i;const rows=[...document.links].map(a=>({url:unwrap(a.href),title:(a.innerText||a.getAttribute("aria-label")||document.title||"").trim()})).filter(x=>/^https?:\/\//.test(x.url)&&!blocked.test(x.url)&&terms.test(`${x.url} ${x.title}`));navigator.clipboard.writeText(JSON.stringify(rows,null,2));alert(`${rows.length}件のURL候補をコピーしました`);})();
```

画像検索のサムネイル画像そのものは保存しません。コピーした元ページを低頻度で巡回し、Ollamaで本当に間取り図か判定します。

## 出力

- Chrome発見結果: `crawler-output/chrome-discovered-sources.json`
- 統合候補URL: `crawler-output/discovered-sources.json`
- Common Crawl種URL: `common-crawl.config.json`
