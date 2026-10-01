import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { CvparseError } from "../errors.js";
import { detectFormat, extractText } from "../extract/index.js";
import { parseResume } from "../parse.js";
import type { ResumeInput } from "../types.js";
import { CVPARSE_VERSION } from "../version.js";
import {
  CliUsageError,
  type ExtractOptions,
  parseCliArgs,
  type RunOptions,
  USAGE,
  unsupportedExtension,
  unsupportedExtensionMessage,
} from "./args.js";
import { createCliModel } from "./provider.js";

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

/** Minimal I/O surface so `main` can be tested without touching the real process streams. */
export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Raw stdin. Bytes are format-detected like a file; a string is taken as CV text. */
  readStdin: () => Promise<string | Uint8Array>;
  /** Overridable for tests; defaults to `parseResume`. */
  parse?: typeof parseResume;
}

async function readProcessStdin(): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
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

/** Empty string, empty bytes, or text bytes that are only whitespace. */
function isEmptyInput(input: string | Uint8Array, filename?: string): boolean {
  if (typeof input === "string") return input.trim() === "";
  if (input.length === 0) return true;
  return detectFormat(input, filename) === "text" && new TextDecoder().decode(input).trim() === "";
}

async function readInput(file: string, io: CliIo): Promise<ResumeInput> {
  if (file === "-") {
    const stdin = await io.readStdin();
    if (isEmptyInput(stdin)) throw new CliUsageError("Input is empty: stdin contains no data.");
    return typeof stdin === "string" ? stdin : { data: stdin, filename: undefined };
  }

  const ext = unsupportedExtension(file);
  if (ext) throw new CliUsageError(unsupportedExtensionMessage(ext));

  let data: Uint8Array;
  try {
    data = await readFile(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new CliUsageError(`File not found: ${file}`);
    if (code === "EISDIR") throw new CliUsageError(`Expected a file, got a directory: ${file}`);
    throw new CliUsageError(`Could not read ${file}: ${(error as Error).message}`);
  }
  if (isEmptyInput(data, file))
    throw new CliUsageError(`Input is empty: ${file} contains no data.`);
  // Format is detected from the bytes; the name only breaks ties (e.g. a ZIP named .docx).
  return { data, filename: basename(file) };
}

async function run(options: RunOptions, io: CliIo): Promise<number> {
  const input = await readInput(options.file, io);
  const model = createCliModel(options);
  const parse = io.parse ?? parseResume;
  // No retries in the CLI: a missing local Ollama should fail immediately instead of after ~7s.
  const result = await parse(input, { model, language: options.language, maxRetries: 0 });

  if (result.source.format !== "text") {
    const pages = result.source.pages === undefined ? "" : `, ${result.source.pages} page(s)`;
    io.stderr(`info: read ${result.source.format}${pages}, ${result.source.layout} layout\n`);
  }
  for (const warning of result.warnings) {
    io.stderr(`warning: ${warning}\n`);
  }
  const json = options.pretty
    ? JSON.stringify(result.resume, null, 2)
    : JSON.stringify(result.resume);
  io.stdout(`${json}\n`);
  return EXIT_OK;
}

/** `--extract-only`: print the reading-order text the model would receive, without any model. */
async function extract(options: ExtractOptions, io: CliIo): Promise<number> {
  const input = await readInput(options.file, io);
  if (typeof input === "string") {
    io.stdout(input.endsWith("\n") ? input : `${input}\n`);
    return EXIT_OK;
  }
  const doc = await extractText(input);
  if (doc.format !== "text") {
    const pages = doc.pages === undefined ? "" : `, ${doc.pages} page(s)`;
    io.stderr(`info: read ${doc.format}${pages}, ${doc.layout} layout\n`);
  }
  for (const warning of doc.warnings) {
    io.stderr(`warning: extract: ${warning}\n`);
  }
  if (doc.text.trim() === "") {
    throw new CvparseError(
      "INVALID_INPUT",
      `No text could be extracted from the ${doc.format.toUpperCase()}.`,
    );
  }
  io.stdout(doc.text.endsWith("\n") ? doc.text : `${doc.text}\n`);
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
      case "extract":
        return await extract(command.options, io);
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
      // Problems with the input itself are usage errors, like a missing file or bad flag.
      if (
        error.code === "INVALID_INPUT" ||
        error.code === "UNSUPPORTED_INPUT" ||
        error.code === "NO_TEXT_LAYER"
      ) {
        return EXIT_USAGE;
      }
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
