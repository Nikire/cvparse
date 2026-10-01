# cvparse

Turn CVs and resumes into typed, JSON Resume-compatible JSON using LLMs, with any provider the Vercel AI SDK supports, including local models via Ollama.

[![npm version](https://img.shields.io/npm/v/%40cvparse%2Fcore.svg)](https://www.npmjs.com/package/@cvparse/core)
[![CI](https://img.shields.io/github/actions/workflow/status/Nikire/cvparse/ci.yml?branch=main&label=CI)](https://github.com/Nikire/cvparse/actions)
[![License: MIT](https://img.shields.io/github/license/Nikire/cvparse.svg)](https://github.com/Nikire/cvparse/blob/main/LICENSE)
[![Node >= 22](https://img.shields.io/node/v/%40cvparse%2Fcore.svg)](https://nodejs.org)

> **Status: 0.x — early.**
> cvparse reads **PDF, DOCX and plain text**. PDFs are read in reading order, including two-column and sidebar layouts. Scanned PDFs and images need OCR, which lands as an adapter in 0.2. See the [roadmap](#roadmap). The schema and API may still change before 1.0.

[Versión en español](./README.es.md)

## Quick start

### CLI, locally with Ollama

Requires Node >= 22 and [Ollama](https://ollama.com) running on your machine.

```bash
ollama pull llama3.1
npx @cvparse/core ./cv.pdf --pretty
```

The npm package is `@cvparse/core`; the command it installs is `cvparse` (`npm i -g @cvparse/core`, then `cvparse ./cv.pdf`).

`cvparse` defaults to Ollama at `http://localhost:11434/v1`. Nothing leaves your machine.

The input can be a PDF, a DOCX or a plain-text file; the format is detected from the file contents, not the extension. For a PDF or DOCX the CLI prints one `info:` line to stderr saying what it read, e.g. `info: read pdf, 2 page(s), multi-column layout`.

Other providers:

```bash
# OpenAI (reads OPENAI_API_KEY from the environment if --api-key is omitted)
npx @cvparse/core ./cv.docx --provider openai --model gpt-4o-mini --pretty

# Any OpenAI-compatible endpoint (LM Studio, vLLM, Groq, OpenRouter, ...)
npx @cvparse/core ./cv.txt --provider openai-compatible --base-url http://localhost:1234/v1 --model my-model
```

All flags:

| Flag | Values | Notes |
| --- | --- | --- |
| `<file>` | path or `-` | Path to the CV: `.pdf`, `.docx` or plain text (`.txt`, `.md`, ...). The format is detected from the file contents. `-` reads from stdin, as text or bytes. Scanned PDFs and images need OCR, which is planned for 0.2 (exit 2) |
| `--provider` | `ollama` \| `openai` \| `openai-compatible` | Default: `ollama` |
| `--model <id>` | any model id the provider knows | Default: `llama3.1` (ollama), `gpt-4o-mini` (openai); required for `openai-compatible` |
| `--base-url <url>` | URL | Default: `http://localhost:11434/v1` (ollama), `https://api.openai.com/v1` (openai); required for `openai-compatible` |
| `--api-key <key>` | string | Sent as a Bearer token. Falls back to env `CVPARSE_API_KEY` (any provider) or `OPENAI_API_KEY` (only with `--provider openai`). The key is only sent to the configured base URL: `https://api.openai.com/v1` by default for `--provider openai`; if you override `--base-url`, the key is sent to that host instead |
| `--lang` | `es` \| `en` \| `auto` | Language hint for the CV. Default: `auto` |
| `--pretty` | flag | Indent the JSON output |
| `--extract-only` | flag | Print the reading-order text extracted from the document and exit, without calling any model. Use it to check how a two-column PDF was read, or to attach the text to a bug report. Needs no provider or key |
| `-h`, `--help` | flag | Print usage to stderr |
| `-v`, `--version` | flag | Print the cvparse version |

The CLI prints only the `resume` object as JSON to **stdout**; `warnings` go to **stderr** as `warning:` lines, together with help and errors. Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Extraction failed (provider error, invalid model output, corrupt document) |
| `2` | Usage error (bad arguments, missing file, unsupported or empty input, PDF without text layer) |

So it composes with pipes and scripts:

```bash
npx @cvparse/core ./cv.pdf | jq '.basics.name'
cat cv.pdf | npx @cvparse/core - --lang es
```

### Programmatic

```bash
npm install @cvparse/core @ai-sdk/openai-compatible
```

`parseResume` takes the CV, as a string or as the bytes of a PDF, DOCX or text file, plus any AI SDK language model. Use Ollama for a fully local setup:

```ts
import { readFile } from 'node:fs/promises';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { parseResume } from '@cvparse/core';

const ollama = createOpenAICompatible({
  name: 'ollama',
  baseURL: 'http://localhost:11434/v1',
  // Required: without it the provider sends `json_object` instead of the resume schema
  // and `warnings` contains a `responseFormat` warning. Ollama >= 0.5, OpenAI, LM Studio
  // and vLLM all support it.
  supportsStructuredOutputs: true,
});

// A Node Buffer is a Uint8Array, so the file bytes can be passed as-is.
// The format (PDF, DOCX, text) is detected from the bytes.
const buffer = await readFile('./cv.pdf');

const { resume, source, usage, warnings } = await parseResume(buffer, {
  model: ollama('llama3.1'),
  language: 'auto', // 'es' | 'en' | 'auto'
});

console.log(source); // { format: 'pdf', pages: 2, layout: 'multi-column' }
console.log(resume.basics?.name);
console.log(resume.work?.[0]?.position);
```

A string is taken as the CV text. To pass a file name as a tie-breaker for detection, or to skip detection, wrap the bytes: `parseResume({ data: buffer, filename: 'cv.docx' }, { model })` or `parseResume({ data, format: 'pdf' }, { model })`.

Or OpenAI, through the same provider package:

```ts
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { parseResume } from '@cvparse/core';

const openai = createOpenAICompatible({
  name: 'openai',
  baseURL: 'https://api.openai.com/v1',
  apiKey: process.env.OPENAI_API_KEY,
  supportsStructuredOutputs: true,
});

const { resume } = await parseResume(buffer, { model: openai('gpt-4o-mini') });
```

If you only want the text, `extractText` is the same extraction step without the model call. It is useful for inspecting what the model will see, or for feeding your own pipeline:

```ts
import { readFile } from 'node:fs/promises';
import { detectFormat, extractText } from '@cvparse/core';

const data = await readFile('./cv.pdf');
detectFormat(data); // 'pdf' | 'docx' | 'text' | 'image' | 'legacy-doc' | 'zip' | 'unknown'

const { text, format, pages, layout, warnings } = await extractText(data);
```

PDF and DOCX support is loaded on demand (pdf.js via `unpdf`, and `mammoth`), so passing a string never loads either.

Because `model` is a standard AI SDK `LanguageModel`, any AI SDK provider works: `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/amazon-bedrock`, `@ai-sdk/google`, and so on. Install the provider you want and pass its model instance. Always pass a model instance: the AI SDK also accepts a bare string (`model: "openai/gpt-4o-mini"`), but that is resolved through the Vercel AI Gateway (it needs `AI_GATEWAY_API_KEY`), not through your own provider. Whatever provider you use, if `warnings` contains a `responseFormat` warning the model did not receive the resume schema and the output will be unreliable; pick a model or provider setting with structured-output support.

The `options` object:

```ts
type ParseOptions = {
  model: LanguageModel;             // any AI SDK model instance
  language?: 'auto' | 'es' | 'en';  // hint for the source language, default 'auto'
  instructions?: string;            // extra instructions appended to the extraction prompt
  abortSignal?: AbortSignal;        // forwarded to the model call
  maxRetries?: number;              // retries on retryable provider errors, default 2 (AI SDK default)
  temperature?: number;             // sampling temperature; omit for the provider default, 0 suits copying tasks
  referenceDate?: Date;             // "today" for relative dates ("hace 3 años"); default new Date()
};
```

The result:

```ts
type ParseResult = {
  resume: Resume;      // typed, validated against ResumeSchema
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  warnings: string[];  // extraction warnings (prefixed `extract:`), provider warnings,
                       // dates that could not be normalized, model confidence notes
  source: {
    format: 'text' | 'pdf' | 'docx';                      // what the input was read as
    pages?: number;                                       // PDFs only
    layout: 'single-column' | 'multi-column' | 'unknown'; // PDFs only; 'unknown' otherwise
  };
};
```

### Errors

`parseResume` throws a `CvparseError` for every failure, with the original error as `cause`:

```ts
import { CvparseError, parseResume } from '@cvparse/core';

try {
  const { resume } = await parseResume(buffer, { model });
} catch (error) {
  if (CvparseError.is(error)) {
    console.error(error.code, error.message); // e.g. PROVIDER_ERROR Extraction failed: ECONNREFUSED
  } else {
    throw error;
  }
}
```

| `code` | When |
| --- | --- |
| `INVALID_INPUT` | The input is empty, not a string / `Uint8Array` / `{ data }`, or no text came out of the document; or `options.model` is missing |
| `UNSUPPORTED_INPUT` | The bytes are an image (needs OCR, planned for 0.2), a legacy `.doc`, a ZIP that is not a DOCX, or not recognizable as PDF, DOCX or UTF-8 text |
| `NO_TEXT_LAYER` | The PDF has no extractable text (scanned or image-only). Run OCR first and pass the text |
| `EXTRACTION_FAILED` | The document could not be read: corrupt or password-protected PDF, broken DOCX |
| `NO_OBJECT_GENERATED` | The model did not return a valid object (`rawText` holds what it did return) |
| `PROVIDER_ERROR` | The provider call failed: connection refused, auth, rate limit, abort (`statusCode` when available) |
| `VALIDATION_ERROR` | The normalized result did not pass `ResumeSchema` |

## Why cvparse

- **There is no maintained TypeScript library for LLM-based CV extraction.** The existing TypeScript projects are rule-based browser parsers (open-resume and its forks), full applications, or regex packages that stopped in 2022. LLM parsers exist in Python, mostly as scripts. cvparse is a library: no UI, no framework, just a function and a CLI.
- **Two-column PDFs come out in reading order.** cvparse rebuilds the reading order from the positions of the text on the page (a recursive XY-cut): it finds the vertical gutter of two-column and sidebar layouts, keeps full-width headers and footers in place, and then splits by vertical gaps, so the left column is read before the right instead of interleaved line by line. Known limits: three or more columns are only handled incidentally, tables may be read row by row, rotated or right-to-left text is ignored, and a short block of right-aligned dates can occasionally be read as a second column. DOCX files go through `mammoth`, with layout tables read cell by cell and text boxes recovered; DOCX headers and footers are not read.
- **Spanish CVs are a first-class target.** Spanish date formats ("marzo 2021 – actualidad") and LATAM location conventions (CABA, Argentina; Medellín, Antioquia) are exercised by the test fixtures today. Spain-specific degree normalization ("Grado", "Máster") is on the 0.1 roadmap, and mixed-language CVs are part of the 0.3 evaluation dataset.
- **Deterministic date normalization.** After the model call, cvparse normalizes dates itself: Spanish, English and Portuguese month names and abbreviations, ongoing markers ("actualidad", "presente", "a la fecha", "current"), day-first numeric dates (`03/2021`, `15/03/2021`) and bare years all become `YYYY`, `YYYY-MM` or `YYYY-MM-DD`, and every date it cannot normalize is reported in `warnings` instead of silently passed through. `normalizeDate` is exported if you want it on its own.
- **Typed output.** The result is validated with Zod and you get a `Resume` type. No `any`, no post-hoc JSON parsing.
- **Multi-provider.** Bring any model the Vercel AI SDK supports. Swap Ollama for OpenAI, Anthropic, Bedrock or Google by changing one line.
- **Local-first.** CVs are personal data. The default CLI setup runs against Ollama on localhost and sends nothing to third parties. The library itself never phones home.

## Output schema

The output follows the [JSON Resume](https://jsonresume.org/schema/) v1 field names and shape, so it works with the existing ecosystem of themes, builders and CLIs:

`basics`, `work`, `volunteer`, `education`, `awards`, `certificates`, `publications`, `skills`, `languages`, `interests`, `references`, `projects`.

Every field is optional and tolerant of `null`, because real CVs are incomplete. Dates are ISO strings in the precision the CV gives: `YYYY`, `YYYY-MM` or `YYYY-MM-DD`.

cvparse adds its own data under the `x_cvparse` key so the JSON Resume part stays clean:

- `detectedLanguage` — ISO 639-1 code of the language the CV is written in (`es`, `en`, `pt`, ...).
- `normalizedSkills` — a flat, deduplicated list of skills as canonical lowercase names.
- `location` — LATAM-friendly structured location: `countryCode` (ISO 3166-1 alpha-2), `adminRegion` (state, province, department, autonomous community), `city`, and `raw` (the location exactly as written in the CV).
- `confidenceNotes` — short notes about ambiguous or uncertain extractions; also appended to `warnings`.
- `educationLevels` — one entry per `education[]` item, in the same order: `level` (`secondary`, `technical`, `bachelor`, `postgraduate`, `master`, `doctorate`, `course` or `unknown`), the `original` study type and a `canonical` title family ("Licenciatura", "Grado", "Ingeniería", "Tecnicatura", "Máster", "Doctorado", "Diplomado", ...). Computed by cvparse from Spanish, Portuguese and English degree names; `education[].studyType` keeps the original text.

The Zod schemas (`ResumeSchema`, `BasicsSchema`, `WorkSchema`, `EducationSchema`, `SkillSchema`, `ExtensionSchema` and the rest) are exported so you can validate, extend or reuse them. The authoritative definition is in [`src/schema/resume.ts`](./src/schema/resume.ts).

```ts
import { ResumeSchema, type Resume } from '@cvparse/core';

const parsed: Resume = ResumeSchema.parse(JSON.parse(raw));
```

### Example: a Spanish CV

Input (synthetic, abridged):

```text
María Fernández López
Desarrolladora Backend · Córdoba, Argentina
maria.fernandez@example.com · +54 351 555 0134

Experiencia
Backend Developer — Fintech Andina · Córdoba · marzo 2021 – actualidad
  APIs en Node.js y NestJS, PostgreSQL, despliegue en AWS.
Desarrolladora Junior — Soluciones Web SRL · 2019 – 2021

Educación
Licenciatura en Ciencias de la Computación — Universidad Nacional de Córdoba, 2014 – 2019

Idiomas: Español (nativo), Inglés (B2)
Habilidades: TypeScript, Node.js, NestJS, PostgreSQL, Docker, AWS
```

Output:

```json
{
  "basics": {
    "name": "María Fernández López",
    "label": "Desarrolladora Backend",
    "email": "maria.fernandez@example.com",
    "phone": "+54 351 555 0134",
    "location": { "city": "Córdoba", "countryCode": "AR" }
  },
  "work": [
    {
      "name": "Fintech Andina",
      "position": "Backend Developer",
      "location": "Córdoba",
      "startDate": "2021-03",
      "endDate": null,
      "summary": "APIs en Node.js y NestJS, PostgreSQL, despliegue en AWS."
    },
    {
      "name": "Soluciones Web SRL",
      "position": "Desarrolladora Junior",
      "startDate": "2019",
      "endDate": "2021"
    }
  ],
  "education": [
    {
      "institution": "Universidad Nacional de Córdoba",
      "studyType": "Licenciatura",
      "area": "Ciencias de la Computación",
      "startDate": "2014",
      "endDate": "2019"
    }
  ],
  "skills": [
    { "name": "TypeScript" }, { "name": "Node.js" }, { "name": "NestJS" },
    { "name": "PostgreSQL" }, { "name": "Docker" }, { "name": "AWS" }
  ],
  "languages": [
    { "language": "Español", "fluency": "Nativo" },
    { "language": "Inglés", "fluency": "B2" }
  ],
  "x_cvparse": {
    "detectedLanguage": "es",
    "normalizedSkills": ["typescript", "node.js", "nestjs", "postgresql", "docker", "aws"],
    "location": { "countryCode": "AR", "adminRegion": "Córdoba", "city": "Córdoba", "raw": "Córdoba, Argentina" },
    "confidenceNotes": ["'actualidad' interpreted as an ongoing role (endDate: null)."]
  }
}
```

Exact values depend on the model you use. Small local models will be less consistent than frontier models; that trade-off is yours to make.

## When NOT to use this

| If you need... | Use instead |
| --- | --- |
| Parsing without an LLM (deterministic, offline, no model at all) | A rule-based parser such as [open-resume](https://github.com/xitanggg/open-resume)'s parser. Expect lower accuracy on non-standard layouts. |
| Something that runs in the browser | cvparse targets Node >= 22. Rule-based browser parsers exist; LLM calls from the browser expose your API keys. |
| High-volume commercial parsing with SLAs, taxonomies and support contracts | Affinda, Textkernel, RChilli, Daxtra, HireAbility. They are ahead on volume, taxonomy coverage and edge cases, and they charge accordingly. |
| Scanned PDFs or image input **today** | Not yet: a PDF without a text layer fails with `NO_TEXT_LAYER` and images are rejected. Run OCR yourself (Tesseract, Textract) and pass the text, or wait for the 0.2 OCR adapter. Legacy `.doc` files are rejected too: save them as `.docx` or PDF. |
| Guaranteed, reproducible output for the same input | LLM output varies between runs and models. cvparse validates the shape, not the semantics. Pin a model and temperature and evaluate on your own data. |
| CV-to-job matching, ranking or scoring | cvparse only extracts. Pair it with a matcher such as Resume-Matcher. |
| Python | Several LLM-based CV parsers exist for Python. cvparse is TypeScript-only. |

## Roadmap

Summary; the full plan is in [docs/ROADMAP.md](./docs/ROADMAP.md).

- **0.1** (done) — PDF text extraction with reading-order reconstruction for two-column and sidebar layouts, DOCX input including tables and text boxes, format detection from bytes, `extractText` / `detectFormat`. `npx @cvparse/core ./cv.pdf` works out of the box. Still open under 0.1: more date forms, degree normalization for Spain and LATAM, `temperature` pass-through.
- **0.2** — OCR adapter for scanned CVs and images (pluggable: Tesseract, AWS Textract).
- **0.3** — Public evaluation dataset of synthetic Spanish CVs with hard layouts, and a published benchmark against open-resume.
- **Later** — Agent skill and MCP server packaging so cvparse can be used directly from coding agents and assistants.

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](./CONTRIBUTING.md) first, in particular the rules for fixture CVs: synthetic data only, never a real person's CV. All participants are expected to follow the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Security

CVs are personal data. cvparse sends the text only to the model provider you configure and nowhere else. To report a vulnerability, see [SECURITY.md](./SECURITY.md).

## License

[MIT](./LICENSE) © 2026 Nikire

## About

cvparse is built and maintained by the founder of Borderless ATS, where parsing Spanish-language CVs reliably is a daily problem rather than a demo.
