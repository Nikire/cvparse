import { parseArgs } from "node:util";
import type { ParseLanguage } from "../types.js";

/** Built-in provider presets available from the CLI. */
export type CliProvider = "ollama" | "openai" | "openai-compatible";

export const CLI_PROVIDERS: readonly CliProvider[] = ["ollama", "openai", "openai-compatible"];
export const CLI_LANGUAGES: readonly ParseLanguage[] = ["auto", "es", "en"];

/** Default model per provider when `--model` is omitted. */
export const DEFAULT_MODELS: Record<CliProvider, string | undefined> = {
  ollama: "llama3.1",
  openai: "gpt-4o-mini",
  "openai-compatible": undefined,
};

/** Default base URL per provider when `--base-url` is omitted. */
export const DEFAULT_BASE_URLS: Record<CliProvider, string | undefined> = {
  ollama: "http://localhost:11434/v1",
  openai: "https://api.openai.com/v1",
  "openai-compatible": undefined,
};

/** Options for a `run` command, fully resolved (defaults applied). */
export interface RunOptions {
  /** Path to the CV text file, or `-` for stdin. */
  file: string;
  provider: CliProvider;
  model: string;
  baseUrl: string;
  apiKey: string | undefined;
  language: ParseLanguage;
  pretty: boolean;
}

export type CliCommand =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "run"; options: RunOptions };

/** Thrown by {@link parseCliArgs} on invalid usage. The CLI prints the message and exits 2. */
export class CliUsageError extends Error {
  override readonly name = "CliUsageError";
}

export const USAGE = `Usage: cvparse <file> [options]

Turn a CV/resume text file into JSON Resume-compatible JSON using an LLM.

Arguments:
  <file>                    Path to the CV as plain text (.txt, .md, ...). Use "-" for stdin.
                            PDF/DOCX/images are not supported yet in 0.0.1 (coming in 0.1).

Options:
  --provider <name>         ollama | openai | openai-compatible   (default: ollama)
  --model <id>              Model id (default: llama3.1 for ollama, gpt-4o-mini for openai)
  --base-url <url>          API base URL (default: http://localhost:11434/v1 for ollama,
                            https://api.openai.com/v1 for openai; required for openai-compatible)
  --api-key <key>           API key sent as a Bearer token. Falls back to env CVPARSE_API_KEY
                            (any provider) or OPENAI_API_KEY (openai only; required for openai).
                            The key is only sent to the configured --base-url (default
                            https://api.openai.com/v1 for openai); override it and the key goes there.
  --lang <auto|es|en>       Language of the CV (default: auto)
  --pretty                  Pretty-print the JSON output
  -h, --help                Show this help
  -v, --version             Print the cvparse version

Output:
  JSON to stdout. Warnings, errors and help go to stderr.

Exit codes:
  0  success
  1  extraction failed (provider error, invalid model output)
  2  usage error (bad arguments, missing file, unsupported file type)

Examples:
  npx cvparse ./cv.txt --pretty
  npx cvparse ./cv.txt --provider openai --model gpt-4o-mini --api-key sk-...
  npx cvparse ./cv.txt --provider openai-compatible --base-url http://localhost:1234/v1 --model qwen2.5
  cat cv.txt | npx cvparse - --lang es
`;

const ARG_OPTIONS = {
  provider: { type: "string" },
  model: { type: "string" },
  "base-url": { type: "string" },
  "api-key": { type: "string" },
  lang: { type: "string" },
  pretty: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
  version: { type: "boolean", short: "v", default: false },
} as const;

function safeParseArgs(argv: readonly string[]) {
  try {
    return parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: ARG_OPTIONS,
    });
  } catch (error) {
    throw new CliUsageError(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Parses CLI arguments (without the `node` and script entries) into a command.
 * Pure: reads `env` for defaults but never touches process state.
 */
export function parseCliArgs(
  argv: readonly string[],
  env: Record<string, string | undefined> = {},
): CliCommand {
  const { values, positionals } = safeParseArgs(argv);
  if (values.help) return { kind: "help" };
  if (values.version) return { kind: "version" };

  if (positionals.length === 0) {
    throw new CliUsageError("Missing <file> argument.");
  }
  if (positionals.length > 1) {
    throw new CliUsageError(`Expected a single <file> argument, got: ${positionals.join(", ")}`);
  }
  const file = positionals[0] as string;

  const providerRaw = values.provider ?? "ollama";
  if (!CLI_PROVIDERS.includes(providerRaw as CliProvider)) {
    throw new CliUsageError(
      `Unknown provider "${providerRaw}". Expected one of: ${CLI_PROVIDERS.join(", ")}.`,
    );
  }
  const provider = providerRaw as CliProvider;

  const langRaw = values.lang ?? "auto";
  if (!CLI_LANGUAGES.includes(langRaw as ParseLanguage)) {
    throw new CliUsageError(
      `Unknown language "${langRaw}". Expected one of: ${CLI_LANGUAGES.join(", ")}.`,
    );
  }
  const language = langRaw as ParseLanguage;

  const model = values.model ?? DEFAULT_MODELS[provider];
  if (!model) {
    throw new CliUsageError(`--model is required for provider "${provider}".`);
  }

  const baseUrl = values["base-url"] ?? DEFAULT_BASE_URLS[provider];
  if (!baseUrl) {
    throw new CliUsageError(`--base-url is required for provider "${provider}".`);
  }
  try {
    new URL(baseUrl);
  } catch {
    throw new CliUsageError(`--base-url "${baseUrl}" is not a valid URL.`);
  }

  // OPENAI_API_KEY is only picked up for --provider openai, so a developer with it exported does
  // not leak it to Ollama or an openai-compatible endpoint by accident. It is still sent to whatever
  // --base-url resolves to (api.openai.com by default), so overriding --base-url sends it there.
  const apiKey =
    values["api-key"] ??
    env.CVPARSE_API_KEY ??
    (provider === "openai" ? env.OPENAI_API_KEY : undefined) ??
    undefined;
  if (provider === "openai" && !apiKey) {
    throw new CliUsageError(
      'An API key is required for provider "openai": pass --api-key or set OPENAI_API_KEY.',
    );
  }

  return {
    kind: "run",
    options: {
      file,
      provider,
      model,
      baseUrl,
      apiKey,
      language,
      pretty: values.pretty ?? false,
    },
  };
}

/** Extensions that 0.0.1 cannot read (binary formats). */
export const UNSUPPORTED_EXTENSIONS = new Set([
  ".pdf",
  ".doc",
  ".docx",
  ".odt",
  ".rtf",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".tif",
  ".tiff",
  ".bmp",
  ".heic",
]);

/** Returns the lowercase extension of `file` if it is one 0.0.1 does not support, else `null`. */
export function unsupportedExtension(file: string): string | null {
  const match = /\.[a-z0-9]+$/i.exec(file);
  if (!match) return null;
  const ext = match[0].toLowerCase();
  return UNSUPPORTED_EXTENSIONS.has(ext) ? ext : null;
}
