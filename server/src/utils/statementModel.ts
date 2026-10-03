/**
 * Which model writes a collective statement, and the local (Ollama) call.
 *
 * LLM_PROVIDER=ollama sends the statement prompt to OLLAMA_HOST/OLLAMA_MODEL,
 * the same switch and settings Delphi uses for topic names and the narrative
 * report. Any other value keeps the hosted Anthropic model, unchanged.
 */

export const HOSTED_STATEMENT_MODEL = "claude-opus-4-8";

export type StatementProvider = "anthropic" | "ollama";

export interface StatementModel {
  provider: StatementProvider;
  model: string;
}

export interface OllamaSettings {
  host: string | null;
  model: string;
  numCtx: number;
  timeoutSeconds: number;
}

export function resolveStatementModel(
  llmProvider: string | null | undefined,
  ollamaModel: string
): StatementModel {
  if ((llmProvider || "anthropic").trim().toLowerCase() === "ollama") {
    return { provider: "ollama", model: ollamaModel };
  }
  return { provider: "anthropic", model: HOSTED_STATEMENT_MODEL };
}

/** Accepts OLLAMA_HOST forms such as "ollama:11434" or "http://x:11434/". */
export function ollamaBaseUrl(host: string | null | undefined): string {
  let base = (host || "http://localhost:11434").trim().replace(/\/+$/, "");
  if (!base.includes("://")) {
    base = `http://${base}`;
  }
  return base;
}

/**
 * One non-streaming chat call to Ollama, asking for JSON output. Returns the
 * message text; throws on a timeout, an HTTP error or an empty reply, so the
 * route answers with its usual error instead of storing a broken statement.
 */
export async function ollamaChat(
  settings: OllamaSettings,
  system: string,
  user: string,
  maxTokens: number,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const url = `${ollamaBaseUrl(settings.host)}/api/chat`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: settings.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        stream: false,
        format: "json",
        options: { num_predict: maxTokens, num_ctx: settings.numCtx },
      }),
      signal: AbortSignal.timeout(settings.timeoutSeconds * 1000),
    });
  } catch (err: any) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      throw new Error(
        `Ollama request timed out after ${settings.timeoutSeconds}s`
      );
    }
    throw new Error(`Ollama request failed: ${err?.message || err}`);
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 200);
    throw new Error(`Ollama returned HTTP ${response.status}: ${detail}`);
  }
  let payload: any;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Ollama response has no message content");
  }
  const content = payload?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("Ollama returned an empty message");
  }
  return content.trim();
}
