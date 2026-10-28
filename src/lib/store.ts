import { resolve } from "node:path";
import type { Store } from "../core/types";
import { createLocalStore } from "./local-store";
import { SupabaseStore } from "./supabase-store";
export { createLocalStore } from "./local-store";

let singleton: Store | undefined;
export function getStore(): Store {
  if (singleton) return singleton;
  const mode =
    process.env.KENSHO_MODE ??
    (process.env.NODE_ENV === "production" ? "supabase" : "demo");
  if (mode === "supabase") {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const encryptionKey = process.env.PROFILE_ENCRYPTION_KEY;
    if (!url || !serviceKey || !encryptionKey)
      throw new Error("Supabase configuration is required; see .env.example");
    singleton = new SupabaseStore(url, serviceKey, encryptionKey);
  } else if (mode === "demo") {
    singleton = createLocalStore(
      resolve(process.env.KENSHO_DB_PATH ?? ".data/kensho.sqlite"),
      process.env.PROFILE_ENCRYPTION_KEY,
    );
  } else throw new Error("KENSHO_MODE must be demo or supabase");
  return singleton;
}
