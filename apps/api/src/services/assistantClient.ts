/**
 * The optional model behind the assistant — one OpenAI-compatible endpoint, nothing more.
 *
 * Defaults to OFF. When it is off, or unreachable, or the answer comes back malformed, the caller
 * falls back to `templateBrief` / no summary and every feature still works: the assistant is a layer,
 * never a dependency, and it is never in the path of sending a message.
 *
 * Pointed at an on-prem vLLM (`ASSISTANT_BASE_URL=http://<host>:8000/v1`), the data does not leave the
 * network. `ASSISTANT_REDACT_EMAILS` defaults to true when the base URL is not a private address, so a
 * cloud endpoint would receive no addresses.
 */

export type AssistantConfig = {
  enabled: boolean;
  baseUrl: string;
  model: string;
  apiKey: string | null;
  timeoutMs: number;
  maxTokens: number;
};

export function assistantConfig(env: NodeJS.ProcessEnv = process.env): AssistantConfig {
  const enabled = (env.ASSISTANT_ENABLED ?? "false").toLowerCase() === "true";
  return {
    enabled,
    baseUrl: (env.ASSISTANT_BASE_URL ?? "").replace(/\/+$/, ""),
    model: env.ASSISTANT_MODEL ?? "default",
    apiKey: env.ASSISTANT_API_KEY ?? null,
    timeoutMs: Number(env.ASSISTANT_TIMEOUT_MS ?? 25_000),
    maxTokens: Number(env.ASSISTANT_MAX_TOKENS ?? 320),
  };
}

export function assistantReady(cfg: AssistantConfig = assistantConfig()): boolean {
  return cfg.enabled && cfg.baseUrl.length > 0;
}

/** RFC 1918 / loopback / .local — the test that decides whether addresses may be sent. */
export function isPrivateHost(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return false;
  }
  if (host === "localhost" || host.endsWith(".local")) return true;
  if (/^127\./.test(host) || host === "::1") return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  const match = /^172\.(\d+)\./.exec(host);
  if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true;
  return false;
}

export type AssistantResult =
  | { ok: true; text: string; model: string; promptTokens: number | null; completionTokens: number | null; latencyMs: number }
  | { ok: false; reason: "DISABLED" | "NO_ENDPOINT" | "TIMEOUT" | "HTTP_ERROR" | "BAD_RESPONSE"; detail?: string };

/**
 * One chat completion.
 *
 * `temperature: 0.2` because this is operations text, not creative writing; `max_tokens` is small
 * because the answer is a paragraph, not a report. A model that rambles is a model that invents.
 */
export async function chatComplete(
  prompt: { system: string; user: string },
  cfg: AssistantConfig = assistantConfig()
): Promise<AssistantResult> {
  if (!cfg.enabled) return { ok: false, reason: "DISABLED" };
  if (!cfg.baseUrl) return { ok: false, reason: "NO_ENDPOINT" };

  const started = Date.now();
  try {
    const response = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0.2,
        max_tokens: cfg.maxTokens,
        // Qwen3 and its siblings think before answering; on this screen that thinking IS the answer
        // unless it is switched off. Servers that do not know the field ignore it.
        chat_template_kwargs: { enable_thinking: false },
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
      }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return { ok: false, reason: "HTTP_ERROR", detail: `${response.status} ${body.slice(0, 200)}` };
    }
    const payload = (await response.json()) as {
      model?: string;
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const message = payload.choices?.[0]?.message as
      | { content?: string; reasoning_content?: string }
      | undefined;
    const text = message?.content?.trim();
    // `reasoning_content` is deliberately NOT used: it is the model's scratchpad, not an answer.
    if (!text) return { ok: false, reason: "BAD_RESPONSE" };
    return {
      ok: true,
      text,
      model: payload.model ?? cfg.model,
      promptTokens: payload.usage?.prompt_tokens ?? null,
      completionTokens: payload.usage?.completion_tokens ?? null,
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: /abort|timeout/i.test(message) ? "TIMEOUT" : "HTTP_ERROR", detail: message };
  }
}

/** What the endpoint says it serves — used by the Admin panel to prove the wiring without a prompt. */
export async function listModels(cfg: AssistantConfig = assistantConfig()): Promise<{ ok: boolean; models: string[]; detail?: string }> {
  if (!cfg.baseUrl) return { ok: false, models: [], detail: "ASSISTANT_BASE_URL is not set" };
  try {
    const response = await fetch(`${cfg.baseUrl}/models`, {
      headers: cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {},
      signal: AbortSignal.timeout(Math.min(cfg.timeoutMs, 8_000)),
    });
    if (!response.ok) return { ok: false, models: [], detail: `HTTP ${response.status}` };
    const payload = (await response.json()) as { data?: Array<{ id?: string }> };
    return { ok: true, models: (payload.data ?? []).map((model) => model.id ?? "").filter(Boolean) };
  } catch (error) {
    return { ok: false, models: [], detail: error instanceof Error ? error.message : String(error) };
  }
}
