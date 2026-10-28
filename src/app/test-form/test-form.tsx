"use client";
import { useRef, useState } from "react";
const labels = [
  ["氏名", "name", "text"],
  ["フリガナ", "kana", "text"],
  ["メールアドレス", "email", "email"],
  ["電話番号", "phone", "tel"],
  ["郵便番号", "postalCode", "text"],
  ["住所", "address", "text"],
  ["生年月日", "birthDate", "date"],
] as const;
export default function TestForm() {
  const [step, setStep] = useState<"input" | "confirm" | "complete">("input"),
    [receipt, setReceipt] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const values = useRef<Record<string, string>>({});
  return (
    <main className="login-page">
      <section className="login-card">
        <p className="eyebrow">LOCAL TEST ONLY</p>
        {step === "complete" ? (
          <>
            <h1>応募を受け付けました</h1>
            <p>検証用フォームの受付番号</p>
            <p data-testid="receipt">{receipt}</p>
            <p>
              個人情報は保存していません。実在する懸賞への応募ではありません。
            </p>
          </>
        ) : (
          <>
            <h1>
              {step === "input" ? "テスト用応募フォーム" : "入力内容の確認"}
            </h1>
            <p>ローカル検証専用です。架空の情報を使用してください。</p>
            {step === "input" ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  values.current = Object.fromEntries(
                    new FormData(e.currentTarget).entries(),
                  ) as Record<string, string>;
                  setStep("confirm");
                }}
              >
                {labels.map(([label, name, type]) => (
                  <label key={name}>
                    {label}
                    <input
                      name={name}
                      type={type}
                      required
                      defaultValue={values.current[name] || ""}
                    />
                  </label>
                ))}
                <label>
                  都道府県
                  <select
                    name="prefecture"
                    aria-label="都道府県"
                    required
                    defaultValue={values.current.prefecture || ""}
                  >
                    <option value="">選択してください</option>
                    {[
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
                    ].map((p) => (
                      <option key={p}>{p}</option>
                    ))}
                  </select>
                </label>
                <label
                  style={{ display: "flex", gap: 8, alignItems: "center" }}
                >
                  <input
                    type="checkbox"
                    name="privacy"
                    required
                    style={{ width: "auto" }}
                  />
                  個人情報の取扱いに同意する
                </label>
                <button type="submit">入力内容を確認する</button>
              </form>
            ) : (
              <>
                <p>必須項目が入力されています。検証用フォームに送信します。</p>
                <button
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    setError("");
                    try {
                      const res = await fetch("/api/test-submit", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(values.current),
                      });
                      const body = await res.json();
                      if (!res.ok) throw new Error();
                      setReceipt(body.receipt);
                      values.current = {};
                      setStep("complete");
                    } catch {
                      setError("フォームエラー：受付できませんでした。");
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  応募を確定する
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setStep("input")}
                >
                  修正する
                </button>
                <p role="alert">{error}</p>
              </>
            )}
          </>
        )}
      </section>
    </main>
  );
}
