"use client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  Bell,
  CalendarDays,
  Check,
  CheckCheck,
  ChevronRight,
  CircleHelp,
  CircleStop,
  Clock3,
  ExternalLink,
  Gift,
  History,
  LayoutDashboard,
  Leaf,
  LoaderCircle,
  MapPin,
  Plus,
  Radar,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Target,
  Trash2,
  Trophy,
  UserRound,
  Users,
  Wallet,
  X,
  Zap,
  Coffee,
  Laptop,
  Plane,
  AlertCircle,
} from "lucide-react";
import type {
  Application,
  ApplicationStatus,
  Campaign,
  JobRun,
  Preferences,
  Profile,
  Source,
} from "@/core/types";
import { CATEGORIES } from "@/core/types";
import { rankCampaign } from "@/core/analysis";
import { Button } from "@/components/ui/button";
type DashboardData = {
  mode: "demo" | "supabase";
  hasProfile: boolean;
  profile: Profile | null;
  preferences: Preferences;
  sources: Source[];
  campaigns: Campaign[];
  applications: Application[];
  runs: JobRun[];
  aiConfigured: boolean;
};
type Tab = "home" | "campaigns" | "manual" | "history" | "settings";
const tabs = [
  { id: "home" as Tab, label: "ダッシュボード", icon: LayoutDashboard },
  { id: "campaigns" as Tab, label: "懸賞を探す", icon: Gift },
  { id: "manual" as Tab, label: "手動応募リスト", icon: UserRound },
  { id: "history" as Tab, label: "応募履歴", icon: History },
  { id: "settings" as Tab, label: "設定", icon: Settings2 },
];
const statusNames: Record<ApplicationStatus, string> = {
  discovered: "発見済み",
  eligible: "応募候補",
  ready_to_submit: "送信待ち",
  submitting: "送信中",
  submitted: "応募完了",
  manual_required: "手動応募待ち",
  blocked: "応募対象外",
  failed: "応募失敗",
  unknown_result: "結果の確認が必要",
  expired: "受付終了",
  won: "当選",
  lost: "落選",
};
const verdictNames = {
  permitted: "自動化の許可を確認",
  silent: "禁止記載なし",
  prohibited: "自動応募禁止",
  unknown: "規約の確認が必要",
};
const yen = (n: number) => new Intl.NumberFormat("ja-JP").format(n);
const date = (s: string, withTime = false) => {
  const d = new Date(s);
  return Number.isNaN(d.getTime())
    ? "未確認"
    : new Intl.DateTimeFormat("ja-JP", {
        timeZone: "Asia/Tokyo",
        month: "numeric",
        day: "numeric",
        ...(withTime
          ? { hour: "2-digit" as const, minute: "2-digit" as const }
          : {}),
      }).format(d);
};
function autoCandidate(c: Campaign) {
  return (
    ["permitted", "silent"].includes(c.rules.verdict) &&
    c.rules.reviewedAllTerms &&
    c.rules.technicalAllowed &&
    !c.rules.purchaseRequired &&
    !c.rules.membershipRequired &&
    !c.rules.snsRequired &&
    !c.rules.captcha &&
    new Date(c.deadline) > new Date()
  );
}
function statusOf(c: Campaign, applications: Application[]): ApplicationStatus {
  return (
    applications.find((a) => a.campaignId === c.id)?.status ??
    (new Date(c.deadline) < new Date()
      ? "expired"
      : autoCandidate(c)
        ? "eligible"
        : "manual_required")
  );
}
function Switch({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`switch ${checked ? "on" : ""}`}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      disabled={disabled}
    >
      <span />
    </button>
  );
}
function Brand({ mobile = false }: { mobile?: boolean }) {
  return (
    <div className={`brand ${mobile ? "mobile-brand" : ""}`}>
      <div className="brand-mark">
        <Target size={24} strokeWidth={1.8} />
      </div>
      <div>
        懸賞ハンターAI<small>KENSHO HUNTER</small>
      </div>
    </div>
  );
}
function Metric({
  title,
  value,
  unit = "件",
  foot,
  icon: Icon,
}: {
  title: string;
  value: number;
  unit?: string;
  foot: string;
  icon: typeof Gift;
}) {
  return (
    <div className="metric">
      <div className="metric-top">
        <span>{title}</span>
        <span className="metric-icon">
          <Icon />
        </span>
      </div>
      <div className="metric-number">
        {yen(value)}
        <small>{unit}</small>
      </div>
      <div className="metric-foot">{foot}</div>
    </div>
  );
}
function StatusBadge({ status }: { status: ApplicationStatus }) {
  const manual = ["manual_required", "unknown_result", "submitting"].includes(
    status,
  );
  const blocked = ["blocked", "failed", "expired"].includes(status);
  return (
    <span
      className={`badge ${manual ? "manual" : ""} ${blocked ? "blocked" : ""}`}
    >
      {status === "won" ? (
        <Trophy />
      ) : manual ? (
        <UserRound />
      ) : blocked ? (
        <CircleStop />
      ) : (
        <Check />
      )}
      {statusNames[status]}
    </span>
  );
}
function CampaignCard({
  campaign: c,
  applications,
  onDetail,
}: {
  campaign: Campaign;
  applications: Application[];
  onDetail: (c: Campaign) => void;
}) {
  let Icon = Gift,
    art = "",
    category = "GIFT & LIFESTYLE";
  if (c.category.includes("食品")) {
    Icon = Coffee;
    art = "food";
    category = "FOOD & DRINK";
  } else if (c.category.includes("旅行")) {
    Icon = Plane;
    art = "travel";
    category = "TRAVEL & EXPERIENCE";
  } else if (c.category.includes("家電")) {
    Icon = Laptop;
    art = "tech";
    category = "TECH & GADGET";
  } else if (c.category.includes("ギフト")) {
    Icon = Wallet;
    category = "GIFT & REWARDS";
  }
  return (
    <article className="campaign-card">
      <div className={`campaign-art ${art}`}>
        <Icon />
        <span className="demo-tag">
          {c.isDemo ? "テスト用キャンペーン" : c.category}
        </span>
        <span className="art-category">{category}</span>
      </div>
      <div className="campaign-body">
        <p className="organizer">{c.organizer}</p>
        <h3>{c.title}</h3>
        <div className="prize-name">{c.prize}</div>
        <div className="prize-value">
          ¥{yen(c.estimatedValue)}
          <small>推定価値</small>
        </div>
        <p className="help" style={{ fontSize: 8, marginBottom: 10 }}>
          推定優先スコア {rankCampaign(c).toFixed(1)} · 当選確率ではありません
        </p>
        <div className="card-meta">
          <span>
            <Users />
            {c.winners > 0 ? `${yen(c.winners)}名様` : "当選人数未確認"}
          </span>
          <span>
            <Clock3 />
            {date(c.deadline)} まで
          </span>
        </div>
        <div className="card-bottom">
          <StatusBadge status={statusOf(c, applications)} />
          <button className="detail-link" onClick={() => onDetail(c)}>
            詳細を見る
            <ArrowRight />
          </button>
        </div>
      </div>
    </article>
  );
}
export default function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [tab, setTab] = useState<Tab>("home");
  const activeTab = useRef<Tab>(tab);
  activeTab.current = tab;
  const [filter, setFilter] = useState("all");
  const [category, setCategory] = useState("");
  const [sort, setSort] = useState("score");
  const [selected, setSelected] = useState<Campaign | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    const r = await fetch(
      tab === "settings" ? "/api/dashboard?includeProfile=1" : "/api/dashboard",
      { cache: "no-store" },
    );
    if (r.status === 401) {
      window.location.assign("/login");
      return;
    }
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "データを取得できませんでした");
    if (activeTab.current === tab) setData(d);
  }, [tab]);
  useEffect(() => {
    refresh().catch((e) => setError(e.message));
  }, [refresh]);
  async function mutate(
    path: string,
    method: string,
    body?: unknown,
    message = "保存しました",
  ) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const r = await fetch(path, {
        method,
        headers: { "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const result = await r.json();
      if (!r.ok) throw new Error(result.error || "処理に失敗しました");
      await refresh();
      setNotice(typeof result.message === "string" ? result.message : message);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      return false;
    } finally {
      setBusy(false);
    }
  }
  function setPrefs(patch: Partial<Preferences>) {
    if (data)
      return mutate("/api/preferences", "PUT", {
        preferences: { ...data.preferences, ...patch },
      });
  }
  async function toggleAuto() {
    if (!data) return;
    if (
      !data.preferences.autoApply &&
      (!data.hasProfile ||
        !data.preferences.consentAt ||
        !data.preferences.approvedConsents.includes("privacy"))
    ) {
      setTab("settings");
      setError(
        "プロフィールと個人情報の送信同意を設定してから、自動応募をONにしてください。",
      );
      return;
    }
    await setPrefs({ autoApply: !data.preferences.autoApply });
  }
  function run(kind: "collect" | "apply") {
    return mutate(
      "/api/run",
      "POST",
      { kind },
      kind === "collect"
        ? "収集処理が完了しました。実行履歴も確認できます。"
        : "応募処理を実行しました。結果は応募履歴で確認できます。",
    );
  }
  const apps = data?.applications ?? [],
    campaigns = data?.campaigns ?? [];
  const applied = apps.filter((a) =>
    ["submitted", "won", "lost"].includes(a.status),
  );
  const manual = campaigns.filter((c) =>
    ["manual_required", "unknown_result"].includes(statusOf(c, apps)),
  );
  const won = apps.filter((a) => a.status === "won");
  const latestRun = data?.runs[0];
  let visible = [...campaigns].sort(
    (a, b) =>
      new Date(b.discoveredAt).getTime() - new Date(a.discoveredAt).getTime(),
  );
  if (tab === "manual") visible = manual;
  if (filter === "new")
    visible = visible.filter(
      (c) => Date.now() - new Date(c.discoveredAt).getTime() < 7 * 86400000,
    );
  if (filter === "auto")
    visible = visible.filter(
      (c) => autoCandidate(c) && !apps.some((a) => a.campaignId === c.id),
    );
  if (filter === "submitted")
    visible = visible.filter((c) => applied.some((a) => a.campaignId === c.id));
  if (filter === "manual")
    visible = visible.filter((c) => manual.some((m) => m.id === c.id));
  if (filter === "high")
    visible = visible.filter((c) => c.estimatedValue >= 10000);
  if (filter === "closing")
    visible = visible.filter(
      (c) =>
        new Date(c.deadline).getTime() > Date.now() &&
        new Date(c.deadline).getTime() - Date.now() < 7 * 86400000,
    );
  if (category) visible = visible.filter((c) => c.category === category);
  if (sort === "score")
    visible.sort((a, b) => rankCampaign(b) - rankCampaign(a));
  if (sort === "deadline")
    visible.sort((a, b) => Date.parse(a.deadline) - Date.parse(b.deadline));
  if (tab === "home") visible = visible.slice(0, 4);
  const nav = (id: Tab) => {
    setTab(id);
    if (id !== "settings") setData((d) => (d ? { ...d, profile: null } : d));
    setFilter("all");
    setCategory("");
    setNotice("");
    setError("");
  };
  return (
    <div className="shell">
      <aside className="sidebar">
        <Brand />
        <div className="side-label">WORKSPACE</div>
        <nav aria-label="メインナビゲーション">
          {tabs.map((t) => (
            <button
              key={t.id}
              className={`nav-link ${tab === t.id ? "active" : ""}`}
              onClick={() => nav(t.id)}
              aria-current={tab === t.id ? "page" : undefined}
            >
              <t.icon />
              {t.label}
              {t.id === "manual" && manual.length > 0 && (
                <span className="nav-count">{manual.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="side-bottom">
          <div className="safety-note">
            <strong>
              <ShieldCheck size={14} />
              安心して使える仕組み
            </strong>
            規約を確認し、許可された範囲だけで応募します。いつでも停止できます。
          </div>
          <div className="account">
            <div className="avatar">
              <UserRound size={15} />
            </div>
            <div>
              {data?.mode === "demo" ? "ローカル開発モード" : "マイアカウント"}
              <br />
              <small>
                {data?.mode === "demo"
                  ? "テストデータで動作を確認"
                  : "認証済みのワークスペース"}
              </small>
            </div>
            <button
              className="detail-link"
              aria-label="アカウント設定"
              onClick={() => nav("settings")}
            >
              <Settings2 size={15} />
            </button>
          </div>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <Brand mobile />
          <div className="breadcrumb">
            ワークスペース
            <ChevronRight
              size={11}
              style={{ display: "inline", marginLeft: 12 }}
            />
            <b>{tabs.find((t) => t.id === tab)?.label}</b>
          </div>
          <div className="top-actions">
            <span className="today">
              {new Intl.DateTimeFormat("ja-JP", {
                timeZone: "Asia/Tokyo",
                year: "numeric",
                month: "long",
                day: "numeric",
                weekday: "short",
              }).format(new Date())}
            </span>
            <span className="demo-pill">
              {data?.mode === "supabase"
                ? "プライベートワークスペース"
                : "DEMO · テスト環境"}
            </span>
            <button
              className="detail-link"
              aria-label="実行履歴を見る"
              onClick={() => nav("history")}
            >
              <Bell size={17} />
            </button>
          </div>
        </header>
        <main className="content">
          <div className="page-heading">
            <div>
              <p className="eyebrow">YOUR EVERYDAY CHANCE</p>
              <h1>
                {tab === "home"
                  ? "ダッシュボード"
                  : tab === "campaigns"
                    ? "あなたの次のチャンスを。"
                    : tab === "manual"
                      ? "手動応募リスト"
                      : tab === "history"
                        ? "応募履歴"
                        : "ワークスペース設定"}
              </h1>
              <p className="subtitle">
                {tab === "home"
                  ? "小さなチャンスを、毎日の楽しみに。"
                  : tab === "campaigns"
                    ? "新しい懸賞を見つけて、気になる賞品に応募しましょう。"
                    : tab === "manual"
                      ? "あなたの確認や操作が必要なキャンペーンです。"
                      : tab === "history"
                        ? "応募の結果と当選を、ひとつの場所で。"
                        : "あなたの情報と、自動応募の範囲を管理します。"}
              </p>
            </div>
            {tab !== "settings" && (
              <Button disabled={busy || !data} onClick={() => run("collect")}>
                {busy ? <LoaderCircle className="spin" /> : <RefreshCw />}
                今すぐ収集
              </Button>
            )}
          </div>
          {error && (
            <div role="alert" className="alert">
              <AlertCircle />
              {error}
              <button aria-label="エラーを閉じる" onClick={() => setError("")}>
                <X size={14} />
              </button>
            </div>
          )}
          {notice && (
            <div role="status" className="alert success">
              <Check />
              {notice}
              <button aria-label="通知を閉じる" onClick={() => setNotice("")}>
                <X size={14} />
              </button>
            </div>
          )}
          {!data ? (
            <div className="loading-screen">
              <LoaderCircle
                className="spin"
                size={25}
                style={{ margin: "0 auto 15px" }}
              />
              {error
                ? "接続を確認し、再読み込みしてください。"
                : "ワークスペースを読み込んでいます…"}
              {error && (
                <div style={{ marginTop: 16 }}>
                  <Button
                    onClick={() => refresh().catch((e) => setError(e.message))}
                  >
                    再読み込み
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <>
              {tab === "home" && (
                <>
                  <section className="hero">
                    <div>
                      <div className="hero-kicker">
                        <Sparkles size={12} /> YOUR PERSONAL HUNTER
                      </div>
                      <h2>
                        見つけるのはAI。
                        <br />
                        楽しみにするのは、あなた。
                      </h2>
                      <p>
                        {data.mode === "demo"
                          ? "まずはテスト用キャンペーンで、発見から応募までを体験しましょう。"
                          : "設定した条件に合う懸賞を探して、応募までをお手伝いします。"}
                      </p>
                    </div>
                    <div className="hero-status">
                      <div className="control-row">
                        <span className="control-name">
                          <Radar />
                          自動収集
                        </span>
                        <Switch
                          label="自動収集"
                          checked={data.preferences.autoCollect}
                          onChange={() =>
                            setPrefs({
                              autoCollect: !data.preferences.autoCollect,
                            })
                          }
                          disabled={busy}
                        />
                      </div>
                      <div className="control-row">
                        <span className="control-name">
                          <Zap />
                          自動応募
                        </span>
                        <Switch
                          label="自動応募"
                          checked={data.preferences.autoApply}
                          onChange={toggleAuto}
                          disabled={busy || data.preferences.emergencyStop}
                        />
                      </div>
                    </div>
                  </section>
                  {data.preferences.emergencyStop && (
                    <div className="alert">
                      <CircleStop />
                      緊急停止中です。自動応募を再開するには、設定画面で停止を解除してください。
                    </div>
                  )}
                  <section className="metrics" aria-label="応募の集計">
                    <Metric
                      title="発見した懸賞"
                      value={campaigns.length}
                      icon={Radar}
                      foot={
                        data.mode === "demo"
                          ? "テストデータを含む収集結果"
                          : "これまでに見つけたチャンス"
                      }
                    />
                    <Metric
                      title="自動応募の候補"
                      value={
                        campaigns.filter(
                          (c) =>
                            autoCandidate(c) &&
                            !apps.some((a) => a.campaignId === c.id),
                        ).length
                      }
                      icon={Zap}
                      foot="最終的な条件は送信前に再確認"
                    />
                    <Metric
                      title="応募完了"
                      value={applied.length}
                      icon={CheckCheck}
                      foot={
                        data.mode === "demo"
                          ? "実際の懸賞への応募は含みません"
                          : "送信完了を確認できた応募"
                      }
                    />
                    <Metric
                      title="当選した賞品"
                      value={won.length}
                      icon={Trophy}
                      foot="当選報告を手動で記録"
                    />
                  </section>
                </>
              )}
              {(tab === "home" || tab === "campaigns" || tab === "manual") && (
                <div className={tab === "home" ? "workspace-grid" : ""}>
                  <section>
                    <div className="section-heading">
                      <h2>
                        <Gift />
                        {tab === "manual"
                          ? "確認が必要なキャンペーン"
                          : tab === "home"
                            ? "見つかったチャンス"
                            : "キャンペーン一覧"}
                        <small>{campaigns.length}件の収集結果</small>
                      </h2>
                      {tab === "home" && (
                        <button
                          className="detail-link"
                          onClick={() => nav("campaigns")}
                        >
                          すべて見る
                          <ArrowRight />
                        </button>
                      )}
                    </div>
                    {tab !== "manual" && (
                      <div className="filters" aria-label="懸賞のフィルター">
                        {[
                          { id: "all", label: "すべて" },
                          { id: "new", label: "新着" },
                          { id: "auto", label: "自動応募可能" },
                          { id: "closing", label: "締切間近" },
                          ...(tab !== "home"
                            ? [
                                { id: "submitted", label: "応募済み" },
                                { id: "manual", label: "手動応募" },
                                { id: "high", label: "高額賞品" },
                              ]
                            : []),
                        ].map((f) => (
                          <button
                            key={f.id}
                            className={`filter ${filter === f.id ? "active" : ""}`}
                            onClick={() => setFilter(f.id)}
                          >
                            {f.label}
                          </button>
                        ))}
                        <select
                          className="category-select"
                          aria-label="カテゴリを選択"
                          value={category}
                          onChange={(e) => setCategory(e.target.value)}
                        >
                          <option value="">すべてのカテゴリ</option>
                          {CATEGORIES.map((c) => (
                            <option key={c}>{c}</option>
                          ))}
                        </select>
                        <select
                          className="category-select"
                          aria-label="並び順"
                          value={sort}
                          onChange={(e) => setSort(e.target.value)}
                        >
                          <option value="score">推定スコア順</option>
                          <option value="new">新着順</option>
                          <option value="deadline">締切が近い順</option>
                        </select>
                      </div>
                    )}
                    <div className="campaign-grid">
                      {visible.map((c) => (
                        <CampaignCard
                          key={c.id}
                          campaign={c}
                          applications={apps}
                          onDetail={setSelected}
                        />
                      ))}
                      {visible.length === 0 && (
                        <div className="empty">
                          <div className="empty-icon">
                            {tab === "manual" ? (
                              <CheckCheck size={25} />
                            ) : (
                              <Gift size={25} />
                            )}
                          </div>
                          <h3>
                            {tab === "manual"
                              ? "確認待ちの懸賞はありません"
                              : campaigns.length
                                ? "条件に合う懸賞はまだありません"
                                : "最初のチャンスを見つけましょう"}
                          </h3>
                          <p>
                            {tab === "manual"
                              ? "手動での操作が必要になったキャンペーンは、ここにまとまります。"
                              : campaigns.length
                                ? "フィルターを変えるか、もう一度収集してみてください。"
                                : data.mode === "demo"
                                  ? "「今すぐ収集」でテスト用の懸賞を取得できます。架空の実績は表示せず、実行した処理だけを記録します。"
                                  : "収集先を登録すると、公式ページからキャンペーン情報を取得できます。"}
                          </p>
                          {!campaigns.length && (
                            <div className="getting-started">
                              <span>
                                <b className="step-num">1</b>プロフィール設定
                              </span>
                              <span>
                                <b className="step-num">2</b>懸賞を収集
                              </span>
                              <span>
                                <b className="step-num">3</b>応募結果を確認
                              </span>
                            </div>
                          )}
                          <Button
                            variant="outline"
                            disabled={busy}
                            onClick={() =>
                              tab === "manual"
                                ? nav("campaigns")
                                : run("collect")
                            }
                          >
                            {tab === "manual" ? "懸賞一覧へ" : "懸賞を収集する"}
                            <ArrowRight />
                          </Button>
                        </div>
                      )}
                    </div>
                  </section>
                  {tab === "home" && (
                    <aside className="right-column">
                      <div className="panel">
                        <h3>
                          <Leaf />
                          ハンターの稼働状況
                        </h3>
                        <div
                          className={`health ${!data.preferences.autoApply ? "warning" : ""}`}
                        >
                          <span className="dot" />
                          {data.preferences.emergencyStop
                            ? "すべての応募を停止中"
                            : data.preferences.autoApply
                              ? "自動応募が有効です"
                              : "自動応募はOFFです"}
                        </div>
                        <div className="fact">
                          <span>収集スケジュール</span>
                          <b>6時間ごと</b>
                        </div>
                        <div className="fact">
                          <span>最終実行</span>
                          <b>
                            {latestRun
                              ? date(latestRun.startedAt, true)
                              : "まだ実行していません"}
                          </b>
                        </div>
                        <div className="fact">
                          <span>1日の応募上限</span>
                          <b>{data.preferences.maxApplications}件</b>
                        </div>
                        <div className="thin-line" />
                        <div className="fact">
                          <span>手動応募待ち</span>
                          <b>{manual.length}件</b>
                        </div>
                        <div className="fact">
                          <span>応募失敗</span>
                          <b>
                            {apps.filter((a) => a.status === "failed").length}件
                          </b>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          className="w-100"
                          onClick={() => nav("settings")}
                        >
                          <Settings2 />
                          設定を確認
                        </Button>
                      </div>
                      <div className="panel">
                        <h3>
                          <Clock3 />
                          最近のアクティビティ
                        </h3>
                        {data.runs.length ? (
                          data.runs.slice(0, 3).map((r) => (
                            <div className="activity" key={r.id}>
                              <p>
                                {r.kind === "collect"
                                  ? "懸賞を収集"
                                  : "応募ジョブを実行"}{" "}
                                ·{" "}
                                {r.status === "running"
                                  ? "処理中"
                                  : r.status === "failed"
                                    ? "エラーあり"
                                    : `${r.processed}件を処理`}
                              </p>
                              <small>{date(r.startedAt, true)} JST</small>
                            </div>
                          ))
                        ) : (
                          <p className="empty-activity">
                            収集や応募を実行すると、
                            <br />
                            ここに履歴が表示されます。
                          </p>
                        )}
                      </div>
                      <div className="panel note-panel">
                        <h3>
                          <ShieldCheck />
                          あなたの同意を大切に。
                        </h3>
                        <p>
                          プロフィール情報は暗号化して保存。規約が不明な懸賞は、確認待ちに振り分けます。
                        </p>
                      </div>
                    </aside>
                  )}
                </div>
              )}
              {tab === "home" && (
                <section className="bottom-stats">
                  <div className="bottom-stat">
                    <UserRound />
                    <div>
                      <span>手動応募待ち</span>
                      <strong>
                        {manual.length} <small>件</small>
                      </strong>
                    </div>
                  </div>
                  <div className="bottom-stat">
                    <Trophy />
                    <div>
                      <span>獲得した賞品の推定総額</span>
                      <strong>
                        ¥{yen(won.reduce((n, a) => n + (a.prizeValue ?? 0), 0))}
                      </strong>
                    </div>
                  </div>
                  <div className="bottom-stat">
                    <ShieldCheck />
                    <div>
                      <span>個人情報の送信同意</span>
                      <strong style={{ fontSize: 12, marginTop: 5 }}>
                        {data.preferences.consentAt ? "設定済み" : "未設定"}
                      </strong>
                    </div>
                  </div>
                </section>
              )}
              {tab === "history" && (
                <>
                  <div className="section-heading">
                    <h2>
                      <History />
                      応募履歴<small>{apps.length}件</small>
                    </h2>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={
                        busy ||
                        !data.preferences.autoApply ||
                        data.preferences.emergencyStop
                      }
                      onClick={() => run("apply")}
                    >
                      <Zap />
                      応募ジョブを実行
                    </Button>
                  </div>
                  {!apps.length ? (
                    <div className="empty">
                      <div className="empty-icon">
                        <History />
                      </div>
                      <h3>応募履歴はまだありません</h3>
                      <p>
                        プロフィールと送信同意を設定すると、テスト用フォームへの応募を試せます。送信結果が確認できたものだけを応募完了として表示します。
                      </p>
                      <Button variant="outline" onClick={() => nav("settings")}>
                        応募設定へ
                        <ArrowRight />
                      </Button>
                    </div>
                  ) : (
                    <div className="panel table-wrap">
                      <table className="history-table">
                        <thead>
                          <tr>
                            <th>キャンペーン</th>
                            <th>応募日時 / JST</th>
                            <th>ステータス</th>
                            <th>当選結果</th>
                            <th />
                          </tr>
                        </thead>
                        <tbody>
                          {apps.map((a) => {
                            const c = campaigns.find(
                              (c) => c.id === a.campaignId,
                            );
                            return (
                              <tr key={a.id}>
                                <td>
                                  {c?.title ?? "キャンペーン"}
                                  {c?.isDemo && <small>テスト用応募</small>}
                                  {a.receipt && (
                                    <small>受付番号 {a.receipt}</small>
                                  )}
                                </td>
                                <td>{date(a.createdAt, true)}</td>
                                <td>
                                  <StatusBadge status={a.status} />
                                  {a.error && <small>{a.error}</small>}
                                </td>
                                <td>
                                  {["submitted", "won", "lost"].includes(
                                    a.status,
                                  ) && (
                                    <div className="history-result">
                                      <Button
                                        size="sm"
                                        variant="ghost"
                                        disabled={busy || a.status === "won"}
                                        onClick={() => {
                                          const value = window.prompt(
                                            "獲得した賞品の推定価値（円）を入力してください。",
                                            String(c?.estimatedValue ?? 0),
                                          );
                                          if (
                                            value !== null &&
                                            Number.isFinite(Number(value)) &&
                                            Number(value) >= 0
                                          )
                                            mutate(
                                              "/api/applications",
                                              "POST",
                                              {
                                                campaignId: a.campaignId,
                                                status: "won",
                                                prizeValue: Number(value),
                                              },
                                              "当選を記録しました。おめでとうございます！",
                                            );
                                        }}
                                      >
                                        <Trophy />
                                        当選
                                      </Button>
                                      <Button
                                        size="sm"
                                        variant="ghost"
                                        disabled={busy || a.status === "lost"}
                                        onClick={() =>
                                          mutate(
                                            "/api/applications",
                                            "POST",
                                            {
                                              campaignId: a.campaignId,
                                              status: "lost",
                                            },
                                            "結果を記録しました",
                                          )
                                        }
                                      >
                                        落選
                                      </Button>
                                    </div>
                                  )}
                                </td>
                                <td>
                                  {c && (
                                    <button
                                      className="detail-link"
                                      onClick={() => setSelected(c)}
                                    >
                                      詳細
                                      <ArrowRight />
                                    </button>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <div className="section-heading" style={{ marginTop: 30 }}>
                    <h2>
                      <Clock3 />
                      ジョブの実行履歴
                    </h2>
                  </div>
                  <div className="panel">
                    {!data.runs.length ? (
                      <p className="help">まだ実行履歴がありません。</p>
                    ) : (
                      data.runs.slice(0, 20).map((r) => (
                        <div className="source-item" key={r.id}>
                          <div>
                            <strong>
                              {r.kind === "collect" ? "懸賞収集" : "自動応募"} ·{" "}
                              {r.processed}件を処理
                            </strong>
                            <p>
                              {date(r.startedAt, true)} JST ·{" "}
                              {r.status === "completed"
                                ? "完了"
                                : r.status === "failed"
                                  ? "エラー"
                                  : "実行中"}
                            </p>
                            {r.errors.map((e, i) => (
                              <p key={i} style={{ color: "#ac735e" }}>
                                {e}
                              </p>
                            ))}
                          </div>
                          <span className="source-kind">
                            {r.kind.toUpperCase()}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                </>
              )}
              {tab === "settings" && (
                <Settings
                  data={data}
                  busy={busy}
                  mutate={mutate}
                  setPrefs={setPrefs}
                  toggleAuto={toggleAuto}
                />
              )}
              <footer className="footer">
                <span>© {new Date().getFullYear()} Kensho Hunter AI</span>
                <span>
                  表示額・スコアは推定です。当選確率を示すものではありません。
                </span>
              </footer>
            </>
          )}
        </main>
      </div>
      <nav className="mobile-nav" aria-label="モバイルナビゲーション">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={tab === t.id ? "active" : ""}
            onClick={() => nav(t.id)}
          >
            <t.icon />
            {t.id === "home"
              ? "ホーム"
              : t.id === "campaigns"
                ? "懸賞"
                : t.id === "manual"
                  ? "手動応募"
                  : t.id === "history"
                    ? "履歴"
                    : "設定"}
          </button>
        ))}
      </nav>
      {selected && data && (
        <CampaignDetail
          campaign={selected}
          data={data}
          onClose={() => setSelected(null)}
          busy={busy}
          mutate={mutate}
        />
      )}
    </div>
  );
}
type Mutate = (
  path: string,
  method: string,
  body?: unknown,
  message?: string,
) => Promise<boolean>;
const PREFECTURES = [
  "北海道",
  "青森県",
  "岩手県",
  "宮城県",
  "秋田県",
  "山形県",
  "福島県",
  "茨城県",
  "栃木県",
  "群馬県",
  "埼玉県",
  "千葉県",
  "東京都",
  "神奈川県",
  "新潟県",
  "富山県",
  "石川県",
  "福井県",
  "山梨県",
  "長野県",
  "岐阜県",
  "静岡県",
  "愛知県",
  "三重県",
  "滋賀県",
  "京都府",
  "大阪府",
  "兵庫県",
  "奈良県",
  "和歌山県",
  "鳥取県",
  "島根県",
  "岡山県",
  "広島県",
  "山口県",
  "徳島県",
  "香川県",
  "愛媛県",
  "高知県",
  "福岡県",
  "佐賀県",
  "長崎県",
  "熊本県",
  "大分県",
  "宮崎県",
  "鹿児島県",
  "沖縄県",
];
function Settings({
  data,
  busy,
  mutate,
  setPrefs,
  toggleAuto,
}: {
  data: DashboardData;
  busy: boolean;
  mutate: Mutate;
  setPrefs: (patch: Partial<Preferences>) => Promise<boolean> | undefined;
  toggleAuto: () => Promise<void>;
}) {
  const empty: Profile = {
    name: "",
    kana: "",
    postalCode: "",
    prefecture: "東京都",
    address: "",
    phone: "",
    email: "",
    birthDate: "",
  };
  const [profile, setProfile] = useState<Profile>(data.profile ?? empty);
  useEffect(() => {
    if (data.profile) setProfile(data.profile);
  }, [data.profile]);
  const [consent, setConsent] = useState(!!data.preferences.consentAt);
  const [privacy, setPrivacy] = useState(
    data.preferences.approvedConsents.includes("privacy"),
  );
  const [limit, setLimit] = useState(data.preferences.maxApplications);
  const [cats, setCats] = useState(data.preferences.categories);
  const [excluded, setExcluded] = useState(data.preferences.excludedCategories);
  const [sourceName, setSourceName] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [sourceKind, setSourceKind] = useState<"rss" | "html">("rss");
  const [sourceHosts, setSourceHosts] = useState("");
  const [sourceTerms, setSourceTerms] = useState(false);
  function field(key: keyof Profile, value: string) {
    setProfile((p) => ({ ...p, [key]: value }));
  }
  async function saveProfile(e: FormEvent) {
    e.preventDefault();
    await mutate(
      "/api/profile",
      "PUT",
      { profile },
      "プロフィールを暗号化して保存しました",
    );
  }
  async function saveConsent(e: FormEvent) {
    e.preventDefault();
    await setPrefs({
      consentAt: consent
        ? (data.preferences.consentAt ?? new Date().toISOString())
        : null,
      approvedConsents: privacy ? ["privacy"] : [],
      maxApplications: limit,
      categories: cats,
      excludedCategories: excluded,
      ...(!consent || !privacy ? { autoApply: false } : {}),
    });
  }
  async function addSource(e: FormEvent) {
    e.preventDefault();
    let host = "";
    try {
      host = new URL(sourceUrl).hostname;
    } catch {
      return;
    }
    const ok = await mutate(
      "/api/sources",
      "POST",
      {
        source: {
          id: crypto.randomUUID(),
          name: sourceName,
          url: sourceUrl,
          kind: sourceKind,
          enabled: true,
          termsAccepted: sourceTerms,
          allowedHosts: [
            ...new Set([
              host,
              ...sourceHosts
                .split(",")
                .map((h) => h.trim())
                .filter(Boolean),
            ]),
          ],
        },
      },
      "収集先を追加しました",
    );
    if (ok) {
      setSourceName("");
      setSourceUrl("");
      setSourceHosts("");
      setSourceTerms(false);
    }
  }
  return (
    <div className="settings-grid">
      <div>
        <section className="panel settings-panel">
          <h2>プロフィール</h2>
          <p className="help">
            応募フォームに入力する情報です。本人の正しい情報を登録してください。
            {data.mode === "demo" &&
              " テスト時には架空のテスト用プロフィールを使用してください。"}
          </p>
          <form onSubmit={saveProfile}>
            <div className="form-grid">
              <label>
                氏名
                <input
                  name="name"
                  autoComplete="name"
                  required
                  maxLength={100}
                  value={profile.name}
                  onChange={(e) => field("name", e.target.value)}
                  placeholder="山田 太郎"
                />
              </label>
              <label>
                フリガナ
                <input
                  name="kana"
                  required
                  maxLength={100}
                  value={profile.kana}
                  onChange={(e) => field("kana", e.target.value)}
                  placeholder="ヤマダ タロウ"
                />
              </label>
              <label>
                メールアドレス
                <input
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={profile.email}
                  onChange={(e) => field("email", e.target.value)}
                  placeholder="taro@example.com"
                />
              </label>
              <label>
                電話番号
                <input
                  name="phone"
                  type="tel"
                  autoComplete="tel"
                  required
                  value={profile.phone}
                  onChange={(e) => field("phone", e.target.value)}
                  placeholder="09012345678"
                />
              </label>
              <label>
                郵便番号
                <input
                  name="postalCode"
                  autoComplete="postal-code"
                  required
                  value={profile.postalCode}
                  onChange={(e) => field("postalCode", e.target.value)}
                  placeholder="1000001"
                />
              </label>
              <label>
                都道府県
                <select
                  name="prefecture"
                  aria-label="都道府県"
                  autoComplete="address-level1"
                  value={profile.prefecture}
                  onChange={(e) => field("prefecture", e.target.value)}
                >
                  {PREFECTURES.map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </select>
              </label>
              <label className="wide">
                市区町村・番地・建物名
                <input
                  name="address"
                  autoComplete="street-address"
                  required
                  maxLength={300}
                  value={profile.address}
                  onChange={(e) => field("address", e.target.value)}
                  placeholder="千代田区千代田 1-1"
                />
              </label>
              <label>
                生年月日
                <input
                  name="birthDate"
                  type="date"
                  autoComplete="bday"
                  required
                  value={profile.birthDate}
                  onChange={(e) => field("birthDate", e.target.value)}
                />
              </label>
              <label>
                性別（任意）
                <select
                  name="gender"
                  aria-label="性別（任意）"
                  value={profile.gender ?? ""}
                  onChange={(e) => field("gender", e.target.value)}
                >
                  <option value="">送信しない</option>
                  <option value="male">男性</option>
                  <option value="female">女性</option>
                  <option value="other">その他</option>
                </select>
              </label>
            </div>
            <div className="form-actions">
              <Button disabled={busy} type="submit">
                <ShieldCheck />
                プロフィールを保存
              </Button>
            </div>
          </form>
        </section>
        <section className="panel settings-panel">
          <h2>応募の範囲・事前同意</h2>
          <p className="help">
            選択したカテゴリと応募上限の範囲で動作します。広告・メールマガジンへの同意は自動で行いません。
          </p>
          <form onSubmit={saveConsent}>
            <div className="settings-control">
              <label>応募したいカテゴリ</label>
              <div className="preference-categories">
                {CATEGORIES.map((c) => (
                  <label className="check-label" key={c}>
                    <input
                      type="checkbox"
                      checked={cats.includes(c)}
                      onChange={(e) =>
                        setCats(
                          e.target.checked
                            ? [...cats, c]
                            : cats.filter((x) => x !== c),
                        )
                      }
                    />
                    {c}
                  </label>
                ))}
              </div>
            </div>
            <div className="settings-control">
              <label>応募しないカテゴリ</label>
              <div className="preference-categories">
                {CATEGORIES.map((c) => (
                  <label className="check-label" key={c}>
                    <input
                      type="checkbox"
                      checked={excluded.includes(c)}
                      onChange={(e) =>
                        setExcluded(
                          e.target.checked
                            ? [...excluded, c]
                            : excluded.filter((x) => x !== c),
                        )
                      }
                    />
                    {c}
                  </label>
                ))}
              </div>
            </div>
            <div className="settings-control">
              <label htmlFor="daily-limit">1日の最大応募件数</label>
              <input
                id="daily-limit"
                type="number"
                min={1}
                max={100}
                required
                value={limit}
                onChange={(e) => setLimit(Number(e.target.value))}
              />
              <p className="help">日本時間の1日ごとに上限を適用します。</p>
            </div>
            <div className="thin-line" />
            <label className="check-label">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
              />
              登録した個人情報を、設定した条件に合致し規約を確認できた懸賞の応募先へ自動送信することに同意します。
            </label>
            <label className="check-label">
              <input
                type="checkbox"
                checked={privacy}
                onChange={(e) => setPrivacy(e.target.checked)}
              />
              応募に必要な個人情報の取り扱いへの同意（privacy）を承認します。追加の契約や広告同意は承認しません。
            </label>
            <p className="help">
              同意を解除すると自動応募もOFFになります。送信済みの応募は取り消されません。
            </p>
            <div className="form-actions">
              <Button disabled={busy} type="submit">
                <Check />
                応募設定を保存
              </Button>
            </div>
          </form>
        </section>
        <section className="panel settings-panel danger-panel">
          <h2>アカウントとデータ</h2>
          <p className="help">
            プロフィール、応募履歴、収集データを削除します。外部サイトに送信済みの情報は、そのサイトで別途削除手続きが必要です。
          </p>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={async () => {
              if (
                window.confirm(
                  "プロフィールとすべての履歴を削除します。元に戻せません。削除しますか？",
                )
              ) {
                const ok = await mutate(
                  "/api/account",
                  "DELETE",
                  undefined,
                  "アカウントデータを削除しました",
                );
                if (ok) window.location.reload();
              }
            }}
          >
            <Trash2 />
            アカウントとデータを削除
          </Button>
        </section>
      </div>
      <div>
        <section className="panel settings-panel">
          <h2>自動実行</h2>
          <div className="settings-toggle">
            <div>
              <strong>自動収集</strong>
              <p>クラウドワーカーで6時間ごとに収集</p>
            </div>
            <Switch
              label="設定の自動収集"
              checked={data.preferences.autoCollect}
              onChange={() =>
                setPrefs({ autoCollect: !data.preferences.autoCollect })
              }
              disabled={busy}
            />
          </div>
          <div className="settings-toggle">
            <div>
              <strong>自動応募</strong>
              <p>条件に合致する確認済みフォームのみ</p>
            </div>
            <Switch
              label="設定の自動応募"
              checked={data.preferences.autoApply}
              onChange={toggleAuto}
              disabled={busy || data.preferences.emergencyStop}
            />
          </div>
          <p className="help">
            {data.mode === "demo"
              ? "ローカル環境では自動スケジュールは動きません。GitHub Actions の設定後に有効になります。"
              : "GitHub Actions のワークフローと必要なシークレットを設定してください。実行時刻はサービスの状況により遅れる場合があります。"}
          </p>
          <div className="thin-line" />
          <Button
            variant="outline"
            className="w-100"
            disabled={
              busy ||
              !data.preferences.autoApply ||
              data.preferences.emergencyStop
            }
            onClick={() =>
              mutate(
                "/api/run",
                "POST",
                { kind: "apply" },
                "応募ジョブを実行しました。履歴を確認してください。",
              )
            }
          >
            <Zap />
            応募ジョブを今すぐ実行
          </Button>
          <div style={{ marginTop: 12 }}>
            <Button
              variant="destructive"
              className="w-100"
              disabled={busy}
              onClick={() =>
                setPrefs(
                  data.preferences.emergencyStop
                    ? { emergencyStop: false, autoApply: false }
                    : { emergencyStop: true, autoApply: false },
                )
              }
            >
              <CircleStop />
              {data.preferences.emergencyStop
                ? "緊急停止を解除（自動応募はOFF）"
                : "緊急停止する"}
            </Button>
          </div>
        </section>
        <section className="panel settings-panel">
          <h2>収集先の管理</h2>
          <p className="help">
            公式のRSSやキャンペーンページを登録します。規約とrobots.txtで許可された範囲を取得します。
          </p>
          {data.sources.map((s) => (
            <div key={s.id} className="source-item">
              <div>
                <strong>
                  {s.name}{" "}
                  <span className="source-kind">{s.kind.toUpperCase()}</span>
                </strong>
                <p>{s.kind === "fixture" ? "ローカルの検証用データ" : s.url}</p>
                <p>
                  {s.enabled ? "有効" : "停止中"} ·{" "}
                  {s.termsAccepted ? "利用条件を確認済み" : "利用条件は未確認"}
                </p>
              </div>
              <Button
                variant="ghost"
                size="icon"
                disabled={busy}
                aria-label={`${s.name}を削除`}
                onClick={() =>
                  mutate(
                    `/api/sources?id=${encodeURIComponent(s.id)}`,
                    "DELETE",
                    undefined,
                    "収集先を削除しました",
                  )
                }
              >
                <Trash2 />
              </Button>
            </div>
          ))}
          {data.mode === "demo" &&
            !data.sources.some((s) => s.kind === "fixture") && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() =>
                  mutate(
                    "/api/sources",
                    "POST",
                    {
                      source: {
                        id: crypto.randomUUID(),
                        name: "動作確認用キャンペーン",
                        url: "https://example.com/demo",
                        kind: "fixture",
                        enabled: true,
                        termsAccepted: true,
                        allowedHosts: ["example.com"],
                      },
                    },
                    "テスト用の収集先を追加しました",
                  )
                }
              >
                <Plus />
                テスト用の収集先を追加
              </Button>
            )}
          <form className="source-form" onSubmit={addSource}>
            <div className="form-grid">
              <label className="wide">
                収集先の名前
                <input
                  required
                  maxLength={100}
                  value={sourceName}
                  onChange={(e) => setSourceName(e.target.value)}
                  placeholder="企業公式キャンペーン"
                />
              </label>
              <label>
                種類
                <select
                  value={sourceKind}
                  onChange={(e) =>
                    setSourceKind(e.target.value as "rss" | "html")
                  }
                >
                  <option value="rss">RSS</option>
                  <option value="html">HTML</option>
                </select>
              </label>
              <label>
                URL
                <input
                  type="url"
                  required
                  value={sourceUrl}
                  onChange={(e) => setSourceUrl(e.target.value)}
                  placeholder="https://…"
                />
              </label>
              <label className="wide">
                追加で許可する公式ホスト（カンマ区切り）
                <input
                  value={sourceHosts}
                  onChange={(e) => setSourceHosts(e.target.value)}
                  placeholder="campaign.example.jp"
                />
              </label>
            </div>
            <label className="check-label">
              <input
                type="checkbox"
                required
                checked={sourceTerms}
                onChange={(e) => setSourceTerms(e.target.checked)}
              />
              この収集先の利用条件を確認し、情報取得が許可されていることを確認しました。
            </label>
            <Button
              type="submit"
              variant="outline"
              className="w-100"
              disabled={busy}
            >
              <Plus />
              収集先を追加
            </Button>
          </form>
        </section>
        <section className="panel settings-panel">
          <h2>連携状況</h2>
          <div className="fact">
            <span>データベース</span>
            <b>{data.mode === "demo" ? "SQLite · ローカル" : "Supabase"}</b>
          </div>
          <div className="fact">
            <span>AI API</span>
            <b>{data.aiConfigured ? "設定あり" : "未設定"}</b>
          </div>
          <div className="fact">
            <span>解析方式</span>
            <b>検証可能なルールエンジン</b>
          </div>
          <p className="help">
            APIキーは環境変数で管理します。AI
            APIが未設定でもルールベースの解析が動作します。Gmail連携は今後追加予定です。
          </p>
        </section>
      </div>
    </div>
  );
}
function CampaignDetail({
  campaign: c,
  data,
  onClose,
  busy,
  mutate,
}: {
  campaign: Campaign;
  data: DashboardData;
  onClose: () => void;
  busy: boolean;
  mutate: Mutate;
}) {
  const application = data.applications.find((a) => a.campaignId === c.id);
  const status = statusOf(c, data.applications);
  useEffect(() => {
    const before = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function key(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", key);
    return () => {
      document.body.style.overflow = before;
      window.removeEventListener("keydown", key);
    };
  }, [onClose]);
  const safeUrl = (url: string) => {
    try {
      const u = new URL(url);
      return ["https:", ...(c.isDemo ? ["http:"] : [])].includes(u.protocol)
        ? u.href
        : "#";
    } catch {
      return "#";
    }
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="キャンペーン詳細"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <p className="eyebrow">
              CAMPAIGN DETAILS {c.isDemo ? "· TEST DATA" : ""}
            </p>
            <h2>{c.title}</h2>
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label="詳細を閉じる"
            onClick={onClose}
          >
            <X />
          </Button>
        </div>
        <StatusBadge status={status} />
        <p>
          {c.organizer} · {c.prize}
        </p>
        {c.isDemo && (
          <div className="alert success">
            <ShieldCheck />
            これはテスト用データです。賞品の提供や実際の懸賞への応募はありません。
          </div>
        )}
        <dl className="detail-facts">
          <div>
            <dt>賞品の推定価値</dt>
            <dd>¥{yen(c.estimatedValue)}</dd>
          </div>
          <div>
            <dt>当選人数</dt>
            <dd>{c.winners > 0 ? `${c.winners}名様` : "未確認"}</dd>
          </div>
          <div>
            <dt>応募開始 / JST</dt>
            <dd>{c.startsAt ? date(c.startsAt, true) : "未確認"}</dd>
          </div>
          <div>
            <dt>応募締切 / JST</dt>
            <dd>{date(c.deadline, true)}</dd>
          </div>
          <div>
            <dt>最終確認 / JST</dt>
            <dd>{date(c.checkedAt, true)}</dd>
          </div>
          <div>
            <dt>自動化の分類</dt>
            <dd>{verdictNames[c.rules.verdict]}</dd>
          </div>
        </dl>
        <h3>応募条件</h3>
        <ul>
          {c.conditions.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
          <li>
            購入{" "}
            {c.rules.purchaseRequired ? "必要" : "必要との記載なし（取得範囲）"}{" "}
            / 会員登録{" "}
            {c.rules.membershipRequired
              ? "必要"
              : "必要との記載なし（取得範囲）"}
          </li>
          {c.rules.minAge !== null && <li>{c.rules.minAge}歳以上</li>}
          {c.rules.captcha && <li>CAPTCHAによる本人操作が必要です</li>}
          <li>1キャンペーンにつき原則1回まで。重複送信は行いません。</li>
        </ul>
        <h3>自動化判定の根拠</h3>
        <p>{c.rules.reason}</p>
        <p>
          関連規約の確認：{c.rules.reviewedAllTerms ? "確認済み" : "未完了"} ·
          技術的な操作：
          {c.rules.technicalAllowed ? "確認済み" : "手動確認が必要"}
        </p>
        {c.rules.verdict === "silent" && (
          <p>
            禁止記載がないことは、自動化への積極的な許可を意味しません。送信前に技術面・資格・同意も確認します。
          </p>
        )}
        {c.rules.evidence.map((e, i) => (
          <div className="evidence" key={i}>
            <p>「{e.quote}」</p>
            <a href={safeUrl(e.url)} target="_blank" rel="noopener noreferrer">
              {e.url}
              <ExternalLink
                size={10}
                style={{ display: "inline", marginLeft: 5 }}
              />
            </a>
            <p>
              {date(e.fetchedAt, true)} JST · {e.kind}
            </p>
          </div>
        ))}
        {!c.rules.evidence.length && (
          <p>規約の根拠をまだ取得できていません。</p>
        )}
        {application && (
          <>
            <h3>応募結果</h3>
            <p>
              {statusNames[application.status]}
              {application.receipt ? ` · 受付番号 ${application.receipt}` : ""}
            </p>
            {application.error && <p>{application.error}</p>}
          </>
        )}
        <div className="modal-actions">
          <Button asChild>
            <a
              href={safeUrl(c.officialUrl)}
              target="_blank"
              rel="noopener noreferrer"
            >
              公式ページ
              <ExternalLink />
            </a>
          </Button>
          <Button variant="outline" asChild>
            <a
              href={safeUrl(c.entryUrl)}
              target="_blank"
              rel="noopener noreferrer"
            >
              応募ページを開く
              <ExternalLink />
            </a>
          </Button>
          {["manual_required", "eligible"].includes(status) && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={async () => {
                if (
                  window.confirm("応募先で送信が完了したことを確認しましたか？")
                ) {
                  const ok = await mutate(
                    "/api/applications",
                    "POST",
                    { campaignId: c.id, status: "submitted" },
                    "手動応募の完了を記録しました",
                  );
                  if (ok) onClose();
                }
              }}
            >
              <Check />
              手動で応募済みにする
            </Button>
          )}
        </div>
      </section>
    </div>
  );
}
