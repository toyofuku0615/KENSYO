"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CircleAlert,
  Clock3,
  ExternalLink,
  KeyRound,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AIConnection, AISettings, AIUsage } from "@/core/ai-types";

type Status = {
  mode: "demo" | "supabase";
  settings: AISettings;
  connection: AIConnection;
  usage: AIUsage;
  keyConfigured: boolean;
  keySource: "stored" | "environment" | "none";
  provider: "Google Gemini";
};
type Model = { id: string; displayName: string };
const integer = new Intl.NumberFormat("ja-JP");
const time = (value: string | null) => {
  if (!value || !Number.isFinite(Date.parse(value)))
    return "まだ確認していません";
  return (
    new Intl.DateTimeFormat("ja-JP", {
      timeZone: "Asia/Tokyo",
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value)) + " JST"
  );
};
const errorMessages: Record<string, string> = {
  FREE_TIER_CONFIRMATION:
    "公式の料金・利用上限を確認して、確認欄にチェックしてください。",
  LIMIT:
    "アプリの呼び出し・トークン上限に達しました。利用状況を確認してください。",
  INPUT_SIZE: "解析対象のサイズが上限を超えています。",
  UNSAFE_INPUT: "解析対象に送信できない情報が含まれているため停止しました。",
  RATE_LIMITED: "Geminiの利用制限に達したため、呼び出しを保留しています。",
  AUTHENTICATION: "APIキーの権限・有効性をGoogle AI Studioで確認してください。",
  UNAVAILABLE:
    "Geminiへ接続できませんでした。ネットワーク設定を確認してください。",
  UNCONFIGURED: "APIキーが設定されていません。",
  KEY_MISSING: "APIキーが設定されていません。",
  MODEL_REQUIRED:
    "利用可能なモデルを取得し、使用するモデルを選択してください。",
  MODEL_NOT_FOUND:
    "選択したモデルを利用できません。モデル一覧を更新してください。",
  MODEL_UNAVAILABLE:
    "選択したモデルを利用できません。モデル一覧を更新してください。",
  FREE_TIER_NOT_ACKNOWLEDGED:
    "公式の料金・利用上限を確認して、確認欄にチェックしてください。",
  DISABLED: "AI機能がOFFです。設定を保存してから試してください。",
  RATE_LIMIT: "利用制限に達しました。時間を空けてから再度お試しください。",
  QUOTA_EXCEEDED: "アプリの利用上限に達しました。利用状況を確認してください。",
  BUDGET_EXCEEDED: "アプリの利用上限に達しました。利用状況を確認してください。",
  TIMEOUT: "接続が時間切れになりました。時間を空けて接続を確認してください。",
  AUTH_ERROR: "APIキーの権限・有効性をGoogle AI Studioで確認してください。",
  INVALID_KEY: "APIキーの権限・有効性をGoogle AI Studioで確認してください。",
  NETWORK_ERROR:
    "Geminiへ接続できませんでした。ネットワーク設定を確認してください。",
  AI_REQUEST_FAILED:
    "AIの処理を完了できませんでした。設定と利用状況を確認してください。",
  INVALID_RESPONSE:
    "AIの応答を安全に検証できなかったため、処理を停止しました。",
  INPUT_TOO_LARGE: "解析対象のサイズが上限を超えています。",
  INPUT_REJECTED: "解析対象に送信できない情報が含まれているため停止しました。",
};
function errorText(code: string | null) {
  if (!code) return "なし";
  return (
    errorMessages[code.toUpperCase()] ||
    "AIの処理を完了できませんでした。設定・接続・利用上限を確認してください。"
  );
}
function connectionLabel(status: Status) {
  if (!status.keyConfigured) return "未設定";
  if (status.connection.status === "success") return "接続成功";
  if (status.connection.status === "failed") return "接続失敗";
  return "未確認";
}
function UsageMetric({
  title,
  value,
  unit = "回",
  description,
}: {
  title: string;
  value: number;
  unit?: string;
  description: string;
}) {
  return (
    <div className="ai-usage-metric">
      <span>{title}</span>
      <strong>
        {integer.format(value)}
        <small>{unit}</small>
      </strong>
      <p>{description}</p>
    </div>
  );
}

export default function AISettingsPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [draft, setDraft] = useState<AISettings | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState<Model[]>([]);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const refresh = useCallback(async (resetDraft = false) => {
    const response = await fetch("/api/settings/ai", { cache: "no-store" });
    if (response.status === 401) {
      window.location.assign("/login");
      return;
    }
    if (!response.ok) throw new Error("STATUS_FAILED");
    const next = (await response.json()) as Status;
    setStatus(next);
    if (resetDraft) setDraft(next.settings);
  }, []);
  useEffect(() => {
    refresh(true).catch(() =>
      setError(
        "AI設定を取得できませんでした。接続設定を確認し、再読み込みしてください。",
      ),
    );
  }, [refresh]);

  async function mutate(path: string, method: string, body?: unknown) {
    const response = await fetch(path, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status === 401) {
      window.location.assign("/login");
      throw new Error("UNAUTHENTICATED");
    }
    const result: unknown = await response.json();
    if (!response.ok) {
      const code =
        typeof result === "object" && result !== null && "code" in result
          ? String(result.code).toUpperCase()
          : null;
      throw new Error(
        code && Object.hasOwn(errorMessages, code) ? code : "AI_REQUEST_FAILED",
      );
    }
    return result;
  }
  async function perform(operation: string, run: () => Promise<void>) {
    setBusy(operation);
    setError("");
    setNotice("");
    try {
      await run();
    } catch (failure) {
      setError(
        errorText(
          failure instanceof Error
            ? failure.message.toUpperCase()
            : "AI_REQUEST_FAILED",
        ),
      );
      await refresh().catch(() => undefined);
    } finally {
      setBusy(null);
    }
  }
  function change<K extends keyof AISettings>(name: K, value: AISettings[K]) {
    setDraft((current) => (current ? { ...current, [name]: value } : current));
  }
  async function saveSettings(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    await perform("settings", async () => {
      await mutate("/api/settings/ai", "PUT", { settings: draft });
      await refresh(true);
      setNotice(
        "AI設定を保存しました。モデルを変更した場合は、接続テストで利用可否を確認してください。",
      );
    });
  }
  const disabled = busy !== null;
  const selected = draft?.model || "";
  const currentModelListed = models.some((model) => model.id === selected);
  return (
    <main className="ai-page">
      <header className="ai-topbar">
        <a href="/" className="ai-brand">
          <span>
            <Sparkles size={19} />
          </span>
          懸賞ハンターAI <small>AI SETTINGS</small>
        </a>
        <a href="/" className="ai-back">
          <ArrowLeft size={15} />
          ダッシュボードへ
        </a>
      </header>
      <div className="ai-content">
        <div className="ai-page-heading">
          <div>
            <p className="eyebrow">YOUR PRIVATE AI WORKSPACE</p>
            <h1>AI設定</h1>
            <p className="subtitle">Geminiの接続と、使う範囲をあなたの手で。</p>
          </div>
          <span className="ai-provider">
            <Sparkles size={14} />
            Google Gemini
          </span>
        </div>
        {error && (
          <div className="alert" role="alert">
            <CircleAlert size={18} />
            {error}
          </div>
        )}
        {notice && (
          <div className="alert success" role="status">
            <Check size={18} />
            {notice}
          </div>
        )}
        {!status || !draft ? (
          <section className="panel ai-loading">
            <LoaderCircle className="spin" />
            <p>AI設定を読み込んでいます…</p>
            {error && (
              <Button
                variant="outline"
                onClick={() =>
                  refresh(true).catch(() =>
                    setError("接続設定を確認してください。"),
                  )
                }
              >
                再読み込み
              </Button>
            )}
          </section>
        ) : (
          <>
            <div className="ai-privacy">
              <ShieldCheck size={22} />
              <div>
                <strong>個人情報は、AIに渡しません。</strong>
                <p>
                  Geminiが読むのは公開情報とフォームの構造です。氏名・住所・連絡先・生年月日・入力後の画面は送信せず、プロフィールの入力はローカル処理で行います。
                </p>
              </div>
            </div>
            {status.mode === "demo" && (
              <section className="panel ai-panel" style={{ marginBottom: 20 }}>
                <h2>ローカルの模擬フォームで確認する</h2>
                <p className="help">
                  基本・アンケート・自由記述・クイズ・複数ページなど10種類を、テストデータとして追加できます。実在サイトへは送信しません。AI未設定時は手動確認になります。Geminiを使う場合は、先に接続と利用上限を確認してください。
                </p>
                <Button
                  variant="outline"
                  disabled={disabled}
                  onClick={() =>
                    void perform("fixtures", async () => {
                      await mutate("/api/sources", "POST", {
                        source: {
                          id: "demo-ai-fixture",
                          name: "Gemini汎用フォーム検証（架空）",
                          url: "https://example.com/demo/ai",
                          kind: "fixture",
                          enabled: true,
                          termsAccepted: true,
                          allowedHosts: ["example.com"],
                        },
                      });
                      setNotice(
                        "AI模擬フォームの収集先を追加しました。ダッシュボードの「今すぐ収集」で検証用の10件を取得できます。",
                      );
                    })
                  }
                >
                  AI模擬フォームの収集先を追加
                </Button>
              </section>
            )}
            <div className="ai-columns">
              <div className="ai-main-column">
                <section className="panel ai-panel">
                  <div className="ai-section-heading">
                    <span className="ai-section-icon">
                      <KeyRound size={20} />
                    </span>
                    <div>
                      <h2>AI接続設定</h2>
                      <p>キーはサーバーで暗号化し、この画面には返しません。</p>
                    </div>
                  </div>
                  <div className="ai-connection-status">
                    <span
                      className={`ai-connection-badge ${status.connection.status === "success" && status.keyConfigured ? "connected" : status.connection.status === "failed" ? "failed" : ""}`}
                    >
                      <span />
                      {connectionLabel(status)}
                    </span>
                    <span>最終確認：{time(status.connection.checkedAt)}</span>
                  </div>
                  <div className="ai-key-meta">
                    <span>APIキー</span>
                    <strong>
                      {status.keyConfigured ? "設定済み ••••••••" : "未設定"}
                    </strong>
                    <small>
                      {status.keySource === "stored"
                        ? "Web画面から登録したキーを使用"
                        : status.keySource === "environment"
                          ? "環境変数 GEMINI_API_KEY を使用"
                          : "まだキーが登録されていません"}
                    </small>
                  </div>
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void perform("save-key", async () => {
                        await mutate("/api/settings/ai", "POST", { apiKey });
                        setApiKey("");
                        setModels([]);
                        setModelsLoaded(false);
                        await refresh();
                        setNotice(
                          "APIキーを暗号化して保存しました。続けてモデルを取得してください。",
                        );
                      });
                    }}
                  >
                    <label htmlFor="gemini-api-key">Gemini APIキー</label>
                    <input
                      id="gemini-api-key"
                      name="gemini-api-key"
                      type="password"
                      autoComplete="new-password"
                      spellCheck={false}
                      value={apiKey}
                      onChange={(event) => setApiKey(event.target.value)}
                      placeholder={
                        status.keyConfigured
                          ? "キーを変更する場合だけ入力"
                          : "Google AI Studioで発行したキー"
                      }
                      required
                      minLength={20}
                      maxLength={512}
                    />
                    <p className="help">
                      キーはチャットやGitに貼らず、この入力欄から保存してください。Web登録のキーを環境変数より優先します。demoモードはローカル専用です。
                    </p>
                    <div className="ai-actions">
                      <Button
                        disabled={disabled || apiKey.trim().length < 20}
                        type="submit"
                      >
                        {busy === "save-key" ? (
                          <LoaderCircle className="spin" />
                        ) : (
                          <ShieldCheck />
                        )}
                        APIキーを保存
                      </Button>
                      <Button
                        variant="outline"
                        type="button"
                        disabled={disabled || !status.keyConfigured}
                        onClick={() =>
                          void perform("test", async () => {
                            await mutate("/api/settings/ai/test", "POST", {});
                            await refresh();
                            setNotice(
                              "接続テストを実行しました。接続ステータスと利用状況を確認してください。",
                            );
                          })
                        }
                      >
                        {busy === "test" ? (
                          <LoaderCircle className="spin" />
                        ) : (
                          <Zap />
                        )}
                        接続テスト
                      </Button>
                      <Button
                        variant="ghost"
                        type="button"
                        disabled={disabled || status.keySource !== "stored"}
                        onClick={() => {
                          if (
                            !window.confirm(
                              "保存したGemini APIキーを削除しますか？環境変数のキーがある場合は、そちらへ切り替わります。",
                            )
                          )
                            return;
                          void perform("delete-key", async () => {
                            await mutate("/api/settings/ai", "DELETE");
                            setApiKey("");
                            setModels([]);
                            setModelsLoaded(false);
                            await refresh();
                            setNotice(
                              "Web画面から登録したAPIキーを削除しました。環境変数のキーはこの操作では削除されません。",
                            );
                          });
                        }}
                      >
                        <Trash2 />
                        APIキーを削除
                      </Button>
                    </div>
                  </form>
                  <div className="ai-help-box">
                    <strong>まだキーを発行していない場合</strong>
                    <p>
                      <a
                        href="https://aistudio.google.com/api-keys"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Google AI StudioのAPIキー管理
                        <ExternalLink size={11} />
                      </a>
                      を開きます。接続テスト・モデル取得でもAPIへのアクセスとアプリ側の回数記録が発生します。
                    </p>
                  </div>
                </section>
                <section className="panel ai-panel">
                  <div className="ai-section-heading">
                    <span className="ai-section-icon">
                      <Sparkles size={20} />
                    </span>
                    <div>
                      <h2>モデル・利用上限</h2>
                      <p>
                        モデルは自動で切り替えません。使うモデルを明示して保存します。
                      </p>
                    </div>
                  </div>
                  <form onSubmit={saveSettings}>
                    <div className="ai-enabled-row">
                      <div>
                        <strong>AI機能</strong>
                        <p>OFFでも従来のルールベース処理を利用できます。</p>
                      </div>
                      <button
                        className={`switch ${draft.enabled ? "on" : ""}`}
                        type="button"
                        role="switch"
                        aria-label="AI機能"
                        aria-checked={draft.enabled}
                        onClick={() => change("enabled", !draft.enabled)}
                        disabled={disabled}
                      >
                        <span />
                      </button>
                    </div>
                    <div className="ai-model-controls">
                      <label htmlFor="gemini-model">
                        使用するモデル
                        <select
                          id="gemini-model"
                          aria-label="使用するモデル"
                          value={selected}
                          onChange={(event) =>
                            setDraft((current) =>
                              current
                                ? {
                                    ...current,
                                    model: event.target.value,
                                    freeTierAcknowledged: false,
                                  }
                                : current,
                            )
                          }
                          disabled={disabled}
                        >
                          <option value="">モデルを選択してください</option>
                          {selected && !currentModelListed && (
                            <option value={selected}>
                              {selected}（保存済み・一覧で利用可否を確認）
                            </option>
                          )}
                          {models.map((model) => (
                            <option key={model.id} value={model.id}>
                              {model.displayName || model.id} · {model.id}
                            </option>
                          ))}
                        </select>
                      </label>
                      <Button
                        variant="outline"
                        type="button"
                        disabled={disabled || !status.keyConfigured}
                        onClick={() =>
                          void perform("models", async () => {
                            const result = (await mutate(
                              "/api/settings/ai/models",
                              "POST",
                              {},
                            )) as { models: Model[] };
                            const unique = new Map<string, Model>();
                            for (const model of result.models || []) {
                              if (
                                typeof model.id === "string" &&
                                model.id.length <= 120 &&
                                typeof model.displayName === "string"
                              )
                                unique.set(model.id, model);
                            }
                            setModels([...unique.values()]);
                            setModelsLoaded(true);
                            await refresh();
                            setNotice(
                              unique.size
                                ? "利用可能なモデルを取得しました。料金表を確認してから選択してください。"
                                : "利用可能なテキスト生成モデルが見つかりませんでした。キーとプロジェクトを確認してください。",
                            );
                          })
                        }
                      >
                        {busy === "models" ? (
                          <LoaderCircle className="spin" />
                        ) : (
                          <RefreshCw />
                        )}
                        モデル一覧を取得
                      </Button>
                    </div>
                    <p className="help">
                      現在の保存モデル：{status.settings.model || "未選択"}。
                      {modelsLoaded
                        ? "一覧はこのキーで確認した利用可能モデルです。無料対象かどうかはAPIのモデル一覧だけでは判断できません。"
                        : "キーを保存したら「モデル一覧を取得」を押してください。固定の古いモデル名は使用しません。"}
                    </p>
                    <label className="check-label ai-tier-consent">
                      <input
                        type="checkbox"
                        checked={draft.freeTierAcknowledged}
                        onChange={(event) =>
                          change("freeTierAcknowledged", event.target.checked)
                        }
                      />
                      選択するモデルとプロジェクトの料金・無料枠・利用条件を公式情報で確認しました。
                    </label>
                    <div className="ai-resource-links">
                      <a
                        href="https://ai.google.dev/gemini-api/docs/pricing"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        公式の料金・無料枠
                        <ExternalLink size={12} />
                      </a>
                      <a
                        href="https://aistudio.google.com/usage"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        AI Studioの利用状況
                        <ExternalLink size={12} />
                      </a>
                    </div>
                    <div className="thin-line" />
                    <h3>アプリ側の利用上限</h3>
                    <p className="help">
                      接続テストを含むリクエストを制限します。日・月の境界は日本時間です。プロバイダーの実際の残枠ではありません。
                    </p>
                    <div className="ai-limit-grid">
                      {(
                        [
                          [
                            "dailyLimit",
                            "1日のAPI呼び出し上限",
                            1,
                            10000,
                            "回",
                          ],
                          [
                            "monthlyLimit",
                            "1か月のAPI呼び出し上限",
                            1,
                            100000,
                            "回",
                          ],
                          [
                            "perMinuteLimit",
                            "1分あたりの呼び出し上限",
                            1,
                            60,
                            "回",
                          ],
                          [
                            "monthlyTokenLimit",
                            "1か月のトークン上限",
                            1,
                            100000000,
                            "トークン",
                          ],
                          [
                            "maxInputChars",
                            "1リクエストの入力サイズ上限",
                            100,
                            100000,
                            "文字",
                          ],
                          [
                            "maxOutputTokens",
                            "1リクエストの出力上限",
                            16,
                            8192,
                            "トークン",
                          ],
                        ] as const
                      ).map(([key, label, min, max, unit]) => (
                        <label key={key} htmlFor={`ai-${key}`}>
                          {label}
                          <div className="ai-number-input">
                            <input
                              id={`ai-${key}`}
                              name={key}
                              aria-label={label}
                              type="number"
                              min={min}
                              max={max}
                              required
                              step={1}
                              value={draft[key]}
                              onChange={(event) =>
                                change(key, Number(event.target.value))
                              }
                              disabled={disabled}
                            />
                            <span>{unit}</span>
                          </div>
                        </label>
                      ))}
                    </div>
                    <div className="ai-actions">
                      <Button type="submit" disabled={disabled}>
                        {busy === "settings" ? (
                          <LoaderCircle className="spin" />
                        ) : (
                          <Check />
                        )}
                        AI設定を保存
                      </Button>
                    </div>
                  </form>
                </section>
              </div>
              <aside className="ai-side-column">
                <section className="panel ai-panel">
                  <div className="ai-section-heading">
                    <span className="ai-section-icon">
                      <Clock3 size={20} />
                    </span>
                    <div>
                      <h2>利用状況</h2>
                      <p>このアプリが記録した使用量</p>
                    </div>
                  </div>
                  <div className="ai-usage-grid">
                    <UsageMetric
                      title="本日の呼び出し"
                      value={status.usage.todayCalls}
                      description={`上限 ${integer.format(status.settings.dailyLimit)}回`}
                    />
                    <UsageMetric
                      title="今月の呼び出し"
                      value={status.usage.monthCalls}
                      description={`上限 ${integer.format(status.settings.monthlyLimit)}回`}
                    />
                    <UsageMetric
                      title="入力トークン"
                      value={status.usage.inputTokens}
                      unit=""
                      description="今月の記録"
                    />
                    <UsageMetric
                      title="出力トークン"
                      value={status.usage.outputTokens}
                      unit=""
                      description="今月の記録"
                    />
                  </div>
                  <div className="ai-usage-facts">
                    <div>
                      <span>解析成功</span>
                      <strong>
                        {integer.format(status.usage.analysisSuccesses)}件
                      </strong>
                    </div>
                    <div>
                      <span>解析失敗</span>
                      <strong>
                        {integer.format(status.usage.analysisFailures)}件
                      </strong>
                    </div>
                    <div>
                      <span>キャッシュ利用</span>
                      <strong>
                        {integer.format(status.usage.cachedHits)}件
                      </strong>
                    </div>
                    <div>
                      <span>記録の精度</span>
                      <strong>
                        {status.usage.estimatedTokens
                          ? "推定値を含む"
                          : "API応答の使用量"}
                      </strong>
                    </div>
                  </div>
                  {status.usage.cooldownUntil &&
                    Date.parse(status.usage.cooldownUntil) > Date.now() && (
                      <div className="ai-cooldown">
                        <Clock3 size={16} />
                        <span>
                          {time(status.usage.cooldownUntil)}まで呼び出しを保留中
                        </span>
                      </div>
                    )}
                  <div className="ai-last-error">
                    <span>直近のエラー</span>
                    <p>
                      {errorText(
                        status.usage.lastError || status.connection.error,
                      )}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    className="w-100"
                    disabled={disabled}
                    onClick={() =>
                      void perform("refresh", async () => {
                        await refresh();
                        setNotice("利用状況を更新しました。");
                      })
                    }
                  >
                    <RefreshCw />
                    利用状況を更新
                  </Button>
                </section>
                <section className="ai-cost-note">
                  <ShieldCheck size={23} />
                  <h3>無料枠を、無理なく使うために。</h3>
                  <p>
                    単純な解析はルールベースで処理し、同じ解析はキャッシュを再利用します。利用制限や429エラー時には保留し、有料モデルへ自動切替しません。
                  </p>
                  <p>
                    このカウンターはGoogleの残枠を取得した値ではありません。プロジェクトの課金設定や料金改定により、アプリの上限だけで料金0円を保証することはできません。
                  </p>
                </section>
                <section className="panel ai-panel ai-start-guide">
                  <h3>最初の接続まで</h3>
                  <ol>
                    <li>APIキーを保存する</li>
                    <li>モデル一覧を取得する</li>
                    <li>公式の料金を確認しモデルを選ぶ</li>
                    <li>AI設定を保存する</li>
                    <li>接続テストを実行する</li>
                  </ol>
                  <p>
                    登録後も、自動応募のON/OFFと個人情報利用への同意はダッシュボードで別に管理します。
                  </p>
                  <a href="/" className="ai-back">
                    ダッシュボードへ
                    <ArrowRight size={14} />
                  </a>
                </section>
              </aside>
            </div>
          </>
        )}
        <footer className="ai-footer">
          Kensho Hunter AI ·
          APIキーは暗号化して保管し、操作計画は送信前にローカルで検証します。
        </footer>
      </div>
    </main>
  );
}
