import { describe, expect, it } from "vitest";
import {
  checkOllamaContext,
  type FetchLike,
  loadedOllamaContextLength,
  ollamaContextLength,
} from "../src/cli/ollama-context.js";

/** A fake Ollama server: `/api/ps` lists `loaded`; an empty `/api/generate` loads the model. */
function fakeOllama(options: { loaded?: string[]; contextLength?: number; down?: boolean } = {}) {
  const loaded = new Set(options.loaded ?? []);
  const requests: string[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    requests.push(`${init?.method ?? "GET"} ${url}`);
    if (options.down) throw new Error("ECONNREFUSED");
    if (url.endsWith("/api/generate")) {
      const body = JSON.parse(init?.body ?? "{}") as { model: string };
      loaded.add(body.model.includes(":") ? body.model : `${body.model}:latest`);
      return { ok: true, json: async () => ({ model: body.model, done: true }) };
    }
    if (url.endsWith("/api/ps")) {
      return {
        ok: true,
        json: async () => ({
          models: [...loaded].map((name) => ({
            name,
            model: name,
            context_length: options.contextLength ?? 16384,
          })),
        }),
      };
    }
    return { ok: false, json: async () => ({}) };
  };
  return { fetchImpl, requests };
}

describe("Ollama context length", () => {
  it("reads the loaded context length from /api/ps", async () => {
    const server = fakeOllama({ loaded: ["llama3.1:latest"], contextLength: 8192 });
    expect(
      await ollamaContextLength("http://localhost:11434/v1", "llama3.1", server.fetchImpl),
    ).toBe(8192);
    expect(server.requests).toEqual(["GET http://localhost:11434/api/ps"]);
    expect(
      await ollamaContextLength("http://localhost:11434/v1", "gemma3:4b", server.fetchImpl),
    ).toBe(null);
  });

  it("loads the model first when it is not loaded yet", async () => {
    const server = fakeOllama();
    expect(
      await loadedOllamaContextLength("http://localhost:11434/v1", "llama3.1", server.fetchImpl),
    ).toBe(16384);
    expect(server.requests).toEqual([
      "GET http://localhost:11434/api/ps",
      "POST http://localhost:11434/api/generate",
      "GET http://localhost:11434/api/ps",
    ]);
    // Already loaded: no generate call.
    const warm = fakeOllama({ loaded: ["llama3.1:latest"] });
    await loadedOllamaContextLength("http://localhost:11434/v1", "llama3.1", warm.fetchImpl);
    expect(warm.requests).toEqual(["GET http://localhost:11434/api/ps"]);
  });

  it("returns null when the server is down and never throws", async () => {
    const server = fakeOllama({ down: true });
    expect(
      await loadedOllamaContextLength("http://localhost:11434/v1", "llama3.1", server.fetchImpl),
    ).toBeNull();
    expect(
      await checkOllamaContext("http://localhost:11434", "llama3.1", 9000, server.fetchImpl),
    ).toBe(null);
  });

  it("flags a call that used 90% or more of the window", async () => {
    const server = fakeOllama({ loaded: ["llama3.1:latest"], contextLength: 4096 });
    expect(
      await checkOllamaContext("http://localhost:11434", "llama3.1", 3700, server.fetchImpl),
    ).toEqual({ contextLength: 4096, usedTokens: 3700 });
    expect(
      await checkOllamaContext("http://localhost:11434", "llama3.1", 1000, server.fetchImpl),
    ).toBe(null);
    expect(
      await checkOllamaContext("http://localhost:11434", "llama3.1", undefined, server.fetchImpl),
    ).toBe(null);
  });
});
