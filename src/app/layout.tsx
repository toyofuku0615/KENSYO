import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "懸賞ハンターAI | あなたの毎日に、小さなチャンスを。",
  description:
    "懸賞の発見から規約確認、応募履歴まで。あなたのための懸賞アシスタント。",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
