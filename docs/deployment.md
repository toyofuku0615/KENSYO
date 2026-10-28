# 自分で使うための接続・公開手順

Web 画面は Vercel、認証と DB は Supabase、定期ワーカーは GitHub Actions に配置します。**先に Supabase の認証と RLS をローカルから確認し、その後に本番モードを公開します。demo モードは公開しません。** この接続作業で実在する懸賞への応募は行いません。

URL の `<...>` は自分のプロジェクトの値に置き換えてください。サービスの画面名は更新で多少変わる場合があります。

## 1. この実行環境で確認できた接続状態

| サービス | 確認結果                                                                                                                                                                                                                            | 次に必要なこと                                                                                                                   |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| GitHub   | 既存の認証付き HTTPS Git で読み取り・書き込みを確認し、`codex/initial-mvp` ブランチへコードを保存しました。現在このブランチが既定ブランチです。CLI のリポジトリ API は `Forbidden` のため、Actions の結果は画面で確認してください。 | トークン作成やコードの手動アップロードは不要です。https://github.com/toyofuku0615/KENSYO/tree/codex/initial-mvp で確認できます。 |
| Supabase | 本環境で接続先 URL、API キー設定、CLI のプロジェクトリンクを確認できません。                                                                                                                                                        | 本人のブラウザでプロジェクトを選択または作成し、接続情報を安全な設定先へ直接入力します。                                         |
| Vercel   | 本環境で認証・プロジェクトリンクを確認できません。                                                                                                                                                                                  | 本人のブラウザで GitHub リポジトリへのアクセスを許可し、プロジェクトを作成します。                                               |

ブラウザ側のログイン状態は本環境から確認できません。既存アカウント・既存プロジェクトがあれば再利用してください。新しい API トークンが必要と判明したわけではありません。

## 2. Supabase のプロジェクトと DB を用意する

1. [Supabase Dashboard](https://supabase.com/dashboard) を開きます。未ログインなら **Sign in** を押し、普段のアカウントでログインします。
2. 使うプロジェクトがあれば開きます。なければ **New project** を押します。
3. **Organization** に自分の組織、**Project name** に `kensho-hunter` を指定します。**Database Password** はパスワードマネージャーで生成・保管し、チャットへ送らないでください。
4. **Region** は日本に近い選択肢（東京があれば Tokyo）を選び、無料プランであることを確認して **Create new project** を押します。
5. 起動完了後、左メニューの **SQL Editor** → **New query** を押します。リポジトリの `supabase/migrations/202610280001_initial.sql` 全体を貼り付け、対象プロジェクトを確認して **Run** を押します。SQL に API キーやパスワードは入れません。
6. 別の **New query** で `supabase/tests/rls.sql` 全体を実行します。続けて `supabase/tests/claims.sql` も別クエリで実行します。いずれもエラーなく完了することを確認します。

テストは架空のユーザーをトランザクション内で追加し、最後にロールバックします。RLS は他人のデータの参照・直接変更・サービス専用 RPC の実行を制限し、claims は応募の排他・上限・結果不明時の再送禁止・ジョブ再取得を検証します。**失敗した場合は公開へ進まず、秘密を除いたエラー内容だけを知らせてください。** `scripts/test-rls.sh` は使い捨ての空の PostgreSQL 用です。既存 Supabase プロジェクトには実行しません。

## 3. 接続情報をチャットを介さずに保存する

Supabase の **Project Settings** → **API / Data API** で **Project URL** を確認します。**API Keys** で `anon` と `service_role` キーを確認します。新しいキー形式が併記される画面では、この実装に合わせて **Legacy anon, service_role API keys** を選びます。

自分の PC または信頼する開発環境でリポジトリを開き、`.env.local` がない場合だけテンプレートをコピーします。

```bash
test -e .env.local || cp .env.example .env.local
```

`.env.local` をエディタで開き、次を入力します。ファイルは `.gitignore` に含まれます。

| 名前                            | 入力内容                            |
| ------------------------------- | ----------------------------------- |
| `KENSHO_MODE`                   | `supabase`                          |
| `APP_ORIGIN`                    | `http://127.0.0.1:3000`             |
| `NEXT_PUBLIC_SUPABASE_URL`      | Project URL                         |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `anon` キー                         |
| `SUPABASE_SERVICE_ROLE_KEY`     | `service_role` キー。サーバー専用。 |
| `PROFILE_ENCRYPTION_KEY`        | 以下で一度だけ生成する暗号鍵        |

次のコマンドは既存の鍵を上書きせず、画面にも表示しません。

```bash
mkdir -p .data
test -e .data/production-profile.key || (umask 077; openssl rand -base64 32 > .data/production-profile.key)
```

`.data/production-profile.key` をエディタで開き、その値を `.env.local` の `PROFILE_ENCRYPTION_KEY` に設定します。後で Vercel と GitHub Actions にも**同じ値**を設定し、パスワードマネージャーにも保管します。鍵を失ったり変更したりすると既存プロフィールを復号できません。

`service_role`、暗号鍵、DB パスワードはチャット・Git・スクリーンショットに入れません。`SUPABASE_SERVICE_ROLE_KEY` や `PROFILE_ENCRYPTION_KEY` に `NEXT_PUBLIC_` を付けません。`.env.local` 自体をアップロードしません。

## 4. 公開前に実際の Supabase 認証とアクセス制御を確認する

1. Supabase の **Authentication** → **Sign In / Providers**（または **Providers**）→ **Email** を開き、メール認証を有効にします。
2. **Authentication** → **URL Configuration** で **Site URL** を `http://127.0.0.1:3000` にします。
3. **Redirect URLs** → **Add URL** から `http://127.0.0.1:3000/auth/callback` を追加し、**Save** を押します。
4. 開発サーバーを停止して `.env.local` を保存し、`npm run dev` で起動し直します。外部公開するアドレスにはバインドしません。
5. ローカルアプリで、未ログイン時にログイン画面へ移ることを確認します。自分のメールアドレスを入力し、**ログインリンクを送る** を押します。
6. 届いたメールのリンクを、送信を依頼したのと**同じブラウザ**で開きます。Supabase のメール送信上限に達した場合は時間を空けてください。必要になった場合だけ **Authentication** → **Email / SMTP Settings** でメール送信サービスを設定します。
7. 架空の検証用プロフィールを保存し、再読み込み後も自分の設定が見えることを確認します。自動応募は **OFF** のままにします。
8. シークレットウィンドウでは、未ログインの `/api/dashboard` が `401` となり個人情報を返さないことを確認します。別のメールアドレスでログインできる場合は、最初のユーザーのプロフィールや履歴が見えないことも確認します。

実際の Supabase 上の SQL テスト、ログイン、保存、未認証アクセス拒否が成功してから公開へ進みます。SQLite のテスト成功だけで Supabase 認証が確認できたとは扱いません。一人だけで利用する場合は、最初のログイン確認後に **Authentication** → **Sign In / Providers** の **Allow new users to sign up** を無効にすると、新規登録を止められます。既存の自分のユーザーで再ログインできることを確認してください。

## 5. Vercel に本番モードで配置する

1. [Vercel の新規プロジェクト画面](https://vercel.com/new) を開き、普段のアカウントでログインします。
2. **Import Git Repository** から `toyofuku0615/KENSYO` を選び、**Import** を押します。表示されなければ **Adjust GitHub App Permissions** または **Install** を開き、GitHub 側で **Only select repositories** → `KENSYO` を選んで許可します。
3. **Project Name** に利用可能な名前（例 `kensho-hunter-toyofuku0615`）を入力します。**Framework Preset** は **Next.js**、**Root Directory** はリポジトリのルートです。
4. **Build and Output Settings** で **Install Command** を `npm ci`、**Build Command** を `npm run build` にします。Node.js は **24.x** を選びます。既定ブランチ以外にコードが保存されている場合は、その作業ブランチを選びます。
5. **Environment Variables** に次を直接登録します。API キーは Supabase、暗号鍵は自分の保管先からコピーします。

| 名前                            | Vercel に登録する値                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------ |
| `KENSHO_MODE`                   | **`supabase`**。`demo` は使いません。                                                      |
| `APP_ORIGIN`                    | 公開先の HTTPS origin。例 `https://kensho-hunter-toyofuku0615.vercel.app`。末尾 `/` なし。 |
| `NEXT_PUBLIC_SUPABASE_URL`      | Project URL                                                                                |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `anon` キー                                                                                |
| `SUPABASE_SERVICE_ROLE_KEY`     | `service_role` キー。機密変数として登録。                                                  |
| `PROFILE_ENCRYPTION_KEY`        | 自分で生成・保管した同じ暗号鍵。機密変数として登録。                                       |

6. 公開前の認証・RLS 検証と `KENSHO_MODE=supabase` を再確認して **Deploy** を押します。`.env.local` や `.data` はアップロードしません。
7. **Project** → **Settings** → **Domains** で実際のドメインを確認します。`APP_ORIGIN` と異なれば **Settings** → **Environment Variables** で修正し、**Deployments** → 対象の **…** → **Redeploy** を押します。プレビュー環境へ本番 DB を不用意に接続しません。
8. Supabase の **Authentication** → **URL Configuration** で **Site URL** を公開 origin にし、**Redirect URLs** に `https://<実際の公開ドメイン>/auth/callback` を追加して **Save** を押します。確認中はローカル callback も残せます。`*` は追加しません。
9. 公開アプリの `/login` からログインし、シークレットウィンドウの `/api/dashboard` が引き続き `401` であることを確認します。ログインできない場合に demo へ切り替えて公開することはしません。

## 6. GitHub Actions の接続を設定する

GitHub にコードが保存済みなら、手動でアップロードし直す必要はありません。

1. [Actions のシークレット設定](https://github.com/toyofuku0615/KENSYO/settings/secrets/actions) を開きます。画面からは **Settings** → **Secrets and variables** → **Actions** の順に進めます。
2. **New repository secret** を押し、**Name** に `NEXT_PUBLIC_SUPABASE_URL`、**Secret** に Project URL を入力して **Add secret** を押します。
3. 同じ操作で `SUPABASE_SERVICE_ROLE_KEY` と `PROFILE_ENCRYPTION_KEY` を登録します。値は Vercel と同じものです。チャットや Issue には貼りません。
4. [Actions](https://github.com/toyofuku0615/KENSYO/actions) を開き、必要ならワークフローを有効にします。**Build and test** の成功を確認します。
5. **Kensho Hunter scheduled worker** → **Run workflow** でコードを保存したブランチを選び、**Run workflow** を押します。最初は自動応募 **OFF** のまま、接続と実行履歴を確認します。

定期実行には `.github/workflows/worker.yml` が GitHub の**デフォルトブランチ**に必要です。作業ブランチの場合はレビュー・CI 成功後に Pull Request をマージします。UTC の `17 */6 * * *`、日本時間では **03:17 / 09:17 / 15:17 / 21:17** です。GitHub の混雑などで遅延し、定刻や常時稼働は保証されません。

Vercel のリクエストでは Playwright を起動しません。Web からの実行予約を次のワーカーが処理します。すぐ処理したい場合も上記 **Run workflow** を使います。予約は 30 分間リースされ、成功したときだけ完了します。送信済み・結果不明の応募は再送しません。

## 7. 利用開始と停止

- 最初は自動応募を **OFF** にし、取得を許可された公式 RSS / HTML だけを登録します。規約・robots.txt と取得先ホストの許可が必要です。
- 現在の実サイト案件は手動対象です。`ENABLE_LIVE_SUBMISSIONS=true` だけでは実サイト送信は有効になりません。同梱する送信アダプターはローカルの `local-test` のみです。
- 緊急停止は応募直前にも確認しますが、既に相手サーバーへ届いた送信は取り消せません。`unknown_result` は自動再送せず受付状態を確認します。
- アカウント削除はプロフィール・履歴と Supabase Auth ユーザーを削除します。必要な記録は先に確認してください。
- 無料枠で開始できますが、保存量・メール送信・Actions 実行時間・休止条件の上限があります。月額 0 円や永久稼働を保証するものではありません。
