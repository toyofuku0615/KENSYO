import { getStore } from "../src/lib/store";
import { createAIService } from "../src/lib/ai/provider";

/** Run with a securely configured environment, never an API key CLI argument. */
async function main() {
  const store = getStore();
  const userId =
    process.env.KENSHO_MODE === "supabase"
      ? process.env.GEMINI_TEST_USER_ID
      : "local-demo-user";
  if (!userId)
    throw new Error(
      "Choose GEMINI_TEST_USER_ID for the authenticated user's saved settings",
    );
  const service = createAIService(store, userId);
  const status = await service.getStatus();
  if (!status.keyConfigured) {
    console.log(
      JSON.stringify({
        status: "not_run",
        reason:
          "Gemini APIキー未設定。設定画面またはGEMINI_API_KEYを利用してください。",
      }),
    );
    process.exitCode = 2;
    return;
  }
  const connection = await service.testConnection();
  console.log(
    JSON.stringify({
      status: connection.status,
      checkedAt: connection.checkedAt,
      error: connection.error,
      model: status.settings.model,
    }),
  );
  if (connection.status !== "success") process.exitCode = 1;
}
main().catch(() => {
  console.error(
    "Gemini接続テストを実行できませんでした。環境設定を確認してください。",
  );
  process.exitCode = 1;
});
