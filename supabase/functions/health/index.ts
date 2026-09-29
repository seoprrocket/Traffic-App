// Setup check used by www/setup.html.
// Reports which secrets are set (yes/no only) and whether the Anthropic key works. Never returns secret values.
import { serve } from "../_shared/http.ts";

async function hash8(s: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 8);
}

serve(async () => {
  const has = (k: string) => !!Deno.env.get(k);
  const cron = Deno.env.get("CRON_SECRET");
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  let anthropic: string | null = null;
  if (key) {
    try {
      // Listing models is free and proves the key works
      const r = await fetch("https://api.anthropic.com/v1/models?limit=1", {
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      });
      anthropic = r.ok ? "ok" : r.status === 401 ? "invalid" : `error ${r.status}`;
    } catch {
      anthropic = "unreachable";
    }
  }
  // Which agents are deployed: an empty call to each one. None of them does anything without a signed-in
  // user or the scheduler's secret, so this only tells "found" (any answer) from "not deployed" (404).
  const base = Deno.env.get("SUPABASE_URL") ?? "";
  const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const FNS = ["scan-ticket", "voice-assist", "dispute-helper", "delete-account", "camera-sync", "moderate-report", "commute-predict", "weekly-coach"];
  const functions: Record<string, boolean | null> = {};
  await Promise.all(FNS.map(async (fn) => {
    try {
      const r = await fetch(`${base}/functions/v1/${fn}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${anon}`, apikey: anon },
        body: "{}",
      });
      await r.body?.cancel();
      functions[fn] = r.status !== 404;
    } catch {
      functions[fn] = null;
    }
  }));
  return {
    ok: true,
    functions,
    secrets: {
      ANTHROPIC_API_KEY: has("ANTHROPIC_API_KEY"),
      CRON_SECRET: has("CRON_SECRET"),
      CONTACT_EMAIL: has("CONTACT_EMAIL"),
      RESEND_API_KEY: has("RESEND_API_KEY"),
      RESEND_FROM: has("RESEND_FROM"),
    },
    cron_hash: cron ? await hash8(cron) : null,
    anthropic,
  };
});
