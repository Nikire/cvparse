import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import type { RunOptions } from "./args.js";

/**
 * Creates the AI SDK model for the CLI. All presets go through `@ai-sdk/openai-compatible`,
 * which covers Ollama (`/v1`), OpenAI and any OpenAI-compatible endpoint (LM Studio, vLLM,
 * llama.cpp server, OpenRouter, ...).
 */
export function createCliModel(
  options: Pick<RunOptions, "provider" | "model" | "baseUrl" | "apiKey">,
): LanguageModel {
  const provider = createOpenAICompatible({
    name: options.provider,
    baseURL: options.baseUrl,
    // Ollama ignores the key but some OpenAI-compatible servers reject requests without one.
    apiKey: options.apiKey ?? (options.provider === "ollama" ? "ollama" : undefined),
    // Without this the provider downgrades to bare `json_object` mode and the model never sees
    // the resume schema. Ollama (>= 0.5), OpenAI, LM Studio and vLLM all accept `json_schema`.
    supportsStructuredOutputs: true,
  });
  return provider.chatModel(options.model);
}
