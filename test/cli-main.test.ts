import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type CliIo, EXIT_FAILURE, EXIT_OK, EXIT_USAGE, main } from "../src/cli/main.js";
import { CvparseError, type CvparseErrorCode } from "../src/errors.js";
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

/** Mirrors what the real parseResume accepts; binary input is decoded as UTF-8 for the fake. */
const fakeParse: typeof parseResume = async (input, options) => {
  let text: string;
  let filename: string | undefined;
  if (typeof input === "string") {
    text = input;
  } else if (input instanceof Uint8Array) {
    text = new TextDecoder().decode(input);
  } else {
    text = new TextDecoder().decode(input.data);
    filename = input.filename;
  }
  const isPdf = filename?.toLowerCase().endsWith(".pdf") ?? false;
  return {
    resume: {
      basics: { name: text.split("\n")[0] ?? null },
      x_cvparse: { detectedLanguage: options.language === "auto" ? "es" : options.language },
    },
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    warnings: ['work[0].endDate: could not normalize date "hace poco"; set to null.'],
    source: isPdf
      ? { format: "pdf", pages: 2, layout: "multi-column" }
      : { format: "text", layout: "unknown" },
  };
};

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

  it("exits 2 for images with an OCR message and for legacy office formats", async () => {
    for (const file of ["scan.png", "scan.jpg", "scan.tiff"]) {
      const io = makeIo({ parse: fakeParse });
      expect(await main([file], {}, io), file).toBe(EXIT_USAGE);
      expect(io.err.join("")).toContain("need OCR");
    }
    for (const file of ["cv.doc", "cv.odt", "cv.rtf"]) {
      const io = makeIo({ parse: fakeParse });
      expect(await main([file], {}, io), file).toBe(EXIT_USAGE);
      expect(io.err.join("")).toContain("Save the CV as .docx or PDF");
    }
  });

  it("passes files to parseResume as bytes with the file name and reports the source", async () => {
    const file = tmpFile("cv.pdf", "María López\nBackend");
    const io = makeIo({ parse: fakeParse });
    expect(await main([file], {}, io)).toBe(EXIT_OK);
    expect(JSON.parse(io.out.join("")).basics.name).toBe("María López");
    expect(io.err.join("")).toContain("info: read pdf, 2 page(s), multi-column layout");
  });

  it("does not print an info line for plain text input", async () => {
    const file = tmpFile("cv.txt", "Ana Pérez\nDesarrolladora");
    const io = makeIo({ parse: fakeParse });
    expect(await main([file], {}, io)).toBe(EXIT_OK);
    expect(io.err.join("")).not.toContain("info: read");
  });

  it("maps input-related CvparseError codes to exit 2 and the rest to exit 1", async () => {
    const codes: Array<[CvparseErrorCode, number]> = [
      ["UNSUPPORTED_INPUT", EXIT_USAGE],
      ["NO_TEXT_LAYER", EXIT_USAGE],
      ["INVALID_INPUT", EXIT_USAGE],
      ["EXTRACTION_FAILED", EXIT_FAILURE],
      ["PROVIDER_ERROR", EXIT_FAILURE],
    ];
    for (const [code, exit] of codes) {
      const file = tmpFile("cv.txt", "Ana Pérez");
      const throwing: typeof parseResume = async () => {
        throw new CvparseError(code, `boom ${code}`);
      };
      const io = makeIo({ parse: throwing });
      expect(await main([file], {}, io), code).toBe(exit);
      expect(io.err.join("")).toContain(`error [${code}]: boom ${code}`);
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
