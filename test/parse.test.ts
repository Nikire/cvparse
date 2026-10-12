import { APICallError, RetryError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { buildSystemPrompt, CvparseError, parseResume, ResumeSchema } from "../src/index.js";
import {
  DEFAULT_INPUT_BUDGET_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  estimateTokens,
  fitInputToBudget,
  LOOP_RETRY_FREQUENCY_PENALTY,
  splitInputSections,
} from "../src/parse.js";
import {
  fixture,
  mockModelThatThrows,
  mockModelWithObject,
  mockModelWithText,
  REAL_LOOP,
  SPANISH_EXTRACTION,
} from "./helpers.js";

function systemPromptOf(model: ReturnType<typeof mockModelWithObject>): string {
  const call = model.doGenerateCalls[0];
  expect(call).toBeDefined();
  const system = call?.prompt.find((m) => m.role === "system");
  expect(system).toBeDefined();
  return String(system?.content);
}

function userPromptOf(model: ReturnType<typeof mockModelWithObject>): string {
  const call = model.doGenerateCalls[0];
  const user = call?.prompt.find((m) => m.role === "user");
  expect(user).toBeDefined();
  return JSON.stringify(user?.content);
}

describe("parseResume", () => {
  it("extracts a Spanish CV into a validated JSON Resume object", async () => {
    const model = mockModelWithObject(SPANISH_EXTRACTION);
    const result = await parseResume(fixture("cv-es-backend.txt"), { model });

    expect(ResumeSchema.safeParse(result.resume).success).toBe(true);
    expect(result.resume.basics?.name).toBe("María Fernanda López García");
    expect(result.resume.work?.[0]?.startDate).toBe("2021-03");
    expect(result.resume.work?.[0]?.endDate).toBeNull();
    expect(result.resume.education?.[0]?.studyType).toBe("Ingeniería");
    expect(result.resume.x_cvparse?.detectedLanguage).toBe("es");
    expect(result.resume.x_cvparse?.normalizedSkills).toContain("typescript");
    expect(result.usage).toEqual({ inputTokens: 1200, outputTokens: 600, totalTokens: 1800 });
    expect(result.warnings).toEqual([]);
  });

  it("sends the CV text and the extraction rules to the model", async () => {
    const model = mockModelWithObject({});
    const cv = fixture("cv-es-ventas.txt");
    await parseResume(cv, { model });

    const system = systemPromptOf(model);
    expect(system).toContain("Never guess");
    expect(system).toContain("actualidad");
    expect(system).toContain("Licenciatura");
    expect(system).toContain('appears to be written in "es"');

    const user = userPromptOf(model);
    expect(user).toContain("Carlos Andrés Ramírez Mejía");
    expect(user).toContain("<cv>");

    const call = model.doGenerateCalls[0];
    expect(call?.responseFormat?.type).toBe("json");
  });

  it("forces the language when language is not auto", async () => {
    const model = mockModelWithObject({ x_cvparse: { detectedLanguage: "es" } });
    const result = await parseResume(fixture("cv-en-designer.txt"), { model, language: "en" });
    expect(systemPromptOf(model)).toContain("The CV is written in English");
    expect(result.resume.x_cvparse?.detectedLanguage).toBe("en");
  });

  it("does not emit the heuristic language warning when the language is forced", async () => {
    // The heuristic would say "en" for this fixture, which would contradict the forced "es".
    const model = mockModelWithObject({});
    const result = await parseResume(fixture("cv-en-designer.txt"), { model, language: "es" });
    expect(result.resume.x_cvparse?.detectedLanguage).toBe("es");
    expect(result.warnings.some((w) => w.includes("heuristically"))).toBe(false);
  });

  it("emits the heuristic language warning in auto mode when the model omits the language", async () => {
    const model = mockModelWithObject({});
    const result = await parseResume(fixture("cv-en-designer.txt"), { model });
    expect(result.resume.x_cvparse?.detectedLanguage).toBe("en");
    expect(result.warnings.some((w) => w.includes("heuristically"))).toBe(true);
  });

  it("appends caller instructions to the system prompt", async () => {
    const model = mockModelWithObject({});
    await parseResume("Ana Pérez\nDesarrolladora", {
      model,
      instructions: "Map 'Tecnicatura' to studyType 'Tecnicatura Superior'.",
    });
    expect(systemPromptOf(model)).toContain("Additional instructions from the caller");
    expect(systemPromptOf(model)).toContain("Tecnicatura Superior");
  });

  it("surfaces the model's confidence notes and provider warnings as warnings", async () => {
    const model = mockModelWithText(
      JSON.stringify({ x_cvparse: { detectedLanguage: "en", confidenceNotes: ["Phone unclear"] } }),
      [{ type: "unsupported", feature: "temperature", details: "ignored by provider" }],
    );
    const result = await parseResume("Jordan Avery\nProduct Designer", { model });
    expect(result.warnings).toContain("model: Phone unclear");
    expect(result.warnings.some((w) => w.includes("temperature"))).toBe(true);
  });

  it("normalizes CRLF input and truncates very long input with a warning", async () => {
    const model = mockModelWithObject({});
    const long = `Nombre: Ana\r\n${"x".repeat(250_000)}`;
    const result = await parseResume(long, { model });
    expect(result.warnings[0]).toMatch(/only the first 200000/);
    expect(userPromptOf(model)).not.toContain("\\r");
  });

  it("rejects empty or non-string input", async () => {
    const model = mockModelWithObject({});
    await expect(parseResume("   \n", { model })).rejects.toMatchObject({
      name: "CvparseError",
      code: "INVALID_INPUT",
    });
    // @ts-expect-error runtime guard
    await expect(parseResume(undefined, { model })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it("rejects a missing model", async () => {
    // @ts-expect-error runtime guard
    await expect(parseResume("Ana", {})).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("wraps unparseable model output as NO_OBJECT_GENERATED", async () => {
    const model = mockModelWithText("Sorry, I cannot do that.");
    const error = await parseResume("Ana Pérez", { model }).catch((e: unknown) => e);
    expect(CvparseError.is(error)).toBe(true);
    if (CvparseError.is(error)) {
      expect(error.code).toBe("NO_OBJECT_GENERATED");
      expect(error.rawText).toContain("Sorry");
      expect(error.cause).toBeDefined();
    }
  });

  it("wraps schema-violating model output as NO_OBJECT_GENERATED", async () => {
    const model = mockModelWithObject({ work: "not a list" });
    await expect(parseResume("Ana Pérez", { model })).rejects.toMatchObject({
      code: "NO_OBJECT_GENERATED",
    });
  });

  it("wraps provider API errors as PROVIDER_ERROR with the status code", async () => {
    const model = mockModelThatThrows(
      new APICallError({
        message: "Unauthorized",
        url: "https://api.openai.com/v1/chat/completions",
        requestBodyValues: {},
        statusCode: 401,
        isRetryable: false,
      }),
    );
    const error = await parseResume("Ana Pérez", { model }).catch((e: unknown) => e);
    expect(CvparseError.is(error)).toBe(true);
    if (CvparseError.is(error)) {
      expect(error.code).toBe("PROVIDER_ERROR");
      expect(error.statusCode).toBe(401);
      expect(error.message).toContain("HTTP 401");
    }
  });

  it("unwraps RetryError to the last underlying provider error", async () => {
    const last = new APICallError({
      message: "Cannot connect to API: connect ECONNREFUSED 127.0.0.1:11434",
      url: "http://127.0.0.1:11434/v1/chat/completions",
      requestBodyValues: {},
      isRetryable: true,
    });
    const model = mockModelThatThrows(
      new RetryError({
        message: "Failed after 3 attempts. Last error: Cannot connect to API",
        reason: "maxRetriesExceeded",
        errors: [last, last, last],
      }),
    );
    const error = await parseResume("Ana Pérez", { model }).catch((e: unknown) => e);
    expect(CvparseError.is(error)).toBe(true);
    if (CvparseError.is(error)) {
      expect(error.code).toBe("PROVIDER_ERROR");
      expect(error.message).toContain("ECONNREFUSED");
      expect(error.message).toContain("after 3 attempts");
      expect(RetryError.isInstance(error.cause)).toBe(true);
    }
  });

  it("wraps unknown errors as PROVIDER_ERROR", async () => {
    const model = mockModelThatThrows(new Error("ECONNREFUSED 127.0.0.1:11434"));
    await expect(parseResume("Ana Pérez", { model })).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      message: expect.stringContaining("ECONNREFUSED"),
    });
  });

  it("forwards the abort signal", async () => {
    const model = mockModelWithObject({});
    const controller = new AbortController();
    await parseResume("Ana Pérez", { model, abortSignal: controller.signal });
    expect(model.doGenerateCalls[0]?.abortSignal).toBe(controller.signal);
  });

  it("forwards temperature only when given", async () => {
    const model = mockModelWithObject({});
    await parseResume("Ana Pérez", { model, temperature: 0 });
    expect(model.doGenerateCalls[0]?.temperature).toBe(0);
    const untouched = mockModelWithObject({});
    await parseResume("Ana Pérez", { model: untouched });
    expect(untouched.doGenerateCalls[0]?.temperature).toBeUndefined();
  });

  it("tells the model the reference date so it can resolve relative dates", async () => {
    const model = mockModelWithObject({});
    await parseResume("Ana Pérez", { model, referenceDate: new Date("2026-10-01T12:00:00Z") });
    expect(systemPromptOf(model)).toContain("2026-10-01");
  });

  it("caps the output tokens by default and forwards a custom maxOutputTokens", async () => {
    const model = mockModelWithObject({});
    await parseResume("Ana Pérez", { model });
    expect(model.doGenerateCalls[0]?.maxOutputTokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    expect(DEFAULT_MAX_OUTPUT_TOKENS).toBe(8192);
    const custom = mockModelWithObject({});
    await parseResume("Ana Pérez", { model: custom, maxOutputTokens: 2000 });
    expect(custom.doGenerateCalls[0]?.maxOutputTokens).toBe(2000);
  });

  type MockStep = { text: string; finish: "stop" | "length" } | { error: unknown };

  /** A model that answers each call with the next step (the last one repeats). */
  function modelWithSteps(...steps: MockStep[]) {
    let call = 0;
    return new MockLanguageModelV4({
      doGenerate: async () => {
        const step = steps[Math.min(call++, steps.length - 1)] as MockStep;
        if ("error" in step) throw step.error;
        return {
          content: [{ type: "text", text: step.text }],
          finishReason: { unified: step.finish, raw: step.finish },
          usage: {
            inputTokens: {
              total: 1200,
              noCache: 1200,
              cacheRead: undefined,
              cacheWrite: undefined,
            },
            outputTokens: { total: 2000, text: 2000, reasoning: undefined },
          },
          warnings: [],
        };
      },
    });
  }
  const cutByLength = (text: string): MockStep => ({ text, finish: "length" });
  const completed = (object: unknown): MockStep => ({
    text: JSON.stringify(object),
    finish: "stop",
  });

  it("reports a length-cut extraction that is not a loop as NO_OBJECT_GENERATED, without retrying", async () => {
    const entries = Array.from(
      { length: 60 },
      (_, i) => `{"name":"Company ${i}","position":"Role ${i}","highlights":["Built thing ${i}"]}`,
    );
    const model = modelWithSteps(
      cutByLength(`{"basics":{"name":"Ana"},"work":[${entries.join(",")}`),
    );
    const error = await parseResume("Ana Pérez", { model, maxOutputTokens: 2000 }).catch(
      (e: unknown) => e,
    );
    expect(CvparseError.is(error)).toBe(true);
    const cvError = error as CvparseError;
    expect(cvError.code).toBe("NO_OBJECT_GENERATED");
    expect(cvError.message).toContain("hit the output limit (maxOutputTokens=2000)");
    expect(cvError.message).toContain("the CV may be too long or the model looped");
    expect(cvError.rawText).toContain('"name":"Company 0"');
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it("rejects a length-cut extraction even when the truncated text happens to parse", async () => {
    const error = await parseResume("Ana Pérez", {
      model: modelWithSteps(cutByLength(JSON.stringify({ basics: { name: "Ana" } }))),
    }).catch((e: unknown) => e);
    expect((error as CvparseError).code).toBe("NO_OBJECT_GENERATED");
    expect((error as CvparseError).message).toContain(
      `maxOutputTokens=${DEFAULT_MAX_OUTPUT_TOKENS}`,
    );
  });

  it("retries a repetition loop once with a frequency penalty", async () => {
    const model = modelWithSteps(cutByLength(REAL_LOOP), completed(SPANISH_EXTRACTION));
    const result = await parseResume(fixture("cv-es-backend.txt"), { model, temperature: 0 });
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(model.doGenerateCalls[0]?.frequencyPenalty).toBeUndefined();
    expect(model.doGenerateCalls[1]?.frequencyPenalty).toBe(LOOP_RETRY_FREQUENCY_PENALTY);
    expect(model.doGenerateCalls[1]?.temperature).toBe(0);
    expect(result.resume.basics?.name).toBe(SPANISH_EXTRACTION.basics.name);
    expect(result.usage.outputTokens).toBe(4000);
    expect(result.warnings.some((w) => w.includes("retried with frequencyPenalty 0.3"))).toBe(true);
  });

  it("salvages the looping output when the retry loops too", async () => {
    const model = modelWithSteps(cutByLength(REAL_LOOP));
    const result = await parseResume("Gabriela Quispe Ccori", { model, grounding: false });
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(result.resume.basics?.email).toBe("gabriela.quispe@example.org");
    expect(result.resume.work?.map((w) => w.name)).toEqual([
      "Estudio Creativo del Rímac E.I.R.L.",
      "Banco Digital del Rímac S.A.",
      "Agencia Digital del Pacífico S.A.C.",
      "Universidad Peruana de Ciencias del Pacífico",
    ]);
    expect(result.warnings).toContain(
      "model: the output was cut by a repetition loop; repeated entries were removed and later sections may be missing",
    );
  });

  it("salvages the first output when the retry fails in another way", async () => {
    const failure = new APICallError({
      message: "boom",
      url: "http://localhost",
      requestBodyValues: {},
      statusCode: 500,
      isRetryable: false,
    });
    const model = modelWithSteps(cutByLength(REAL_LOOP), { error: failure });
    const result = await parseResume("Gabriela", { model, grounding: false, maxRetries: 0 });
    expect(result.resume.work).toHaveLength(4);
  });

  it("throws the output-limit error when a loop leaves nothing to salvage", async () => {
    const looping = `{"basics": {"name": "${"la la ".repeat(400)}`;
    const model = modelWithSteps(cutByLength(looping));
    const error = await parseResume("Ana", { model }).catch((e: unknown) => e);
    expect((error as CvparseError).code).toBe("NO_OBJECT_GENERATED");
    expect((error as CvparseError).message).toContain("hit the output limit");
    expect(model.doGenerateCalls).toHaveLength(2);
  });

  describe("input budget", () => {
    const numbered = (prefix: string, n: number) =>
      Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join("\n");
    /** An academic CV: the low-value sections are bigger than the rest. */
    const academicCv = (publications = 20, talks = 10) =>
      [
        "Ana Pérez Gómez",
        "ana.perez@example.com · +34 600 000 000",
        "",
        "EXPERIENCIA PROFESIONAL",
        "Investigadora, Universidad de Salamanca, 2015 - actualidad",
        numbered("Tarea de investigación", 4),
        "",
        "FORMACIÓN ACADÉMICA",
        "Doctorado en Física, Universidad de Salamanca, 2010 - 2015",
        "",
        "4. PUBLICACIONES",
        numbered("Artículo en revista indexada número", publications),
        "",
        "CONGRESOS",
        numbered("Ponencia presentada en el congreso internacional", talks),
        "",
        "REFERENCIAS",
        "Dr. Juan López, catedrático",
      ].join("\n");
    const userPromptOfCall = (model: ReturnType<typeof modelWithSteps>, index: number) =>
      JSON.stringify(model.doGenerateCalls[index]?.prompt.find((m) => m.role === "user")?.content);

    it("splits the document into sections and marks the low-value ones", () => {
      const sections = splitInputSections(academicCv().split("\n"));
      expect(sections.map((s) => [s.heading, s.lowValue])).toEqual([
        ["EXPERIENCIA PROFESIONAL", false],
        ["FORMACIÓN ACADÉMICA", false],
        ["4. PUBLICACIONES", true],
        ["CONGRESOS", true],
        ["REFERENCIAS", true],
      ]);
      // A bullet that starts with a low-value word is running text, not a heading.
      expect(splitInputSections(["EXPERIENCIA", "- Comunicaciones con clientes"])).toHaveLength(1);
      expect(splitInputSections(["Proyectos de investigación", "x"])[0]?.lowValue).toBe(true);
      expect(splitInputSections(["Proyectos", "x"])[0]?.lowValue).toBe(false);
    });

    it("drops low-value sections (largest first) before cutting the tail", () => {
      const text = academicCv();
      const total = estimateTokens(text);
      expect(total).toBeGreaterThan(400);
      // Roomy budget: untouched.
      expect(fitInputToBudget(text, total)).toMatchObject({
        text,
        droppedSections: [],
        tailCut: false,
      });
      // Dropping Publicaciones alone is not enough; Congresos goes too, Referencias stays.
      const fit = fitInputToBudget(text, 200);
      expect(fit.droppedSections).toEqual(["4. PUBLICACIONES", "CONGRESOS"]);
      expect(fit.tailCut).toBe(false);
      expect(fit.text).toContain("ana.perez@example.com");
      expect(fit.text).toContain("Doctorado en Física");
      expect(fit.text).toContain("Dr. Juan López");
      expect(fit.text).not.toContain("Artículo en revista");
      expect(fit.text).not.toContain("Ponencia presentada");
      expect(estimateTokens(fit.text)).toBeLessThanOrEqual(200);
      // When the biggest section alone makes it fit, the others are kept.
      const roomy = fitInputToBudget(text, total - 100);
      expect(roomy.droppedSections).toEqual(["4. PUBLICACIONES"]);
      expect(roomy.text).toContain("Ponencia presentada");
    });

    it("cuts the tail at a line break only when no low-value section is left", () => {
      const text = `Ana Pérez\nEXPERIENCIA\n${numbered("Desarrolladora en la empresa", 60)}`;
      const fit = fitInputToBudget(text, 100);
      expect(fit.droppedSections).toEqual([]);
      expect(fit.tailCut).toBe(true);
      expect(fit.text.startsWith("Ana Pérez\nEXPERIENCIA\n")).toBe(true);
      expect(fit.text).not.toContain("empresa 60");
      expect(fit.text.endsWith("\n")).toBe(false);
      expect(estimateTokens(fit.text)).toBeLessThanOrEqual(100);
      // Everything dropped and still over: the tail of what is left is cut too.
      const both = fitInputToBudget(academicCv(), 60);
      expect(both.droppedSections).toEqual(["4. PUBLICACIONES", "CONGRESOS", "REFERENCIAS"]);
      expect(both.tailCut).toBe(true);
    });

    it("sends the cut text to the model with an input: warning", async () => {
      const model = mockModelWithObject({});
      const result = await parseResume(academicCv(), { model, inputBudgetTokens: 200 });
      const prompt = userPromptOf(model);
      expect(prompt).toContain("FORMACIÓN ACADÉMICA");
      expect(prompt).not.toContain("Artículo en revista");
      const total = estimateTokens(academicCv());
      expect(result.warnings).toContain(
        `input: the document exceeds the input budget (${total} tokens est., budget 200); dropped sections: 4. PUBLICACIONES, CONGRESOS`,
      );
      const tail = mockModelWithObject({});
      const long = `Ana Pérez\nEXPERIENCIA\n${numbered("Desarrolladora en la empresa", 60)}`;
      const cut = await parseResume(long, { model: tail, inputBudgetTokens: 100 });
      expect(cut.warnings[0]).toMatch(
        /^input: the document exceeds the input budget .*; the tail was cut$/,
      );
      expect(userPromptOf(tail)).not.toContain("empresa 60");
    });

    it("defaults to 24k tokens, or derives the budget from the context length", async () => {
      expect(DEFAULT_INPUT_BUDGET_TOKENS).toBe(24_000);
      const text = academicCv(400, 10);
      expect(estimateTokens(text)).toBeGreaterThan(5000);
      const untouched = mockModelWithObject({});
      const result = await parseResume(text, { model: untouched });
      expect(result.warnings.some((w) => w.startsWith("input:"))).toBe(false);
      // 8192 - 2048 - 2000 = 4144 tokens of CV text.
      const derived = mockModelWithObject({});
      const cut = await parseResume(text, {
        model: derived,
        contextLengthTokens: 8192,
        maxOutputTokens: 2048,
      });
      expect(cut.warnings[0]).toContain("budget 4144");
      expect(cut.warnings[0]).toContain("dropped sections: 4. PUBLICACIONES");
      expect(userPromptOf(derived)).not.toContain("Artículo en revista");
    });

    /** A budget the whole text fits in with 5% to spare: sent in full, and "at the budget". */
    const justOver = (text: string) => Math.ceil(estimateTokens(text) / 0.95);
    /** A budget where dropping Publicaciones alone makes the text fit, with 5 tokens to spare. */
    const budgetWithoutPublications = (text: string) => {
      const withoutPubs = fitInputToBudget(text, estimateTokens(text) - 100);
      expect(withoutPubs.droppedSections).toEqual(["4. PUBLICACIONES"]);
      return estimateTokens(withoutPubs.text) + 5;
    };

    it("retries an output-limit cut with less input (no penalty) when the input sent was at the budget", async () => {
      const text = academicCv();
      const budget = budgetWithoutPublications(text);
      const notALoop = Array.from(
        { length: 60 },
        (_, i) =>
          `{"name":"Company ${i}","position":"Role ${i}","highlights":["Built thing ${i}"]}`,
      );
      const model = modelWithSteps(
        cutByLength(`{"basics":{"name":"Ana"},"work":[${notALoop.join(",")}`),
        completed({ basics: { name: "Ana Pérez Gómez" } }),
      );
      const result = await parseResume(text, { model, inputBudgetTokens: budget });
      expect(model.doGenerateCalls).toHaveLength(2);
      expect(model.doGenerateCalls[1]?.frequencyPenalty).toBeUndefined();
      expect(model.doGenerateCalls[1]?.maxOutputTokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
      const first = userPromptOfCall(model, 0);
      const second = userPromptOfCall(model, 1);
      expect(first).toContain("Ponencia presentada");
      expect(first).not.toContain("Artículo en revista");
      expect(second.length).toBeLessThan(first.length);
      expect(second).toContain("ana.perez@example.com");
      expect(second).not.toContain("Ponencia presentada");
      expect(result.resume.basics?.name).toBe("Ana Pérez Gómez");
      // Usage covers both calls.
      expect(result.usage).toEqual({ inputTokens: 2400, outputTokens: 4000, totalTokens: 6400 });
      const retry = result.warnings.find((w) => w.includes("retried with the input cut to 60%"));
      expect(retry).toMatch(
        new RegExp(
          `^input: the first extraction hit the output limit with the input at the budget \\(\\d+ tokens est\\., budget ${budget}\\); retried with the input cut to 60% of the budget \\(\\d+ tokens est\\.\\); dropped sections: 4\\. PUBLICACIONES, CONGRESOS`,
        ),
      );
      // Both the first cut's warning and the retry's are kept.
      expect(result.warnings.filter((w) => w.startsWith("input:"))).toHaveLength(2);
    });

    it("treats an input within 10% of the budget as at the budget, even for a loop", async () => {
      const text = academicCv();
      const model = modelWithSteps(cutByLength(REAL_LOOP), completed({ basics: { name: "Ana" } }));
      const result = await parseResume(text, {
        model,
        inputBudgetTokens: justOver(text),
        grounding: false,
      });
      expect(model.doGenerateCalls).toHaveLength(2);
      expect(model.doGenerateCalls[1]?.frequencyPenalty).toBeUndefined();
      expect(userPromptOfCall(model, 0)).toContain("Artículo en revista");
      expect(userPromptOfCall(model, 1)).not.toContain("Artículo en revista");
      expect(result.warnings.filter((w) => w.startsWith("input:"))).toHaveLength(1);
      expect(result.warnings.some((w) => w.includes("frequencyPenalty"))).toBe(false);
    });

    it("uses the penalty retry when the section cut left the input well under the budget", async () => {
      // Budget 200: Publicaciones and Congresos go, the ~120 tokens left are far from the budget,
      // so a loop is the model's and not the window's.
      const model = modelWithSteps(cutByLength(REAL_LOOP), completed({ basics: { name: "Ana" } }));
      await parseResume(academicCv(), { model, inputBudgetTokens: 200, grounding: false });
      expect(model.doGenerateCalls).toHaveLength(2);
      expect(model.doGenerateCalls[1]?.frequencyPenalty).toBe(LOOP_RETRY_FREQUENCY_PENALTY);
      expect(userPromptOfCall(model, 1)).toBe(userPromptOfCall(model, 0));
    });

    it("keeps the frequency-penalty retry for loops when the input is well under the budget", async () => {
      const model = modelWithSteps(cutByLength(REAL_LOOP), completed(SPANISH_EXTRACTION));
      const result = await parseResume(fixture("cv-es-backend.txt"), {
        model,
        inputBudgetTokens: 5000,
      });
      expect(model.doGenerateCalls).toHaveLength(2);
      expect(model.doGenerateCalls[1]?.frequencyPenalty).toBe(LOOP_RETRY_FREQUENCY_PENALTY);
      expect(userPromptOfCall(model, 1)).toBe(userPromptOfCall(model, 0));
      expect(result.warnings.some((w) => w.startsWith("input:"))).toBe(false);
    });

    it("caps the retry's output to what is left of a known context window", async () => {
      const text = academicCv(60, 10);
      const model = modelWithSteps(cutByLength(REAL_LOOP), completed({ basics: { name: "Ana" } }));
      const result = await parseResume(text, {
        model,
        inputBudgetTokens: justOver(text),
        contextLengthTokens: 4000,
        grounding: false,
      });
      const retryMax = model.doGenerateCalls[1]?.maxOutputTokens ?? 0;
      expect(model.doGenerateCalls[0]?.maxOutputTokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
      expect(retryMax).toBeGreaterThanOrEqual(512);
      expect(retryMax).toBeLessThan(DEFAULT_MAX_OUTPUT_TOKENS);
      // 4000 minus the instructions (~1.7k) and ~600 tokens of CV leaves well under 2k.
      expect(retryMax).toBeLessThan(2000);
      expect(result.warnings.some((w) => w.includes(`maxOutputTokens ${retryMax}`))).toBe(true);
    });

    it("salvages the retry's output, then the first one, when both are cut", async () => {
      const text = academicCv();
      const model = modelWithSteps(cutByLength(REAL_LOOP));
      const result = await parseResume(text, {
        model,
        inputBudgetTokens: justOver(text),
        grounding: false,
      });
      expect(model.doGenerateCalls).toHaveLength(2);
      expect(model.doGenerateCalls[1]?.frequencyPenalty).toBeUndefined();
      expect(result.resume.work).toHaveLength(4);
      expect(result.warnings.some((w) => w.includes("retried with the input cut to 60%"))).toBe(
        true,
      );
      expect(result.warnings).toContain(
        "model: the output was cut by a repetition loop; repeated entries were removed and later sections may be missing",
      );
    });
  });
});

describe("buildSystemPrompt — no concrete example values to copy (review of real CVs)", () => {
  it("describes formats abstractly and marks the remaining examples as illustrative", () => {
    const prompt = buildSystemPrompt({ language: "auto", detectedLanguage: "es" });
    for (const leaked of [
      "Ciudad Autónoma de Buenos Aires",
      "Ciudad de México",
      "Antioquia",
      "+54 for Argentina",
      "+52",
      "Node.js",
      "PostgreSQL",
      "English (C1)",
      "Two email addresses found",
    ]) {
      expect(prompt, leaked).not.toContain(leaked);
    }
    expect(prompt).toContain("illustrative only");
    expect(prompt).toContain("exactly as written");
    expect(prompt).toContain("Do not add a country code the CV does not write");
  });
});
