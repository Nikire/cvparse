/**
 * Regenerates the benchmark tables in README.md, README.es.md and eval/results/README.md from
 * eval/results/*.json (full-dataset runs only; eval/results/partial/ is ignored).
 *
 *   tsx eval/report/index.ts [--results <dir>]
 */

import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { generateReport } from "./report.js";

const EVAL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_DIR = resolve(EVAL_DIR, "..");

export async function main(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: { results: { type: "string" } },
  });
  const resultsDir = resolve(values.results ?? join(EVAL_DIR, "results"));
  await mkdir(resultsDir, { recursive: true });
  const written = await generateReport({
    resultsDir,
    datasetDir: join(EVAL_DIR, "dataset"),
    readmes: [
      { path: join(REPO_DIR, "README.md"), lang: "en" },
      { path: join(REPO_DIR, "README.es.md"), lang: "es" },
    ],
  });
  for (const path of written) process.stdout.write(`updated ${path}\n`);
  return 0;
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
