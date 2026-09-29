// Minimal Claude Messages API client with structured (tool) output.
import { HttpError } from "./http.ts";

export const SMART_MODEL = Deno.env.get("CLAUDE_MODEL") ?? "claude-sonnet-5-5";
export const FAST_MODEL = Deno.env.get("CLAUDE_FAST_MODEL") ?? "claude-haiku-4-5-20251001";

export type Block =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "document"; source: { type: "base64"; media_type: "application/pdf"; data: string } };

export interface Tool { name: string; description: string; input_schema: Record<string, unknown> }

export function claudeConfigured(): boolean {
  return !!Deno.env.get("ANTHROPIC_API_KEY");
}

/**
 * Ask Claude and force the answer into `tool`'s JSON schema.
 * Retries once on overload / rate limit.
 */
export async function askStructured<T>(opts: {
  model?: string; system: string; content: string | Block[]; tool: Tool; maxTokens?: number;
}): Promise<T> {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) throw new HttpError(503, "The AI features aren't set up yet (missing ANTHROPIC_API_KEY).");
  const body = {
    model: opts.model ?? SMART_MODEL,
    max_tokens: opts.maxTokens ?? 1500,
    system: opts.system,
    messages: [{ role: "user", content: opts.content }],
    tools: [opts.tool],
    tool_choice: { type: "tool", name: opts.tool.name },
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const out = await res.json();
      const block = (out.content ?? []).find((b: { type: string }) => b.type === "tool_use");
      if (!block) throw new Error("Claude returned no structured answer");
      return block.input as T;
    }
    const text = await res.text();
    if ((res.status === 429 || res.status === 529 || res.status >= 500) && attempt === 0) {
      await new Promise((r) => setTimeout(r, 2500));
      continue;
    }
    throw new Error(`Claude API ${res.status}: ${text.slice(0, 500)}`);
  }
  throw new Error("Claude API unavailable");
}
