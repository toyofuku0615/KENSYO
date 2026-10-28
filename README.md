# 懸賞ハンターAI / Kensho Hunter

懸賞の発見、規約の分類、応募候補の判定、ブラウザ送信、応募履歴と当選結果を管理する日本語 Web アプリです。Next.js の画面と、GitHub Actions で動く独立ワーカーを分離しています。

既存のルールベース処理に、**Google Gemini による規約・フォーム解析と、型付きの汎用操作計画**を追加しています。API キーがなくても従来のローカル検証フォームは動作します。AI を必要とする案件は、キー未設定や API 障害時に手動確認へ移します。実サイトの操作は初期設定で無効で、AI の判断だけでは有効になりません。

## 最短で試す

必要なものは Node.js 24 以上と npm です。ローカル検証に外部アカウントや API キーは不要です。

```bash
git clone https://github.com/toyofuku0615/KENSYO.git
cd KENSYO
node --version
npm ci
cp .env.example .env.local
npx playwright install chromium
npm run dev
```

ブラウザで `http://127.0.0.1:3000` を開きます。起動コマンドはローカル接続に限定しています。既に Chromium がある環境では `.env.local` の `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` にその実行ファイルを指定でき、ブラウザのダウンロードは不要です。Linux でブラウザの OS 依存ライブラリが足りない場合は `npx playwright install --with-deps chromium` を実行します。

1. 「設定」で**架空の検証用プロフィール**を登録します。
2. 「収集」を実行します。デモ用の懸賞が追加され、テストデータであることが表示されます。
3. 個人情報の自動送信と必要な同意を確認して、自動応募を ON にします。
4. 応募実行後、履歴の受付番号を確認します。二度実行しても同じ案件を再送しません。
5. 緊急停止を押すと収集・応募を停止できます。テスト用フォームの送信は実際の懸賞への応募ではありません。

画面の件数は DB の記録から計算します。未収集時は 0 件です。推定賞品価値や優先度スコアは当選確率を表しません。

## 実装の構成

| 場所                           | 役割                                                           |
| ------------------------------ | -------------------------------------------------------------- |
| `src/app`、`src/components`    | 日本語ダッシュボード、設定、履歴、手動応募、ログイン、API      |
| `src/core/collection.ts`       | RSS / HTML アダプター、公式リンク追跡、URL 重複排除、締切判定  |
| `src/lib/ai`                   | Gemini SDK 接続、構造化出力、暗号化キー、利用量・キャッシュ    |
| `src/core/analysis.ts`         | 規約分類、資格・同意チェック、優先順位スコア                   |
| `src/core/url-safety.ts`       | HTTPS・ホスト許可・DNS・リダイレクト検証、robots.txt、取得制限 |
| `src/automation`               | 型付けされたフォーム操作計画、Playwright 実行、受付情報検証    |
| `src/lib`                      | SQLite / Supabase ストア、AES-256-GCM 暗号化、認証、入力検証   |
| `supabase/migrations`          | PostgreSQL のテーブル、RLS、応募排他 RPC                       |
| `scripts/worker.ts`            | 画面処理から分離した収集・応募ワーカー                         |
| `.github/workflows/worker.yml` | 6 時間ごとの実行、GitHub からの手動実行                        |
| `tests`                        | 単体テストとローカルフォームの E2E                             |

技術構成は Next.js App Router / TypeScript / Tailwind CSS / shadcn 形式の Radix UI 部品 / Supabase / Playwright / Zod / Vitest です。Node.js の SQLite API を使うため Node.js 24 以上が必要です。SQLite API の実験的機能に関する Node.js の警告が表示される場合があります。

## 保存とセキュリティ

`KENSHO_MODE=demo` はローカル検証用で、SQLite を `.data/kensho.sqlite` に保存します。単一の検証ユーザーで動作し、インターネット公開には使いません。プロフィールはユーザー ID に結び付けた AES-256-GCM で暗号化します。暗号鍵を明示しない場合は `.data/profile.key` が自動生成されます。DB と鍵を失わないよう一緒に安全に保管してください。

`KENSHO_MODE=supabase` は Supabase Auth と PostgreSQL を利用します。各 API は認証ユーザーを確認し、所有者 ID をサーバー側で指定します。クライアントから service role key や復号鍵を扱いません。RLS は他ユーザーの参照を防ぎ、変更処理は検証を行うサーバー API / ワーカー経由に限定します。プロフィールを平文でブラウザの localStorage に保存しません。

応募前に一意制約と DB ロックを使って予約し、日次上限は日本時間で判定します。送信後の結果が不明なら `unknown_result` とし、自動再送しません。30 分以上中断した `submitting` も結果不明に移します。スクリーンショット・動画・トレースは収集しません。ログには件数と固定のエラー文を保存します。

規約は `permitted` / `silent` / `prohibited` / `unknown` に分類します。`silent` は積極的な許可を意味しません。規約の鮮度、操作許可、本人の同意、資格、操作計画を別に確認します。ルールベース処理を維持し、設定された場合だけ Gemini を利用します。外部ページをコードやエージェント命令として実行しません。

## Gemini を設定する

設定画面の **AI 設定を開く**（`/settings/ai`）から、本人の Gemini API キーを登録できます。保存済みキー全文はクライアントへ返さず、サーバー側で AES-256-GCM 暗号化します。登録キーを優先し、ない場合だけサーバーの `GEMINI_API_KEY` を利用します。モデルは初期値なしで、API から一覧を取得して本人が選択します。有料モデルへの自動切り替えはありません。

モデル選択、無料枠確認、接続テスト、利用量上限、既存 Supabase の追加マイグレーションは [Gemini 設定手順](docs/gemini.md) を参照してください。AI API キーはチャットへ貼らず、Web のパスワード欄か安全な環境設定へ直接入力してください。無料枠の残量は正確に取得できないため、画面は本アプリのローカル使用量として表示します。

## 収集先を追加する

設定画面で RSS または HTML の HTTPS URL、取得を許可するホスト名、利用条件の確認を登録します。初期状態では実在サイトの利用許可を推定して有効にしません。情報サイトから企業公式ページへ移る場合は、その公式ホストも個別に許可してください。

収集は robots.txt と許可ホストを確認します。取得拒否・不明な robots・未承認ホスト・個別ページ取得失敗は実行履歴に記録します。すべてのニュース記事を懸賞として登録せず、締切を解釈できる案件だけを保存します。対象サイトの表現によって抽出できない場合はアダプターを追加してください。

## テストとビルド

```bash
npm run typecheck
npm test
npm run test:e2e
npm run build
```

E2E は専用サーバーを起動するため、先に `npm run dev` / `npm start` を停止してポート 3000 を空けてください。テスト専用 SQLite とローカルフォームを使います。実在する懸賞には送信しません。システム Chromium を使う場合は、テスト実行にも同じ環境変数を渡します。

```bash
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm run test:e2e
```

RLS の DB テストは Supabase の接続先を用意した上で実行します。DB URL はチャットや Git に貼らず、ローカルの安全な環境変数で指定します。

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/claims.sql
```

空の使い捨て PostgreSQL 17 を使う場合は `KENSHO_TEST_DATABASE=1 DATABASE_URL=... bash scripts/test-rls.sh` で、テスト専用 Auth 環境の構築、マイグレーション、RLS と応募排他の SQL テストをまとめて実行できます。既存 DB や本番 DB にこのブートストラップを実行しないでください。

本番ビルドをローカル検証モードで起動する場合は、明示的にモードを指定します。

```bash
npm run build
KENSHO_MODE=demo npm start
```

`npm run worker` はプロセスの環境変数を読みます。`.env.local` を自動ロードする前提にはしないでください。Node.js の env-file オプションを使うと次のように実行できます。

```bash
node --env-file=.env.local --import tsx scripts/worker.ts
```

## クラウドへの公開

[デプロイ手順](docs/deployment.md) に、Supabase / Vercel / GitHub Actions の登録先、環境変数、SQL 適用、認証 URL、定期実行を記載しています。接続情報の設定とユーザー自身の外部サービス操作が必要です。このソースコードだけでアカウント作成・公開・課金・実サイト応募は行いません。

[制限事項](docs/limitations.md) には実サイト対応、無料枠、AI の制約と Gmail の未対応範囲、収集と送信の制約を記載しています。
