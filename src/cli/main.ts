import { readFile } from "node:fs/promises";
import { CvparseError } from "../errors.js";
import { parseResume } from "../parse.js";
import { CVPARSE_VERSION } from "../version.js";
import {
  CliUsageError,
  parseCliArgs,
  type RunOptions,
  USAGE,
  unsupportedExtension,
} from "./args.js";
import { createCliModel } from "./provider.js";

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

/** Minimal I/O surface so `main` can be tested without touching the real process streams. */
export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  readStdin: () => Promise<string>;
  /** Overridable for tests; defaults to `parseResume`. */
  parse?: typeof parseResume;
}

async function readProcessStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const defaultIo: CliIo = {
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
  readStdin: readProcessStdin,
};

async function readInput(file: string, io: CliIo): Promise<string> {
  if (file === "-") return io.readStdin();

  const ext = unsupportedExtension(file);
  if (ext) {
    throw new CliUsageError(
      `${ext} files are not supported yet in this cvparse version (coming in 0.1 — see the roadmap in README). ` +
        'Extract the text first and pass a .txt file, or pipe the text via stdin with "-".',
    );
  }
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new CliUsageError(`File not found: ${file}`);
    if (code === "EISDIR") throw new CliUsageError(`Expected a file, got a directory: ${file}`);
    throw new CliUsageError(`Could not read ${file}: ${(error as Error).message}`);
  }
}

async function run(options: RunOptions, io: CliIo): Promise<number> {
  const text = await readInput(options.file, io);
  if (text.trim() === "") {
    const source = options.file === "-" ? "stdin" : options.file;
    throw new CliUsageError(`Input is empty: ${source} contains no text.`);
  }
  const model = createCliModel(options);
  const parse = io.parse ?? parseResume;
  // No retries in the CLI: a missing local Ollama should fail immediately instead of after ~7s.
  const result = await parse(text, { model, language: options.language, maxRetries: 0 });

  for (const warning of result.warnings) {
    io.stderr(`warning: ${warning}\n`);
  }
  const json = options.pretty
    ? JSON.stringify(result.resume, null, 2)
    : JSON.stringify(result.resume);
  io.stdout(`${json}\n`);
  return EXIT_OK;
}

/** CLI entry point. Returns the exit code instead of calling `process.exit` so it is testable. */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
  io: CliIo = defaultIo,
): Promise<number> {
  try {
    const command = parseCliArgs(argv, env);
    switch (command.kind) {
      case "help":
        io.stderr(USAGE);
        return EXIT_OK;
      case "version":
        io.stdout(`${CVPARSE_VERSION}\n`);
        return EXIT_OK;
      case "run":
        return await run(command.options, io);
    }
  } catch (error) {
    if (error instanceof CliUsageError) {
      io.stderr(`error: ${error.message}\n\n${USAGE}`);
      return EXIT_USAGE;
    }
    if (error instanceof CvparseError) {
      io.stderr(`error [${error.code}]: ${error.message}\n`);
      if (
        error.code === "PROVIDER_ERROR" &&
        /ECONNREFUSED|fetch failed|Cannot connect/i.test(error.message)
      ) {
        io.stderr(
          "hint: is the provider running? For Ollama, start it with `ollama serve` and pull a model with `ollama pull llama3.1`.\n",
        );
      }
      return EXIT_FAILURE;
    }
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    io.stderr(`error: ${message}\n`);
    return EXIT_FAILURE;
  }
}
