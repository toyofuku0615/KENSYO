"use client";
import { useState } from "react";
export default function Login() {
  const [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <main className="login-page">
      <form
        className="login-card"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setMessage("");
          try {
            const email = new FormData(e.currentTarget).get("email");
            const res = await fetch("/api/auth", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ email }),
            });
            const body = await res.json();
            setMessage(
              res.ok ? "ログインリンクをメールで送りました。" : body.error,
            );
          } catch {
            setMessage("接続に失敗しました。");
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="eyebrow">KENSHO HUNTER</p>
        <h1>おかえりなさい。</h1>
        <p>メールに届くリンクから、安全にログインできます。</p>
        <label>
          メールアドレス
          <input
            name="email"
            type="email"
            required
            autoComplete="email"
            placeholder="you@example.com"
          />
        </label>
        <button type="submit" disabled={busy}>
          {busy ? "送信中…" : "ログインリンクを送る"}
        </button>
        <p role="status">{message}</p>
        <a href="/">ダッシュボードへ</a>
      </form>
    </main>
  );
}
