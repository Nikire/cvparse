/**
 * Evaluation CLI.
 *
 *   tsx eval/run/index.ts --system cvparse --provider ollama --model llama3.1 [--ocr tesseract|vision]
 *   tsx eval/run/index.ts --system open-resume
 *
 * See `--help` for every option.
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { cpus, platform, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  CLI_PROVIDERS,
  type CliProvider,
  DEFAULT_BASE_URLS,
  DEFAULT_MODELS,
} from "../../src/cli/args.js";
import type { EvalSystem } from "../types.js";
import { createCvparseSystem, type EvalOcr } from "./cvparse-system.js";
import { EVAL_DIR, formatSummary, REPO_DIR, readJson, runEval } from "./runner.js";

export const USAGE = `Usage: npm run eval -- --system <cvparse|open-resume|resume-parser|...> [options]

System:
  --system <name>        cvparse, or a baseline module at eval/baselines/<name>.ts (default: cvparse)
  --name <text>          display name (also used for the result/cache file slug)
  --hardware <text>      hardware note shown in the report (default: CPU, RAM and OS)
  --gpu <text>           GPU description appended to the hardware note

cvparse only:
  --provider <p>         ollama | openai | openai-compatible (default: ollama)
  --model <id>           model id (default: llama3.1 for ollama, gpt-4o-mini for openai)
  --base-url <url>       API base URL (default per provider)
  --api-key <key>        API key (falls back to CVPARSE_API_KEY, or OPENAI_API_KEY for openai)
  --ocr <engine>         tesseract | vision (without it, image CVs count as failures)

Selection and execution:
  --limit <n>            only the first n dataset entries (subset runs go to results/partial/)
  --only <id,id>         only these entry ids (subset runs go to results/partial/)
  --concurrency <n>      CVs processed in parallel (default: 1)
  --no-cache             ignore and do not write eval/.cache/predictions
  --dataset <dir>        dataset directory (default: eval/dataset)
  --results <dir>        results directory (default: eval/results)
  --cache-dir <dir>      prediction cache directory (default: eval/.cache/predictions)
  -h, --help             show this help`;

export interface EvalCliOptions {
  system: string;
  name: string | undefined;
  hardware: string;
  provider: CliProvider;
  model: string;
  baseUrl: string | undefined;
  apiKey: string | undefined;
  ocr: EvalOcr | undefined;
  limit: number | undefined;
  only: string[] | undefined;
  concurrency: number;
  cache: boolean;
  datasetDir: string;
  resultsDir: string;
  cacheDir: string;
}

/** Quotes an argument for display in a POSIX-ish shell command line. */
function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `"${arg.replace(/(["\\$`])/g, "\\$1")}"`;
}

/** The exact command line of this run (`--api-key` redacted), recorded as details.command. */
export function formatCommand(argv: readonly string[]): string {
  const args = argv.map((arg, i) => {
    if (argv[i - 1] === "--api-key") return "<redacted>";
    if (arg.startsWith("--api-key=")) return "--api-key=<redacted>";
    return shellQuote(arg);
  });
  return ["npm run eval --", ...args].join(" ");
}

function positiveInt(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} must be a positive integer.`);
  return n;
}

export function defaultHardware(): string {
  const cpu = cpus()[0]?.model.trim() ?? "unknown CPU";
  const ram = Math.round(totalmem() / 1024 ** 3);
  return `${cpu}, ${ram} GB RAM, ${platform()}`;
}

/** Parses CLI arguments. Returns `null` for `--help`. */
export function parseEvalArgs(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
): EvalCliOptions | null {
  const { values } = parseArgs({
    args: [...argv],
    allowPositionals: false,
    options: {
      system: { type: "string", default: "cvparse" },
      name: { type: "string" },
      hardware: { type: "string" },
      gpu: { type: "string" },
      provider: { type: "string", default: "ollama" },
      model: { type: "string" },
      "base-url": { type: "string" },
      "api-key": { type: "string" },
      ocr: { type: "string" },
      limit: { type: "string" },
      only: { type: "string" },
      concurrency: { type: "string", default: "1" },
      "no-cache": { type: "boolean", default: false },
      dataset: { type: "string" },
      results: { type: "string" },
      "cache-dir": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) return null;

  const provider = values.provider as CliProvider;
  if (!CLI_PROVIDERS.includes(provider)) {
    throw new Error(`--provider must be one of: ${CLI_PROVIDERS.join(", ")}.`);
  }
  const model = values.model ?? DEFAULT_MODELS[provider];
  if (values.system === "cvparse" && !model) {
    throw new Error(`--model is required for provider "${provider}".`);
  }
  if (values.ocr !== undefined && values.ocr !== "tesseract" && values.ocr !== "vision") {
    throw new Error("--ocr must be tesseract or vision.");
  }
  const apiKey =
    values["api-key"] ??
    env.CVPARSE_API_KEY ??
    (provider === "openai" ? env.OPENAI_API_KEY : undefined);
  const only = values.only
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    system: values.system ?? "cvparse",
    name: values.name,
    hardware: [values.hardware ?? defaultHardware(), values.gpu && `GPU: ${values.gpu}`]
      .filter(Boolean)
      .join("; "),
    provider,
    model: model ?? "",
    baseUrl: values["base-url"],
    apiKey,
    ocr: values.ocr as EvalOcr | undefined,
    limit: positiveInt(values.limit, "--limit"),
    only: only && only.length > 0 ? only : undefined,
    concurrency: positiveInt(values.concurrency, "--concurrency") ?? 1,
    cache: !values["no-cache"],
    datasetDir: resolve(values.dataset ?? join(EVAL_DIR, "dataset")),
    resultsDir: resolve(values.results ?? join(EVAL_DIR, "results")),
    cacheDir: resolve(values["cache-dir"] ?? join(EVAL_DIR, ".cache", "predictions")),
  };
}

/** Loads `eval/baselines/<name>.ts` and calls its `createSystem()`. */
export async function loadBaseline(name: string, baselinesDir = join(EVAL_DIR, "baselines")) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`Invalid system name: ${name}`);
  const path = join(baselinesDir, `${name}.ts`);
  if (!existsSync(path)) {
    throw new Error(
      `Unknown system "${name}": expected cvparse or a baseline module at ${path} exporting createSystem(): Promise<EvalSystem>.`,
    );
  }
  const mod = (await import(pathToFileURL(path).href)) as {
    createSystem?: () => Promise<EvalSystem>;
  };
  if (typeof mod.createSystem !== "function") {
    throw new Error(`${path} does not export createSystem(): Promise<EvalSystem>.`);
  }
  return mod.createSystem();
}

/** Ollama server root from an OpenAI-compatible base URL ("http://localhost:11434/v1" → without /v1). */
export function ollamaRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/(v1|api)$/, "");
}

type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  json(): Promise<unknown>;
}>;

/**
 * Ollama server version and the model's digest (GET /api/version, /api/tags). Values are
 * "unknown" when the server does not answer within 3 s.
 */
export async function ollamaDetails(
  baseUrl: string,
  model: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<{ ollamaVersion: string; modelDigest: string }> {
  const root = ollamaRoot(baseUrl);
  const get = async (path: string): Promise<unknown> => {
    try {
      const res = await fetchImpl(`${root}${path}`, { signal: AbortSignal.timeout(3000) });
      return res.ok ? await res.json() : undefined;
    } catch {
      return undefined;
    }
  };
  const version = (await get("/api/version")) as { version?: string } | undefined;
  const tags = (await get("/api/tags")) as
    | { models?: { name?: string; model?: string; digest?: string }[] }
    | undefined;
  const wanted = model.includes(":") ? model : `${model}:latest`;
  const entry = tags?.models?.find((m) => m.name === wanted || m.model === wanted);
  return {
    ollamaVersion: version?.version ?? "unknown",
    modelDigest: entry?.digest ? `sha256:${entry.digest.slice(0, 12)}` : "unknown",
  };
}

/** Installed version of an npm package, or "unknown". */
export function installedVersion(name: string): string {
  try {
    const req = createRequire(join(REPO_DIR, "package.json"));
    const pkg = req.resolve(`${name}/package.json`);
    return (JSON.parse(readFileSync(pkg, "utf8")) as { version: string }).version;
  } catch {
    return "unknown";
  }
}

/**
 * Run-time details recorded in SystemInfo.details: exact command, Node version, hardware and,
 * for cvparse, Ollama version + model digest and the tesseract.js version.
 */
export async function runtimeDetails(
  options: EvalCliOptions,
  argv: readonly string[],
  fetchImpl?: FetchLike,
): Promise<Record<string, string>> {
  const details: Record<string, string> = {
    command: formatCommand(argv),
    node: process.version,
    hardware: options.hardware,
  };
  if (options.system === "cvparse") {
    if (options.provider === "ollama") {
      const baseUrl = options.baseUrl ?? DEFAULT_BASE_URLS.ollama ?? "http://localhost:11434";
      Object.assign(details, await ollamaDetails(baseUrl, options.model, fetchImpl));
    }
    if (options.ocr === "tesseract") details["tesseract.js"] = installedVersion("tesseract.js");
  }
  return details;
}

export async function packageVersion(): Promise<string> {
  return (await readJson<{ version: string }>(join(REPO_DIR, "package.json"))).version;
}

export async function main(argv: readonly string[]): Promise<number> {
  let options: EvalCliOptions | null;
  try {
    options = parseEvalArgs(argv);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}\n`);
    return 2;
  }
  if (!options) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const system =
    options.system === "cvparse"
      ? createCvparseSystem({
          provider: options.provider,
          model: options.model,
          baseUrl: options.baseUrl,
          apiKey: options.apiKey,
          ocr: options.ocr,
          name: options.name,
          hardware: options.hardware,
        })
      : await loadBaseline(options.system);
  if (options.system !== "cvparse" && options.name) system.info.name = options.name;
  Object.assign(system.info.details, await runtimeDetails(options, argv));

  try {
    const { result, path } = await runEval(system, {
      datasetDir: options.datasetDir,
      resultsDir: options.resultsDir,
      cacheDir: options.cacheDir,
      cache: options.cache,
      limit: options.limit,
      only: options.only,
      concurrency: options.concurrency,
      cvparseVersion: await packageVersion(),
    });
    process.stdout.write(`${formatSummary(result)}\n\nwrote ${path}\n`);
    return 0;
  } finally {
    await system.dispose?.();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
