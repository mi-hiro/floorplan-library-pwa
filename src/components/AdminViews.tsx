import { AlertTriangle, Check, ClipboardList, Plus, Save, Trash2, Upload } from "lucide-react";
import { useMemo, useState } from "react";
import type {
  CrawlCandidate,
  CrawlResultPackage,
  CrawlLog,
  CrawlMode,
  CrawlSite,
  EntranceDirection,
  FloorCount,
  ImageSaveMode,
  LayoutType,
  RobotsStatus
} from "../types";
import {
  CRAWL_MODE_LABELS,
  DIRECTION_OPTIONS,
  FLOOR_OPTIONS,
  IMAGE_KIND_LABELS,
  IMAGE_SAVE_MODE_LABELS,
  LAYOUT_OPTIONS
} from "../types";
import { calculateTsubo, formatDate, formatNumber, makeId, normalizeNumber, nowIso, openExternalUrl } from "../utils/format";

interface SitesViewProps {
  sites: CrawlSite[];
  onSaveSite: (site: CrawlSite) => void;
  onDeleteSite: (id: string) => void;
}

interface CrawlSettingsViewProps {
  sites: CrawlSite[];
  onSaveSite: (site: CrawlSite) => void;
}

interface CandidatesViewProps {
  candidates: CrawlCandidate[];
  sites: CrawlSite[];
  onSaveCandidate: (candidate: CrawlCandidate) => void;
  onDeleteCandidate: (id: string) => void;
  onPromoteCandidate: (candidate: CrawlCandidate) => void;
  onImportCrawlPackage: (crawlPackage: CrawlResultPackage) => Promise<void>;
}

interface LogsViewProps {
  logs: CrawlLog[];
  onClearLogs: () => void;
}

function blankSite(): CrawlSite {
  const createdAt = nowIso();
  return {
    id: makeId("site"),
    siteName: "",
    domain: "",
    searchUrl: "",
    enabled: false,
    crawlMode: "manualOnly",
    perRunLimit: 5,
    perDayLimit: 10,
    delaySeconds: 60,
    recrawlIntervalDays: 7,
    robotsStatus: "unchecked",
    sitemapUrl: "",
    imageAutoFetch: false,
    imageSaveMode: "none",
    majorPortal: false,
    stopped: false,
    stopReason: "",
    notes: "",
    createdAt,
    updatedAt: createdAt
  };
}

function blankCandidate(siteId = ""): CrawlCandidate {
  const fetchedAt = nowIso();
  return {
    id: makeId("candidate"),
    title: "",
    listingSource: "",
    sourceUrl: "",
    siteId,
    company: "",
    layout: "",
    floors: "",
    entranceDirection: "",
    hasFloorplanImage: false,
    imageUrlCandidates: [],
    fetchedAt,
    errorInfo: "",
    memo: ""
  };
}

function SiteSafetyNotice() {
  return (
    <div className="notice">
      <AlertTriangle size={19} />
      <div>
        <strong>安全設計</strong>
        <p>
          このMVPでは自動巡回処理は動かしません。将来追加する場合もrobots.txt確認、同時アクセス1、待機時間、403/429/CAPTCHA/ログイン要求で停止する設計です。
        </p>
      </div>
    </div>
  );
}

export function SitesView({ sites, onSaveSite, onDeleteSite }: SitesViewProps) {
  const [draft, setDraft] = useState<CrawlSite>(blankSite());

  function update<K extends keyof CrawlSite>(key: K, value: CrawlSite[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function save() {
    const normalized = {
      ...draft,
      siteName: draft.siteName.trim() || "名称未設定サイト",
      domain: draft.domain.trim(),
      searchUrl: draft.searchUrl.trim(),
      sitemapUrl: draft.sitemapUrl.trim(),
      updatedAt: nowIso()
    };
    onSaveSite(normalized);
    setDraft(blankSite());
  }

  return (
    <section className="admin-view">
      <div className="section-heading">
        <div>
          <p className="eyebrow">サイト管理</p>
          <h2>巡回対象サイト</h2>
        </div>
      </div>
      <SiteSafetyNotice />
      <div className="admin-grid">
        <form className="admin-form" onSubmit={(event) => event.preventDefault()}>
          <h3>{draft.siteName ? "サイト編集" : "サイト追加"}</h3>
          <div className="form-grid two">
            <label className="field">
              <span>サイト名</span>
              <input value={draft.siteName} onChange={(event) => update("siteName", event.target.value)} />
            </label>
            <label className="field">
              <span>ドメイン</span>
              <input value={draft.domain} onChange={(event) => update("domain", event.target.value)} placeholder="example.com" />
            </label>
            <label className="field span-two">
              <span>検索条件URL</span>
              <input value={draft.searchUrl} onChange={(event) => update("searchUrl", event.target.value)} placeholder="https://..." />
            </label>
            <label className="field">
              <span>巡回モード</span>
              <select value={draft.crawlMode} onChange={(event) => update("crawlMode", event.target.value as CrawlMode)}>
                {Object.entries(CRAWL_MODE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>robots.txt確認結果</span>
              <select value={draft.robotsStatus} onChange={(event) => update("robotsStatus", event.target.value as RobotsStatus)}>
                <option value="unchecked">未確認</option>
                <option value="allowed">許可</option>
                <option value="disallowed">禁止</option>
                <option value="error">確認エラー</option>
              </select>
            </label>
            <label className="toggle">
              <input type="checkbox" checked={draft.enabled} onChange={(event) => update("enabled", event.target.checked)} />
              巡回ON
            </label>
            <label className="toggle">
              <input type="checkbox" checked={draft.majorPortal} onChange={(event) => update("majorPortal", event.target.checked)} />
              大手ポータル
            </label>
            <label className="toggle">
              <input type="checkbox" checked={draft.imageAutoFetch} onChange={(event) => update("imageAutoFetch", event.target.checked)} />
              画像自動取得
            </label>
            <label className="field">
              <span>画像保存方式</span>
              <select value={draft.imageSaveMode} onChange={(event) => update("imageSaveMode", event.target.value as ImageSaveMode)}>
                {Object.entries(IMAGE_SAVE_MODE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field span-two">
              <span>sitemap.xml URL</span>
              <input value={draft.sitemapUrl} onChange={(event) => update("sitemapUrl", event.target.value)} />
            </label>
            <label className="field span-two">
              <span>メモ</span>
              <textarea rows={3} value={draft.notes} onChange={(event) => update("notes", event.target.value)} />
            </label>
          </div>
          <div className="form-footer">
            <button className="secondary-button" type="button" onClick={() => setDraft(blankSite())}>
              <Plus size={17} />
              新規
            </button>
            <button className="primary-button" type="button" onClick={save}>
              <Save size={17} />
              保存
            </button>
          </div>
        </form>

        <div className="admin-list">
          {sites.map((site) => (
            <article className="site-card" key={site.id}>
              <div>
                <h3>{site.siteName}</h3>
                <p>{site.domain || "ドメイン未入力"}</p>
              </div>
              <div className="status-row">
                <span className={site.enabled ? "status-pill on" : "status-pill"}>{site.enabled ? "巡回ON" : "巡回OFF"}</span>
                <span className="status-pill">{CRAWL_MODE_LABELS[site.crawlMode]}</span>
                <span className="status-pill">{IMAGE_SAVE_MODE_LABELS[site.imageSaveMode]}</span>
              </div>
              {site.majorPortal ? <p className="muted-text">大手ポータル：画像自動取得は原則OFF</p> : null}
              {site.stopped ? <p className="error-text">停止理由：{site.stopReason || "理由未入力"}</p> : null}
              <div className="card-actions">
                <button className="ghost-button" type="button" onClick={() => setDraft(site)}>
                  編集
                </button>
                <button className="icon-button danger" type="button" title="削除" onClick={() => onDeleteSite(site.id)}>
                  <Trash2 size={17} />
                </button>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

export function CrawlSettingsView({ sites, onSaveSite }: CrawlSettingsViewProps) {
  function updateSite<K extends keyof CrawlSite>(site: CrawlSite, key: K, value: CrawlSite[K]) {
    onSaveSite({ ...site, [key]: value, updatedAt: nowIso() });
  }

  return (
    <section className="admin-view">
      <div className="section-heading">
        <div>
          <p className="eyebrow">巡回設定</p>
          <h2>低頻度巡回の条件</h2>
        </div>
      </div>
      <SiteSafetyNotice />
      <div className="settings-table">
        {sites.map((site) => (
          <article className="settings-row" key={site.id}>
            <div className="settings-main">
              <h3>{site.siteName}</h3>
              <p>{site.domain || "ドメイン未入力"}</p>
            </div>
            <label className="toggle">
              <input type="checkbox" checked={site.enabled} onChange={(event) => updateSite(site, "enabled", event.target.checked)} />
              巡回ON
            </label>
            <label className="field">
              <span>モード</span>
              <select value={site.crawlMode} onChange={(event) => updateSite(site, "crawlMode", event.target.value as CrawlMode)}>
                {Object.entries(CRAWL_MODE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>1回上限</span>
              <input
                inputMode="numeric"
                value={site.perRunLimit}
                onChange={(event) => updateSite(site, "perRunLimit", normalizeNumber(event.target.value) ?? 0)}
              />
            </label>
            <label className="field">
              <span>1日上限</span>
              <input
                inputMode="numeric"
                value={site.perDayLimit}
                onChange={(event) => updateSite(site, "perDayLimit", normalizeNumber(event.target.value) ?? 0)}
              />
            </label>
            <label className="field">
              <span>待機秒</span>
              <input
                inputMode="numeric"
                value={site.delaySeconds}
                onChange={(event) => updateSite(site, "delaySeconds", normalizeNumber(event.target.value) ?? 0)}
              />
            </label>
            <label className="field">
              <span>再取得間隔（日）</span>
              <input
                inputMode="numeric"
                value={site.recrawlIntervalDays}
                onChange={(event) => updateSite(site, "recrawlIntervalDays", normalizeNumber(event.target.value) ?? 0)}
              />
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={site.imageAutoFetch}
                onChange={(event) => updateSite(site, "imageAutoFetch", event.target.checked)}
              />
              画像自動取得
            </label>
            <label className="field">
              <span>画像保存</span>
              <select value={site.imageSaveMode} onChange={(event) => updateSite(site, "imageSaveMode", event.target.value as ImageSaveMode)}>
                {Object.entries(IMAGE_SAVE_MODE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <div className="status-row">
              <span className="status-pill">robots: {site.robotsStatus}</span>
              <span className={site.stopped ? "status-pill stopped" : "status-pill"}>{site.stopped ? "停止中" : "待機中"}</span>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

export function CandidatesView({
  candidates,
  sites,
  onSaveCandidate,
  onDeleteCandidate,
  onPromoteCandidate,
  onImportCrawlPackage
}: CandidatesViewProps) {
  const [draft, setDraft] = useState<CrawlCandidate>(blankCandidate(sites[0]?.id ?? ""));
  const [importMessage, setImportMessage] = useState("");
  const selectedSite = useMemo(() => sites.find((site) => site.id === draft.siteId), [sites, draft.siteId]);
  const floorplanCandidateCount = useMemo(() => candidates.filter((candidate) => candidate.hasFloorplanImage).length, [candidates]);
  const displayCandidates = useMemo(
    () =>
      [...candidates].sort((a, b) => {
        if (a.hasFloorplanImage !== b.hasFloorplanImage) return a.hasFloorplanImage ? -1 : 1;
        return b.fetchedAt.localeCompare(a.fetchedAt);
      }),
    [candidates]
  );

  function update<K extends keyof CrawlCandidate>(key: K, value: CrawlCandidate[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function updateNumber(key: "priceManYen" | "areaSqm", value: string) {
    const parsed = normalizeNumber(value);
    setDraft((current) => {
      const next = { ...current, [key]: parsed };
      if (key === "areaSqm") next.tsubo = calculateTsubo(parsed);
      return next;
    });
  }

  function saveCandidate() {
    const site = sites.find((item) => item.id === draft.siteId);
    const next: CrawlCandidate = {
      ...draft,
      title: draft.title.trim() || "確認待ち候補",
      listingSource: draft.listingSource.trim() || site?.siteName || "",
      sourceUrl: draft.sourceUrl.trim(),
      company: draft.company.trim(),
      tsubo: calculateTsubo(draft.areaSqm),
      fetchedAt: draft.fetchedAt || nowIso()
    };
    onSaveCandidate(next);
    setDraft(blankCandidate(sites[0]?.id ?? ""));
  }

  async function importCrawlResult(file: File | undefined) {
    if (!file) return;
    setImportMessage("取り込み中...");
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as CrawlResultPackage;
      await onImportCrawlPackage(parsed);
      setImportMessage(`${parsed.candidates?.length ?? 0}件の候補を取り込みました。`);
    } catch (error) {
      setImportMessage(error instanceof Error ? error.message : "取り込みに失敗しました。");
    }
  }

  return (
    <section className="admin-view">
      <div className="section-heading">
        <div>
          <p className="eyebrow">取得候補</p>
          <h2>確認待ち候補</h2>
          <p className="muted-text">自動収集 {candidates.length}件 / 間取り候補 {floorplanCandidateCount}件</p>
        </div>
      </div>
      <div className="notice">
        <ClipboardList size={19} />
        <div>
          <strong>正式登録前の置き場</strong>
          <p>将来の巡回で見つけた情報はここに入り、内容確認後に物件として保存する想定です。今はURL候補を手動登録できます。</p>
        </div>
      </div>
      <div className="import-panel">
        <div>
          <strong>ローカル巡回結果を取り込む</strong>
          <p>巡回エンジンが出力した `latest-crawl.json` を選ぶと、確認待ち候補と巡回ログに追加されます。</p>
        </div>
        <label className="secondary-button file-action">
          <Upload size={17} />
          JSON選択
          <input type="file" accept="application/json,.json" onChange={(event) => importCrawlResult(event.target.files?.[0])} />
        </label>
        {importMessage ? <span className="muted-text">{importMessage}</span> : null}
      </div>
      <div className="admin-grid">
        <form className="admin-form" onSubmit={(event) => event.preventDefault()}>
          <h3>候補を手動追加</h3>
          <div className="form-grid two">
            <label className="field">
              <span>取得元サイト</span>
              <select value={draft.siteId ?? ""} onChange={(event) => update("siteId", event.target.value)}>
                <option value="">未選択</option>
                {sites.map((site) => (
                  <option key={site.id} value={site.id}>
                    {site.siteName}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>掲載元名</span>
              <input value={draft.listingSource || selectedSite?.siteName || ""} onChange={(event) => update("listingSource", event.target.value)} />
            </label>
            <label className="field span-two">
              <span>元ページURL</span>
              <input value={draft.sourceUrl} onChange={(event) => update("sourceUrl", event.target.value)} placeholder="https://..." />
            </label>
            <label className="field">
              <span>物件タイトル</span>
              <input value={draft.title} onChange={(event) => update("title", event.target.value)} />
            </label>
            <label className="field">
              <span>会社名</span>
              <input value={draft.company} onChange={(event) => update("company", event.target.value)} />
            </label>
            <label className="field">
              <span>価格（万円）</span>
              <input value={draft.priceManYen ?? ""} inputMode="numeric" onChange={(event) => updateNumber("priceManYen", event.target.value)} />
            </label>
            <label className="field">
              <span>間取り</span>
              <select value={draft.layout} onChange={(event) => update("layout", event.target.value as LayoutType)}>
                <option value="">未選択</option>
                {LAYOUT_OPTIONS.map((layout) => (
                  <option key={layout} value={layout}>
                    {layout}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>面積㎡</span>
              <input value={draft.areaSqm ?? ""} inputMode="decimal" onChange={(event) => updateNumber("areaSqm", event.target.value)} />
            </label>
            <label className="field">
              <span>坪数</span>
              <input value={draft.tsubo ? draft.tsubo.toFixed(2) : ""} readOnly />
            </label>
            <label className="field">
              <span>階数</span>
              <select value={draft.floors} onChange={(event) => update("floors", event.target.value as FloorCount)}>
                <option value="">未選択</option>
                {FLOOR_OPTIONS.map((floor) => (
                  <option key={floor} value={floor}>
                    {floor}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>玄関向き</span>
              <select value={draft.entranceDirection} onChange={(event) => update("entranceDirection", event.target.value as EntranceDirection)}>
                <option value="">未選択</option>
                {DIRECTION_OPTIONS.map((direction) => (
                  <option key={direction} value={direction}>
                    {direction}
                  </option>
                ))}
              </select>
            </label>
            <label className="toggle">
              <input type="checkbox" checked={draft.hasFloorplanImage} onChange={(event) => update("hasFloorplanImage", event.target.checked)} />
              間取り画像あり
            </label>
            <label className="field span-two">
              <span>画像URL候補（改行区切り）</span>
              <textarea
                rows={3}
                value={draft.imageUrlCandidates.join("\n")}
                onChange={(event) => update("imageUrlCandidates", event.target.value.split("\n").map((value) => value.trim()).filter(Boolean))}
              />
            </label>
            <label className="field span-two">
              <span>エラー情報・メモ</span>
              <textarea rows={3} value={draft.errorInfo || draft.memo} onChange={(event) => update("errorInfo", event.target.value)} />
            </label>
          </div>
          <div className="form-footer">
            <button className="primary-button" type="button" onClick={saveCandidate}>
              <Save size={17} />
              候補保存
            </button>
          </div>
        </form>

        <div className="admin-list">
          {candidates.length === 0 ? (
            <div className="empty-list">確認待ち候補はまだありません。</div>
          ) : (
            displayCandidates.map((candidate) => {
              const imageKindOrder = { floorplan: 0, sitePlan: 1, exterior: 2, interior: 3, other: 4 };
              const imageCandidates = [...(candidate.imageCandidates ?? [])].sort((a, b) => imageKindOrder[a.kind] - imageKindOrder[b.kind]);

              return (
              <article className="candidate-card" key={candidate.id}>
                <div className="candidate-header">
                  <div>
                    <h3>{candidate.title}</h3>
                    <p>{candidate.listingSource || "掲載元未入力"} / {candidate.company || "会社未入力"}</p>
                  </div>
                  <span className="status-pill">{candidate.hasFloorplanImage ? "画像候補あり" : "画像未確認"}</span>
                </div>
                <dl className="spec-grid">
                  <div>
                    <dt>価格</dt>
                    <dd>{formatNumber(candidate.priceManYen, "万円")}</dd>
                  </div>
                  <div>
                    <dt>間取り</dt>
                    <dd>{candidate.layout || "-"}</dd>
                  </div>
                  <div>
                    <dt>面積</dt>
                    <dd>{formatNumber(candidate.areaSqm, "㎡")}</dd>
                  </div>
                  <div>
                    <dt>坪数</dt>
                    <dd>{formatNumber(candidate.tsubo, "坪")}</dd>
                  </div>
                </dl>
                <p className="muted-text">取得日時：{formatDate(candidate.fetchedAt)}</p>
                {imageCandidates.length > 0 ? (
                  <div className="image-candidate-list">
                    {imageCandidates.slice(0, 12).map((image) => (
                      <button
                        className={image.kind === "floorplan" ? "image-candidate is-floorplan" : "image-candidate"}
                        key={image.id}
                        type="button"
                        onClick={() => openExternalUrl(image.url)}
                        title={image.url}
                      >
                        <div className="image-candidate-preview">
                          <img src={image.dataUrl || image.thumbnailUrl || image.url} alt={image.alt || IMAGE_KIND_LABELS[image.kind]} loading="lazy" />
                        </div>
                        <span>{IMAGE_KIND_LABELS[image.kind]}</span>
                        <small>{image.alt || "画像候補"}</small>
                      </button>
                    ))}
                  </div>
                ) : candidate.imageUrlCandidates.length > 0 ? (
                  <p className="muted-text">画像URL候補：{candidate.imageUrlCandidates.length}件</p>
                ) : null}
                {candidate.errorInfo ? <p className="error-text">{candidate.errorInfo}</p> : null}
                <div className="card-actions">
                  {candidate.sourceUrl ? (
                    <button className="ghost-button" type="button" onClick={() => openExternalUrl(candidate.sourceUrl)}>
                      元ページ
                    </button>
                  ) : null}
                  <button className="primary-button" type="button" onClick={() => onPromoteCandidate(candidate)}>
                    <Check size={17} />
                    正式登録
                  </button>
                  <button className="icon-button danger" type="button" title="候補削除" onClick={() => onDeleteCandidate(candidate.id)}>
                    <Trash2 size={17} />
                  </button>
                </div>
              </article>
              );
            })
          )}
        </div>
      </div>
    </section>
  );
}

export function LogsView({ logs, onClearLogs }: LogsViewProps) {
  return (
    <section className="admin-view">
      <div className="section-heading">
        <div>
          <p className="eyebrow">巡回ログ</p>
          <h2>アクセス処理の記録</h2>
        </div>
        <button className="danger-button" type="button" onClick={onClearLogs}>
          <Trash2 size={17} />
          ログ削除
        </button>
      </div>
      <div className="log-table">
        <div className="log-row log-head">
          <span>日時</span>
          <span>サイト</span>
          <span>URL</span>
          <span>処理</span>
          <span>結果</span>
          <span>メッセージ</span>
        </div>
        {logs.length === 0 ? (
          <div className="empty-list">ログはまだありません。</div>
        ) : (
          logs.map((log) => (
            <div className="log-row" key={log.id}>
              <span>{formatDate(log.createdAt)}</span>
              <span>{log.siteName}<br /><small>{log.domain}</small></span>
              <span className="truncate">{log.url}</span>
              <span>{log.action}</span>
              <span className={log.result === "成功" ? "result-ok" : "result-warn"}>{log.result}</span>
              <span>{log.message}</span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
