/**
 * Ollama serves every model with a context window set on the server (4096 tokens by default in
 * many installs), whatever the model supports, and the OpenAI-compatible API cannot change it per
 * request. When the prompt plus the generated resume do not fit, Ollama silently drops the start
 * of the conversation (the instructions) while generating, and long CVs lose entries.
 *
 * After a call, the CLI asks the server for the loaded context length and warns when the call
 * used (almost) all of it.
 */

export interface ContextCheck {
  contextLength: number;
  usedTokens: number;
}

export type FetchLike = (
  url: string,
  init?: {
    signal?: AbortSignal;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  json(): Promise<unknown>;
}>;

/** `http://host:11434/v1` → `http://host:11434`. */
export function ollamaRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

/**
 * Context length of `model` as currently loaded in the Ollama server (`GET /api/ps`), or `null`
 * when the model is not loaded, the server does not answer or any error occurs.
 */
export async function ollamaContextLength(
  baseUrl: string,
  model: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<number | null> {
  try {
    const response = await fetchImpl(`${ollamaRoot(baseUrl)}/api/ps`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      models?: Array<{ name?: string; model?: string; context_length?: number }>;
    };
    const wanted = model.includes(":") ? model : `${model}:latest`;
    const loaded = body.models?.find((m) => m.name === wanted || m.model === wanted);
    const contextLength = loaded?.context_length;
    return typeof contextLength === "number" && contextLength > 0 ? contextLength : null;
  } catch {
    return null;
  }
}

/**
 * Loads `model` into the Ollama server (an empty `POST /api/generate` only loads it; the
 * extraction call would do the same load a moment later) and returns its context length, so the
 * CLI can size the input before the first call. `null` on any error.
 */
export async function loadedOllamaContextLength(
  baseUrl: string,
  model: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<number | null> {
  const known = await ollamaContextLength(baseUrl, model, fetchImpl);
  if (known !== null) return known;
  try {
    const response = await fetchImpl(`${ollamaRoot(baseUrl)}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) return null;
  } catch {
    return null;
  }
  return ollamaContextLength(baseUrl, model, fetchImpl);
}

/**
 * Returns the context check when the model is loaded and the call used ≥ 90% of its window;
 * `null` otherwise, and on any error (the check must never break the CLI).
 */
export async function checkOllamaContext(
  baseUrl: string,
  model: string,
  usedTokens: number | undefined,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<ContextCheck | null> {
  if (!usedTokens) return null;
  const contextLength = await ollamaContextLength(baseUrl, model, fetchImpl);
  if (contextLength === null) return null;
  return usedTokens >= contextLength * 0.9 ? { contextLength, usedTokens } : null;
}

export function contextWarning(check: ContextCheck): string {
  return (
    `warning: the model's context window (${check.contextLength} tokens) was nearly or fully used ` +
    `(${check.usedTokens} tokens in + out). Ollama drops the start of the conversation when it overflows, ` +
    "so long CVs can lose entries.\n" +
    "hint: raise it with OLLAMA_CONTEXT_LENGTH=16384 (environment of the Ollama server) and restart Ollama.\n"
  );
}
