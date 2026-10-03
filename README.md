# cvparse

Turn CVs and resumes into typed, JSON Resume-compatible JSON using LLMs, with any provider the Vercel AI SDK supports, including local models via Ollama.

[![npm version](https://img.shields.io/npm/v/%40cvparse%2Fcore.svg)](https://www.npmjs.com/package/@cvparse/core)
[![CI](https://img.shields.io/github/actions/workflow/status/Nikire/cvparse/ci.yml?branch=main&label=CI)](https://github.com/Nikire/cvparse/actions)
[![License: MIT](https://img.shields.io/github/license/Nikire/cvparse.svg)](https://github.com/Nikire/cvparse/blob/main/LICENSE)
[![Node >= 22](https://img.shields.io/node/v/%40cvparse%2Fcore.svg)](https://nodejs.org)

> **Status: 0.x — early.**
> cvparse reads **PDF, DOCX and plain text**. PDFs are read in reading order, including two-column and sidebar layouts. **Images (PNG, JPEG, WebP, TIFF) and scanned PDFs** work through an OCR adapter (Tesseract locally, or AWS Textract) or vision mode (the page images go to a multimodal model); see [Scanned CVs and images](#scanned-cvs-and-images). See the [roadmap](#roadmap). The schema and API may still change before 1.0.

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

**Raise Ollama's context window.** Ollama serves every model with a context window set on the server (4096 tokens in many installs), whatever the model itself supports. A long CV plus the extracted JSON can exceed it, and Ollama then silently drops the start of the conversation, instructions included, so entries go missing. Set `OLLAMA_CONTEXT_LENGTH=16384` in the environment of the Ollama server and restart Ollama:

```bash
# Windows (then quit and restart Ollama from the tray)
setx OLLAMA_CONTEXT_LENGTH 16384
# macOS (Ollama app; then restart it)
launchctl setenv OLLAMA_CONTEXT_LENGTH 16384
# Linux (systemd): add Environment="OLLAMA_CONTEXT_LENGTH=16384" under [Service]
sudo systemctl edit ollama && sudo systemctl restart ollama
```

After each Ollama call the CLI asks the server for the loaded context length and prints a `warning:` with this hint when the call used 90% or more of the window.

The input can be a PDF, a DOCX, a plain-text file or, with `--ocr`, an image or scanned PDF; the format is detected from the file contents, not the extension. For a PDF or DOCX the CLI prints one `info:` line to stderr saying what it read, e.g. `info: read pdf, 2 page(s), multi-column layout`.

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
| `<file>` | path or `-` | Path to the CV: `.pdf`, `.docx`, `.png` / `.jpg` / `.webp` / `.tiff` or plain text (`.txt`, `.md`, ...). The format is detected from the file contents. `-` reads from stdin, as text or bytes. Images and scanned PDFs need `--ocr`; without it the CLI exits 2 with a hint |
| `--provider` | `ollama` \| `openai` \| `openai-compatible` | Default: `ollama` |
| `--model <id>` | any model id the provider knows | Default: `llama3.1` (ollama), `gpt-4o-mini` (openai); required for `openai-compatible` |
| `--base-url <url>` | URL | Default: `http://localhost:11434/v1` (ollama), `https://api.openai.com/v1` (openai); required for `openai-compatible` |
| `--api-key <key>` | string | Sent as a Bearer token. Falls back to env `CVPARSE_API_KEY` (any provider) or `OPENAI_API_KEY` (only with `--provider openai`). The key is only sent to the configured base URL: `https://api.openai.com/v1` by default for `--provider openai`; if you override `--base-url`, the key is sent to that host instead |
| `--lang` | `es` \| `en` \| `auto` | Language hint for the CV. Default: `auto` |
| `--pretty` | flag | Indent the JSON output |
| `--ocr <engine>` | `tesseract` \| `textract` \| `vision` | How to read images and scanned PDFs. `tesseract`: local (`npm i tesseract.js`). `textract`: AWS (`npm i @aws-sdk/client-textract`; default AWS credential chain and `AWS_REGION`). `vision`: send the page images to the model, which must accept images (e.g. `gemma3:4b`, `gpt-4o-mini`). Scanned PDFs are rendered with `@napi-rs/canvas` (`npm i @napi-rs/canvas`). See [Scanned CVs and images](#scanned-cvs-and-images) |
| `--ocr-lang <codes>` | comma-separated ISO codes, e.g. `es,en` | OCR language hints. Default: `--lang` if set, otherwise `es,en` |
| `--extract-only` | flag | Print the reading-order text extracted from the document and exit, without calling any model. Use it to check how a two-column PDF was read, or to attach the text to a bug report. Needs no provider or key. Works with `--ocr tesseract` / `textract`, not with `--ocr vision` |
| `-h`, `--help` | flag | Print usage to stderr |
| `-v`, `--version` | flag | Print the cvparse version |

The CLI prints only the `resume` object as JSON to **stdout**; `warnings` go to **stderr** as `warning:` lines, together with help and errors. Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Extraction failed (provider error, invalid model output, corrupt document, OCR engine or API error) |
| `2` | Usage error (bad arguments, missing file, unsupported or empty input, image or scanned PDF without `--ocr`, OCR package not installed) |

So it composes with pipes and scripts:

```bash
npx @cvparse/core ./cv.pdf | jq '.basics.name'
cat cv.pdf | npx @cvparse/core - --lang es
```

### Programmatic

```bash
npm install @cvparse/core @ai-sdk/openai-compatible
```

`parseResume` takes the CV, as a string or as the bytes of a PDF, DOCX or text file (or of an image or scanned PDF, with the `ocr` option; see [Scanned CVs and images](#scanned-cvs-and-images)), plus any AI SDK language model. Use Ollama for a fully local setup:

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
  grounding?: boolean;              // check the output against the document text; default true (see below)
  ocr?: OcrAdapter | 'vision';      // how to read images and scanned PDFs; without it they fail with OCR_REQUIRED / NO_TEXT_LAYER
  ocrLanguages?: readonly string[]; // OCR language hints (ISO 639-1, e.g. ['es', 'en']); default: `language` when set
};
```

The result:

```ts
type ParseResult = {
  resume: Resume;      // typed, validated against ResumeSchema
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  warnings: string[];  // human-readable, one per line; see "Warnings" below
  source: {
    format: 'text' | 'pdf' | 'docx' | 'image';            // what the input was read as
    pages?: number;                                       // PDFs (and vision mode)
    layout: 'single-column' | 'multi-column' | 'unknown'; // PDFs and OCR'd images; 'unknown' otherwise
    ocr?: {                                               // only when OCR or vision mode produced the text
      adapter: string;                                    // 'tesseract', 'textract', your adapter's name, or 'vision'
      confidence?: number;                                // mean 0..1, when the engine reports it (not in vision mode)
      pages: number;                                      // pages (images) recognized
    };
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
| `UNSUPPORTED_INPUT` | A legacy `.doc`, a ZIP that is not a DOCX, an image format no OCR path accepts (GIF, BMP), or bytes not recognizable as PDF, DOCX, image or UTF-8 text |
| `OCR_REQUIRED` | The input is an image and no `ocr` option was set. Pass an OCR adapter or `ocr: 'vision'`. CLI exit code 2 |
| `NO_TEXT_LAYER` | The PDF has no extractable text (scanned or image-only) and no `ocr` option was set. Same fix as `OCR_REQUIRED`. CLI exit code 2 |
| `OCR_FAILED` | The OCR adapter failed: engine error, Textract API error (access denied, throttling, bad document), unsupported image for that engine. `statusCode` when it came from an HTTP API. CLI exit code 1 |
| `MISSING_DEPENDENCY` | An optional peer is not installed: `tesseract.js`, `@aws-sdk/client-textract`, or `@napi-rs/canvas` (needed to render scanned PDFs). The message includes the `npm install` command. CLI exit code 2 |
| `EXTRACTION_FAILED` | The document could not be read: corrupt or password-protected PDF, broken DOCX |
| `NO_OBJECT_GENERATED` | The model did not return a valid object (`rawText` holds what it did return) |
| `PROVIDER_ERROR` | The provider call failed: connection refused, auth, rate limit, abort (`statusCode` when available) |
| `VALIDATION_ERROR` | The normalized result did not pass `ResumeSchema` |

### Warnings

Problems that do not stop the parse go to `ParseResult.warnings` (and to stderr as `warning:` lines in the CLI). Most start with a prefix you can filter on:

| Prefix | Meaning |
| --- | --- |
| `extract:` | Reading the document: scanned pages without OCR, DOCX text boxes, fallbacks, and OCR issues (`extract: ocr: low confidence ...`) |
| `grounding:` | A value not found in the document was dropped, or replaced by what is written there |
| `placement:` | An entry was moved to the section whose heading it is written under |
| `coverage:` | The document has a section (e.g. "Projects") that came back empty |
| `precision:` | A date the model padded with an invented month or day was cut back to what the CV says |
| `model:` | The model's own confidence notes (`x_cvparse.confidenceNotes`) |

Provider warnings (such as `responseFormat`), dates that could not be normalized and small repairs (an organization and title split apart, several award dates reduced to the latest) are reported without a prefix.

### How cvparse keeps the model honest

LLMs, small local ones in particular, fill gaps with plausible inventions. Testing a real 3-page CV with an 8B model produced a phone number, a city and three skills that were not in the document. So after the model call, cvparse checks the output against the text it read, deterministically:

- **Grounding.** Contact data (email, phone, URLs, profiles), locations (the candidate's and each entry's, including the candidate's city copied into every job), skills and skill levels, and spoken languages are looked up in the document (accent- and case-insensitive). Values that are not there are dropped. Language fluency and degree and job titles the model rewrote are replaced by what is written next to the language, institution or company. Each change adds a `grounding:` warning. Summaries, highlights, company names and dates are not grounded. Set `grounding: false` to keep the raw model output. Grounding is skipped in vision mode, where there is no text to compare against.
- **Placement.** An entry the model put in the wrong section (a university in `work[]`, a job in `education[]`, a course in `work[]`) is moved to the section whose heading it is written under, with a `placement:` warning.
- **Coverage.** When the document has a section heading (or an inline "Languages:" label) and the matching array came back empty, a `coverage:` warning says so: usually a model that stopped early.
- **No invented months.** "2020" padded to "2020-01" is cut back to "2020" when the CV never writes a month for that year (`precision:` warning).
- **Deterministic skills list.** `x_cvparse.normalizedSkills` is computed by cvparse from `skills`, never taken from the model.

`groundResume` and `checkCoverage` are exported if you want to run them on output from your own pipeline.

## Scanned CVs and images

A photo, a scan, or a PDF without a text layer has no text to read. cvparse handles them in one of three ways, chosen with `ParseOptions.ocr` (or `--ocr` in the CLI). The full guide, with every adapter option, offline setup, quality tips and how to write your own adapter, is in [docs/ocr.md](./docs/ocr.md).

| | Tesseract | AWS Textract | Vision mode |
| --- | --- | --- | --- |
| Option | `ocr: createTesseractAdapter()` | `ocr: createTextractAdapter()` | `ocr: 'vision'` |
| Runs | Locally (WASM, in a worker thread) | In AWS, paid per page | Wherever your `model` runs |
| Model | Any text model | Any text model | Must accept images (`gemma3:4b`, `qwen2.5vl`, `gpt-4o-mini`, ...) |
| Install | `npm install tesseract.js` | `npm install @aws-sdk/client-textract` | nothing extra |

The OCR engines are **optional peer dependencies**, loaded only when you use them; if one is missing you get `MISSING_DEPENDENCY` with the install command. Scanned PDFs are rendered to PNG first, which needs one more optional peer, `@napi-rs/canvas`, in every mode. The OCR adapters get at most 20 rendered pages, and vision mode sends at most 5 page images to the model; a warning says when a document was cut short. Install the packages in the same project as cvparse; `npx @cvparse/core` then uses that local install.

### Tesseract (local)

```bash
npm install tesseract.js @napi-rs/canvas   # @napi-rs/canvas only needed for scanned PDFs
```

```ts
import { readFile } from 'node:fs/promises';
import { parseResume } from '@cvparse/core';
import { createTesseractAdapter } from '@cvparse/core/ocr/tesseract';

const ocr = createTesseractAdapter({ languages: ['es', 'en'] });
try {
  const { resume, source } = await parseResume(await readFile('./scan.jpg'), { model, ocr });
  console.log(source.ocr); // { adapter: 'tesseract', confidence: 0.91, pages: 1 }
} finally {
  await ocr.dispose?.(); // the worker thread keeps the process alive until disposed
}
```

```bash
npx @cvparse/core ./scan.jpg --ocr tesseract --ocr-lang es
```

Tesseract reads printed text well, and because positioned words go through the same column detection as PDFs, two-column scans come out in reading order. On the synthetic two-column scan in `test/fixtures/pdf/scanned-es.pdf` it takes about 2 seconds on a laptop CPU, with one OCR error (an `@` read as `Q`). Reuse one adapter for a batch of CVs. `source.ocr.confidence` is the mean word confidence, and cvparse adds a warning for pages below 0.7, so you can route low-confidence results to a person.

### AWS Textract (hosted)

```bash
npm install @aws-sdk/client-textract @napi-rs/canvas   # @napi-rs/canvas only needed for scanned PDFs
```

```ts
import { createTextractAdapter } from '@cvparse/core/ocr/textract';

const ocr = createTextractAdapter({ region: 'us-east-1' }); // features: 'detect' (default) or 'layout'
const { resume } = await parseResume(await readFile('./scan.png'), { model, ocr });
await ocr.dispose?.();
```

```bash
npx @cvparse/core ./scan.pdf --ocr textract
```

Credentials and region come from the standard AWS SDK chain (`AWS_PROFILE`, `AWS_ACCESS_KEY_ID`, SSO, instance roles; `AWS_REGION`). `features: 'layout'` uses Textract's layout model for reading order and costs more per page; see [docs/ocr.md](./docs/ocr.md#detect-vs-layout). Textract accepts JPEG, PNG and TIFF up to 10 MB, not WebP.

### Vision mode

No OCR engine: the page images go straight to the model, which reads them itself. The model must accept images.

```ts
const { resume, source } = await parseResume(await readFile('./scan.png'), {
  model: ollama('gemma3:4b'),
  ocr: 'vision',
});
```

```bash
npx @cvparse/core ./scan.pdf --ocr vision --model gemma3:4b
npx @cvparse/core ./photo.jpg --ocr vision --provider openai --model gpt-4o-mini
```

Locally, `gemma3:4b` read name, jobs, dates, skills and languages correctly from the synthetic PNG fixture in about 13 seconds; `qwen2.5vl` is another option. `llama3.2-vision` does not load in current Ollama releases (unknown architecture `mllama`). In the cloud, `gpt-4o-mini` is a cheap choice. Vision mode accepts PNG, JPEG and WebP images, and scanned PDFs (rendered with `@napi-rs/canvas`).

### Privacy

- **Tesseract** runs on your machine and never sends the image anywhere. On first use for a language it downloads the `traineddata` file (a few MB) from the jsDelivr CDN, which needs network access and tells the CDN which languages you use. Set `langPath` / `cachePath` to serve or pre-fill those files for offline use ([details](./docs/ocr.md#traineddata-and-offline-use)). With Tesseract and Ollama, nothing leaves your machine.
- **Textract** sends the CV to AWS, in the region you choose. Check your data processing agreement and AWS AI-services opt-out before using it on real candidates.
- **Vision mode** sends the page images to whatever model provider you configured: your own machine with Ollama, the provider's servers otherwise.

## Why cvparse

- **There is no maintained TypeScript library for LLM-based CV extraction.** The existing TypeScript projects are rule-based browser parsers (open-resume and its forks), full applications, or regex packages that stopped in 2022. LLM parsers exist in Python, mostly as scripts. cvparse is a library: no UI, no framework, just a function and a CLI.
- **Two-column PDFs come out in reading order.** cvparse rebuilds the reading order from the positions of the text on the page (a recursive XY-cut): it finds the vertical gutter of two-column and sidebar layouts, keeps full-width headers and footers in place, and then splits by vertical gaps, so the left column is read before the right instead of interleaved line by line. Known limits: three or more columns are only handled incidentally, tables may be read row by row, rotated or right-to-left text is ignored, and a short block of right-aligned dates can occasionally be read as a second column. DOCX files go through `mammoth`, with layout tables read cell by cell and text boxes recovered; DOCX headers and footers are not read.
- **Spanish CVs are a first-class target.** Spanish date formats ("marzo 2021 – actualidad") and LATAM location conventions (CABA, Argentina; Medellín, Antioquia) are exercised by the test fixtures today. Degree names from Spain and LATAM ("Grado", "Máster", "Licenciatura", "Tecnicatura") are normalized into `x_cvparse.educationLevels`, and mixed-language CVs are part of the 0.3 evaluation dataset.
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
- `normalizedSkills` — a flat, deduplicated, lowercase list derived by cvparse from `skills` (every keyword, plus the names of entries without keywords). Only skills written in the document; no translations or canonical names.
- `location` — LATAM-friendly structured location: `countryCode` (ISO 3166-1 alpha-2), `adminRegion` (state, province, department, autonomous community), `city`, and `raw` (the location exactly as written in the CV).
- `confidenceNotes` — short notes about ambiguous or uncertain extractions; also appended to `warnings`.
- `educationLevels` — one entry per `education[]` item, in the same order: `level` (`secondary`, `technical`, `bachelor`, `postgraduate`, `master`, `doctorate`, `course` or `unknown`), the `original` study type and a `canonical` title family ("Licenciatura", "Grado", "Ingeniería", "Tecnicatura", "Máster", "Doctorado", "Diplomado", ...). Computed by cvparse from Spanish, Portuguese and English degree names; `education[].studyType` keeps the title as written in the CV (e.g. "Computer Engineering", not an invented "Bachelor's degree").

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

## Benchmark

Field-level F1 on a synthetic dataset of Spanish CVs with hard layouts (two columns, sidebars, DOCX tables and text boxes, scans), compared with rule-based parsers. The harness lives in [eval/](eval/).

<!-- eval:results:start -->

**Read this first.** The dataset and the scorer were written by the cvparse authors, so this is an in-distribution benchmark, not an independent one: the date styles and the degree vocabulary are the ones cvparse's normalizers were built for. Both baselines detect sections by English headings and these CVs use Spanish ones; that is the gap the benchmark is meant to show, but it also means the baselines lose most sections by design. resume-parser is fed the text cvparse extracts (its own reader needs poppler), so it inherits cvparse's reading order. open-resume reads only PDFs: **Coverage** says how many CVs each system attempted, and **PDF only** compares every system on the same 40 PDF inputs. More in the [dataset card](eval/dataset/README.md#who-made-this-and-known-biases).

Dataset 1.0.0, 60 synthetic Spanish CVs.

### Field-level F1 (%)

| System | Coverage | Overall | PDF only (40) | Name | Email | Phone | Location | Work entries | Work dates | Education | Education dates | Skills | Languages |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| cvparse + llama3.1 8B (Ollama, local) + Tesseract | 60/60 | **98.1** | 98.8 | 100.0 | 98.3 | 100.0 | 96.7 | 92.5 | 95.6 | 99.6 | 99.0 | 98.9 | 100.0 |
| open-resume (rules) | 40/60 | **17.2** | 17.2 | 17.7 | 91.9 | 43.1 | 13.3 | 0.0 | 0.0 | 0.0 | 0.0 | 5.7 | 0.0 |
| resume-parser (regex) (2 failed) | 56/60 | **16.9** | 16.1 | 5.5 | 98.2 | 52.6 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 7.1 | 5.8 |

Overall is the mean F1 over the 10 fields above, computed on the CVs a system attempted (formats it cannot read are skipped, not scored as zero, and show up in Coverage). Scoring rules: [eval/score/README.md](eval/score/README.md).

### cvparse-only diagnostic: education level

| System | Education level F1 | P | R | support |
| --- | ---: | ---: | ---: | ---: |
| cvparse + llama3.1 8B (Ollama, local) + Tesseract | 96.9 | 97.3 | 96.5 | 113 |

Not part of Overall. The dataset's degree vocabulary was written alongside cvparse's degree normalizer, so this is not an independent measure; baselines do not produce education levels.

### Overall F1 by layout (%)

| Layout | cvparse + llama3.1 8B (Ollama, local) + Tesseract | open-resume (rules) | resume-parser (regex) |
| --- | ---: | ---: | ---: |
| academic (4) | 100.0 | 0.0 | 16.7 |
| functional (4) | 95.4 | 14.0 | 14.0 |
| scanned (6) | 98.2 | 0.0 | 0.0 |
| sidebar (8) | 98.0 | 17.7 | 15.5 |
| single-column (17) | 97.7 | 20.7 | 18.5 |
| table (6) | 98.0 | n/a | 15.0 |
| textbox (4) | 97.5 | n/a | 21.1 |
| two-column (11) | 99.6 | 19.9 | 17.2 |

### Setup

- **cvparse + llama3.1 8B (Ollama, local) + Tesseract**: cvparse 0.2.0; provider: ollama, model: llama3.1, ocr: tesseract, temperature: 0, language: es, referenceDate: 2026-10-01, hardware: 12th Gen Intel(R) Core(TM) i9-12900F, 30 GB RAM, win32; GPU: NVIDIA GeForce RTX 4070 SUPER, node: v22.14.0, ollamaVersion: 0.35.0, modelDigest: sha256:46e0c10c039e, tesseract.js: 7.0.0, datasetVersion: 1.0.0, datasetHash: 76c69f1bbc2c5657, cvparseCommit: 81432f5d3015159a7d4a33db03e98f96749286a0, cvparseSrcHash: 253c04ad9d9e5715; 60 CVs in 916 s
- **open-resume (rules)**: repo: github.com/xitanggg/open-resume, commit: 4f8255a2c763479837f69f1dccf2a3338730cd79, license: AGPL-3.0 (fetched at runtime, not vendored), pdfReader: Node port of read-pdf.ts on unpdf's pdf.js, dates: normalized with cvparse normalizeDate/splitDateRange, node: v22.14.0, hardware: 12th Gen Intel(R) Core(TM) i9-12900F, 30 GB RAM, win32, datasetVersion: 1.0.0, datasetHash: 76c69f1bbc2c5657; 40 CVs in 1 s
- **resume-parser (regex)**: package: resume-parser@1.1.0, license: ISC, input: plain text from cvparse extractText (its textract/pdftotext reader is bypassed), dates: not extracted (sections are raw text), node: v22.14.0, hardware: 12th Gen Intel(R) Core(TM) i9-12900F, 30 GB RAM, win32, datasetVersion: 1.0.0, datasetHash: 76c69f1bbc2c5657; 56 CVs in 12 s

Reproduce (then `npm run eval:report`):

- cvparse + llama3.1 8B (Ollama, local) + Tesseract: `npm run eval -- --system cvparse --provider ollama --model llama3.1 --ocr tesseract --name "cvparse + llama3.1 8B (Ollama, local) + Tesseract" --gpu "NVIDIA GeForce RTX 4070 SUPER"`
- open-resume (rules): `npm run eval -- --system open-resume`
- resume-parser (regex): `npm run eval -- --system resume-parser`

<!-- eval:results:end -->

## When NOT to use this

| If you need... | Use instead |
| --- | --- |
| Parsing without an LLM (deterministic, offline, no model at all) | A rule-based parser such as [open-resume](https://github.com/xitanggg/open-resume)'s parser. Expect lower accuracy on non-standard layouts. |
| Something that runs in the browser | cvparse targets Node >= 22. Rule-based browser parsers exist; LLM calls from the browser expose your API keys. |
| High-volume commercial parsing with SLAs, taxonomies and support contracts | Affinda, Textkernel, RChilli, Daxtra, HireAbility. They are ahead on volume, taxonomy coverage and edge cases, and they charge accordingly. |
| Handwritten CVs, or low-quality phone photos (blurry, at an angle, poorly lit) | Tesseract cannot read handwriting and does not correct perspective; vision models and Textract cope better but still misread names, emails and dates on bad photos. Ask for a PDF or a clean scan, or route these to a person. |
| Legacy `.doc` files | They are rejected. Save them as `.docx` or PDF first. |
| Guaranteed, reproducible output for the same input | LLM output varies between runs and models. cvparse validates the shape, not the semantics. Pin a model and temperature and evaluate on your own data. |
| CV-to-job matching, ranking or scoring | cvparse only extracts. Pair it with a matcher such as Resume-Matcher. |
| Python | Several LLM-based CV parsers exist for Python. cvparse is TypeScript-only. |

## Roadmap

Summary; the full plan is in [docs/ROADMAP.md](./docs/ROADMAP.md).

- **0.1** (done) — PDF text extraction with reading-order reconstruction for two-column and sidebar layouts, DOCX input including tables and text boxes, format detection from bytes, `extractText` / `detectFormat`. `npx @cvparse/core ./cv.pdf` works out of the box. 0.1.1 added more date forms, degree normalization for Spain and LATAM, and `temperature` / `referenceDate`.
- **0.2** (done, unreleased) — Scanned CVs and images: pluggable OCR adapter interface with Tesseract (local) and AWS Textract reference adapters, vision mode for multimodal models, PNG/JPEG/WebP/TIFF input in the CLI, OCR confidence in `source.ocr`.
- **0.3** — Public evaluation dataset of synthetic Spanish CVs with hard layouts, and a published benchmark against open-resume.
- **Later** — Agent skill and MCP server packaging so cvparse can be used directly from coding agents and assistants.

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](./CONTRIBUTING.md) first, in particular the rules for fixture CVs: synthetic data only, never a real person's CV. All participants are expected to follow the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Security

CVs are personal data. cvparse sends the text (or, in vision mode, the page images) only to the model provider you configure, plus to AWS if you choose the Textract adapter, and nowhere else. To report a vulnerability, see [SECURITY.md](./SECURITY.md).

## License

[MIT](./LICENSE) © 2026 Nikire

## About

cvparse is built and maintained by the founder of Borderless ATS, where parsing Spanish-language CVs reliably is a daily problem rather than a demo.
