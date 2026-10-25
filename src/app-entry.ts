import { createClient } from "@supabase/supabase-js";
import { browserStorage } from "./accounts/browser-storage";
import { DEMO_KEY, demoBankKey, localBackend } from "./accounts/local-backend";
import { supabaseAuth, supabaseBackend } from "./accounts/supabase-backend";

export * from "./ui-exports";
export { browserStorage, DEMO_KEY, demoBankKey };

// Set at build time from NITYA_SUPABASE_URL and NITYA_SUPABASE_KEY (see README).
declare const __SUPABASE_URL__: string;
declare const __SUPABASE_KEY__: string;

/** The real app: Nitya's Supabase project when the build has one, otherwise the demo. */
export function createBackend() {
  if (!__SUPABASE_URL__ || !__SUPABASE_KEY__) return localBackend(browserStorage());
  const client = createClient(__SUPABASE_URL__, __SUPABASE_KEY__);
  // Sign-in links and Google bring the parent back to this page.
  return supabaseBackend(client, supabaseAuth(client, location.origin + location.pathname));
}
