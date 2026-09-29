// Shared plumbing for every Ticket Radar agent.
import { createClient, type SupabaseClient, type User } from "jsr:@supabase/supabase-js@2";

export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

let _admin: SupabaseClient | null = null;
/** Service-role client. Bypasses row security, so every query must filter by user itself. */
export function admin(): SupabaseClient {
  if (!_admin) {
    _admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return _admin;
}

/** The signed-in person calling this function, or a 401. */
export async function requireUser(req: Request): Promise<User> {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) throw new HttpError(401, "Sign in to use this feature.");
  const { data, error } = await admin().auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, "Your session expired. Sign in again.");
  return data.user;
}

/** True when the request came from our own scheduler or database trigger. */
export function isCron(req: Request): boolean {
  const secret = Deno.env.get("CRON_SECRET");
  return !!secret && req.headers.get("x-cron-secret") === secret;
}
export function requireCron(req: Request) {
  if (!isCron(req)) throw new HttpError(401, "Not allowed.");
}

/** Per-person daily cap on AI calls. */
export async function quota(userId: string, fn: string, limit: number) {
  const { data, error } = await admin().rpc("bump_ai_usage", { p_user: userId, p_fn: fn, p_limit: limit });
  if (error) throw error;
  if (!data) throw new HttpError(429, `You've reached today's limit of ${limit} for this feature. It resets at midnight.`);
}

export async function readJson<T = Record<string, unknown>>(req: Request): Promise<T> {
  try { return await req.json() as T; } catch { throw new HttpError(400, "Send the request body as JSON."); }
}

/** Wrap a handler with CORS, JSON output and friendly errors. */
export function serve(fn: (req: Request) => Promise<unknown>) {
  Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    if (req.method !== "POST") return json({ error: "Use POST." }, 405);
    try {
      return json(await fn(req));
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      console.error(e);
      return json({ error: status === 500 ? "Something went wrong on our side. Try again in a minute." : (e as Error).message }, status);
    }
  });
}
