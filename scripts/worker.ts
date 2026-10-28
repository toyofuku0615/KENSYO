import { getStore } from "../src/lib/store";
import { runApplications, runCollection } from "../src/core/runner";

async function main() {
  const store = getStore();
  const users = await store.listUserIds();
  let failed = false;
  for (const userId of users) {
    const preferences = await store.getPreferences(userId);
    if (preferences.emergencyStop) continue;
    const requests = await store.takeRunRequests(userId);
    if (preferences.autoCollect || requests.includes("collect")) {
      const run = await runCollection(store, userId);
      // Counts only: no user identifiers, profile values, page text or raw exceptions.
      console.log(
        JSON.stringify({
          kind: run.kind,
          status: run.status,
          processed: run.processed,
          errors: run.errors.length,
        }),
      );
      if (run.status === "failed") failed = true;
      else if (requests.includes("collect"))
        await store.completeRunRequest(userId, "collect");
    }
    if (preferences.autoApply || requests.includes("apply")) {
      const run = await runApplications(store, userId);
      console.log(
        JSON.stringify({
          kind: run.kind,
          status: run.status,
          processed: run.processed,
          errors: run.errors.length,
        }),
      );
      if (run.status === "failed") failed = true;
      else if (requests.includes("apply"))
        await store.completeRunRequest(userId, "apply");
    }
  }
  if (failed) process.exitCode = 1;
}
main().catch(() => {
  console.error("Worker failed; inspect sanitized job_runs in dashboard");
  process.exitCode = 1;
});
