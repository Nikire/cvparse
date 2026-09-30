import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type CliIo, EXIT_FAILURE, EXIT_OK, EXIT_USAGE, main } from "../src/cli/main.js";
import { CvparseError } from "../src/errors.js";
import type { parseResume } from "../src/parse.js";
import { CVPARSE_VERSION } from "../src/version.js";
import { fixture } from "./helpers.js";

interface Captured extends CliIo {
  out: string[];
  err: string[];
}

function makeIo(overrides: Partial<CliIo> = {}): Captured {
  const io: Captured = {
    out: [],
    err: [],
    stdout: (text) => {
      io.out.push(text);
    },
    stderr: (text) => {
      io.err.push(text);
    },
    readStdin: async () => "",
    ...overrides,
  };
  return io;
}

const fakeParse: typeof parseResume = async (text, options) => ({
  resume: {
    basics: { name: text.split("\n")[0] ?? null },
    x_cvparse: { detectedLanguage: options.language === "auto" ? "es" : options.language },
  },
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  warnings: ['work[0].endDate: could not normalize date "hace poco"; set to null.'],
});

function tmpFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cvparse-test-"));
  const file = join(dir, name);
  writeFileSync(file, content, "utf8");
  return file;
}

describe("cli main", () => {
  it("prints help to stderr and exits 0", async () => {
    const io = makeIo();
    expect(await main(["--help"], {}, io)).toBe(EXIT_OK);
    expect(io.out).toEqual([]);
    expect(io.err.join("")).toMatch(/^Usage: cvparse/);
  });

  it("prints the version to stdout", async () => {
    const io = makeIo();
    expect(await main(["--version"], {}, io)).toBe(EXIT_OK);
    expect(io.out).toEqual([`${CVPARSE_VERSION}\n`]);
  });

  it("exits 2 with usage on bad arguments", async () => {
    const io = makeIo();
    expect(await main(["--provider", "nope"], {}, io)).toBe(EXIT_USAGE);
    expect(io.err.join("")).toContain("error: Missing <file>");
    expect(io.err.join("")).toContain("Usage: cvparse");
  });

  it("exits 2 for PDF/DOCX/images with a roadmap message", async () => {
    for (const file of ["cv.pdf", "cv.docx", "scan.png", "scan.jpg"]) {
      const io = makeIo({ parse: fakeParse });
      expect(await main([file], {}, io), file).toBe(EXIT_USAGE);
      expect(io.err.join("")).toContain("not supported yet in cvparse 0.0.1");
      expect(io.err.join("")).toContain("coming in 0.1");
    }
  });

  it("exits 2 when the file does not exist", async () => {
    const io = makeIo({ parse: fakeParse });
    expect(await main(["./definitely-missing.txt"], {}, io)).toBe(EXIT_USAGE);
    expect(io.err.join("")).toContain("File not found");
  });

  it("exits 2 when the input file is empty or whitespace only", async () => {
    for (const content of ["", "   \n\t\n"]) {
      const file = tmpFile("cv.txt", content);
      const io = makeIo({ parse: fakeParse });
      expect(await main([file], {}, io), JSON.stringify(content)).toBe(EXIT_USAGE);
      expect(io.out).toEqual([]);
      expect(io.err.join("")).toContain("error: Input is empty");
      expect(io.err.join("")).toContain(file);
    }
  });

  it("exits 2 when stdin is empty", async () => {
    const io = makeIo({ parse: fakeParse, readStdin: async () => "  \n" });
    expect(await main(["-"], {}, io)).toBe(EXIT_USAGE);
    expect(io.err.join("")).toContain("error: Input is empty: stdin");
  });

  it("disables retries so an unreachable provider fails fast", async () => {
    const file = tmpFile("cv.txt", "Ana Pérez");
    let seen: Parameters<typeof parseResume>[1] | undefined;
    const io = makeIo({
      parse: async (text, options) => {
        seen = options;
        return fakeParse(text, options);
      },
    });
    expect(await main([file], {}, io)).toBe(EXIT_OK);
    expect(seen?.maxRetries).toBe(0);
  });

  it("reads a text file, prints compact JSON to stdout and warnings to stderr", async () => {
    const file = tmpFile("cv.txt", fixture("cv-es-ventas.txt"));
    const io = makeIo({ parse: fakeParse });
    expect(await main([file], {}, io)).toBe(EXIT_OK);
    expect(io.out).toHaveLength(1);
    const json = JSON.parse(io.out[0] ?? "");
    expect(json.basics.name).toBe("Carlos Andrés Ramírez Mejía");
    expect(io.out[0]).not.toContain("\n  ");
    expect(io.err.join("")).toContain("warning: work[0].endDate");
  });

  it("pretty-prints with --pretty and passes --lang through", async () => {
    const file = tmpFile("cv.md", fixture("cv-en-designer.txt"));
    const io = makeIo({ parse: fakeParse });
    expect(await main([file, "--pretty", "--lang", "en"], {}, io)).toBe(EXIT_OK);
    expect(io.out[0]).toContain("\n  ");
    expect(JSON.parse(io.out[0] ?? "").x_cvparse.detectedLanguage).toBe("en");
  });

  it("reads from stdin with '-'", async () => {
    const io = makeIo({ parse: fakeParse, readStdin: async () => "Ana Pérez\nDesarrolladora" });
    expect(await main(["-"], {}, io)).toBe(EXIT_OK);
    expect(JSON.parse(io.out[0] ?? "").basics.name).toBe("Ana Pérez");
  });

  it("exits 1 on extraction errors and hints when the provider is down", async () => {
    const file = tmpFile("cv.txt", "Ana Pérez");
    const io = makeIo({
      parse: async () => {
        throw new CvparseError("PROVIDER_ERROR", "Extraction failed: fetch failed ECONNREFUSED");
      },
    });
    expect(await main([file], {}, io)).toBe(EXIT_FAILURE);
    expect(io.out).toEqual([]);
    expect(io.err.join("")).toContain("error [PROVIDER_ERROR]");
    expect(io.err.join("")).toContain("ollama serve");
  });

  it("exits 1 on unexpected errors", async () => {
    const file = tmpFile("cv.txt", "Ana Pérez");
    const io = makeIo({
      parse: async () => {
        throw new Error("boom");
      },
    });
    expect(await main([file], {}, io)).toBe(EXIT_FAILURE);
    expect(io.err.join("")).toContain("boom");
  });
});
