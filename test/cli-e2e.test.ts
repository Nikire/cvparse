import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CliIo, EXIT_FAILURE, EXIT_OK, main } from "../src/cli/main.js";
import { fixture, SPANISH_EXTRACTION } from "./helpers.js";

/**
 * A minimal OpenAI-compatible `/chat/completions` server. Exercises the real
 * `@ai-sdk/openai-compatible` wiring used by the CLI without any network access.
 */
type ResponseFormat = {
  type: string;
  json_schema: {
    name: string;
    strict: boolean;
    schema: { required?: string[]; additionalProperties?: boolean };
  };
};

let server: Server;
let baseUrl: string;
const requests: Array<{
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : undefined;
      requests.push({ url: req.url ?? "", headers: req.headers, body });
      if (req.url?.includes("/boom/")) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "model exploded" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion",
          created: 1,
          model: body?.model ?? "fake",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: JSON.stringify(SPANISH_EXTRACTION) },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  baseUrl = `http://127.0.0.1:${address.port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

function makeIo() {
  const io = {
    out: [] as string[],
    err: [] as string[],
    stdout: (t: string) => {
      io.out.push(t);
    },
    stderr: (t: string) => {
      io.err.push(t);
    },
    readStdin: async () => "",
  } satisfies CliIo & { out: string[]; err: string[] };
  return io;
}

describe("cli end-to-end against a fake OpenAI-compatible server", () => {
  it("parses a Spanish CV through --provider openai-compatible", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cvparse-e2e-"));
    const file = join(dir, "cv.txt");
    writeFileSync(file, fixture("cv-es-backend.txt"), "utf8");

    const io = makeIo();
    const code = await main(
      [
        file,
        "--provider",
        "openai-compatible",
        "--base-url",
        baseUrl,
        "--model",
        "fake-model",
        "--api-key",
        "test-key",
        "--lang",
        "es",
      ],
      {},
      io,
    );

    expect(io.err.join("")).toBe("");
    expect(code).toBe(EXIT_OK);
    const resume = JSON.parse(io.out.join(""));
    expect(resume.basics.name).toBe("María Fernanda López García");
    expect(resume.work[0].startDate).toBe("2021-03");
    expect(resume.work[0].endDate).toBeNull();
    expect(resume.x_cvparse.detectedLanguage).toBe("es");
    expect(resume.x_cvparse.location.countryCode).toBe("AR");

    const request = requests.at(-1);
    if (!request) throw new Error("no request captured");
    expect(request.url).toBe("/v1/chat/completions");
    expect(request.headers.authorization).toBe("Bearer test-key");
    const body = request.body as {
      model: string;
      messages: Array<{ role: string; content: string }>;
      response_format: ResponseFormat;
    };
    expect(body.model).toBe("fake-model");
    // The schema must travel on the wire as strict json_schema, or the model never sees it.
    const format = body.response_format;
    expect(format.type).toBe("json_schema");
    expect(format.json_schema.name).toBe("resume");
    expect(format.json_schema.strict).toBe(true);
    expect(format.json_schema.schema.required).toContain("basics");
    expect(format.json_schema.schema.additionalProperties).toBe(false);
    expect(body.messages[0]?.role).toBe("system");
    expect(body.messages[0]?.content).toContain("cvparse");
    expect(JSON.stringify(body.messages.at(-1))).toContain("MARÍA FERNANDA LÓPEZ GARCÍA");
  });

  it("uses the Ollama preset with an overridden base URL", async () => {
    const io = makeIo();
    const code = await main(
      ["-", "--base-url", baseUrl],
      {},
      { ...io, readStdin: async () => fixture("cv-es-ventas.txt") },
    );
    expect(code).toBe(EXIT_OK);
    const body = requests.at(-1)?.body as { model: string };
    expect(body.model).toBe("llama3.1");
  });

  it("fails fast without retries when the provider is unreachable", async () => {
    // Grab a port nobody listens on: bind, read the port, release it.
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const address = probe.address();
    if (!address || typeof address === "string") throw new Error("no address");
    await new Promise<void>((resolve, reject) =>
      probe.close((err) => (err ? reject(err) : resolve())),
    );

    const io = makeIo();
    const started = Date.now();
    const code = await main(
      ["-", "--base-url", `http://127.0.0.1:${address.port}/v1`],
      {},
      { ...io, readStdin: async () => "Ana Pérez" },
    );
    const elapsed = Date.now() - started;
    expect(code).toBe(EXIT_FAILURE);
    expect(io.err.join("")).toContain("error [PROVIDER_ERROR]");
    // With the SDK default of 2 retries this takes ~7s (2s + 4s backoff) and reports "after 3 attempts".
    expect(io.err.join("")).not.toContain("attempts");
    expect(elapsed).toBeLessThan(3000);
  });

  it("exits 1 with a PROVIDER_ERROR when the server fails", async () => {
    const io = makeIo();
    const code = await main(
      ["-", "--provider", "openai-compatible", "--base-url", `${baseUrl}/boom`, "--model", "x"],
      {},
      { ...io, readStdin: async () => "Ana Pérez" },
    );
    expect(code).toBe(EXIT_FAILURE);
    expect(io.out).toEqual([]);
    expect(io.err.join("")).toContain("error [PROVIDER_ERROR]");
    expect(io.err.join("")).toContain("HTTP 400");
  });
});
