# Roadmap

This is the plan as of the 0.0.1 release (2026-09-30), updated as items land. It is a statement of intent, not a promise: order and scope will shift based on real issues. Anything here can be picked up by a contributor; open an issue first so we can agree on the approach.

## Guiding principles

- **The hard part is not the LLM call.** With Zod and structured outputs, "extract a CV" is a few dozen lines. The value has to be in what is difficult: two-column PDFs, scanned documents, DOCX files exported from design tools, Spanish date and degree normalization, and an evaluation dataset that proves any of it works.
- **Local-first stays non-negotiable.** Every feature must work with Ollama on localhost. Cloud providers are an option, never a requirement.
- **JSON Resume compatibility stays.** Extensions live under `x_cvparse`; the core shape does not drift.
- **Few dependencies, but `npx` must work out of the box.** PDF and DOCX extraction are built in (`unpdf`, `mammoth`), loaded on demand so that callers who pass a string never load them. OCR and vision models stay pluggable adapters, never hard dependencies of the core package.

## 0.0.1 — Preview (released 2026-09-30)

- [x] `parseResume(text, { model })` on plain text.
- [x] JSON Resume-compatible Zod schema with `x_cvparse` extensions.
- [x] `cvparse` CLI with Ollama, OpenAI and OpenAI-compatible providers.
- [x] Deterministic date normalization after the model call (`normalizeDate`): es/en/pt month names and abbreviations, ongoing markers ("actualidad", "presente", "a la fecha", "current"), day-first numeric dates (`DD/MM/YYYY`, `MM/YYYY`), dotted/dashed forms and bare years, with a per-field warning when a date cannot be normalized.
- [x] Heuristic language detection (`detectLanguage`) used as a hint when `language: "auto"`.
- [x] Project scaffolding: docs, CI, license, contribution guide.

## 0.1 — Documents in

Goal: `npx @cvparse/core ./cv.pdf` and `npx @cvparse/core ./cv.docx` work without the user extracting text first.

- [x] PDF text extraction with layout awareness. Two-column and sidebar layouts (the Canva / Novorésumé style that dominates Spanish-speaking markets) produce reading-order text, not interleaved columns, via a recursive XY-cut (`src/extract/layout.ts`). Known limits: 3+ columns only incidental, tables may read row-wise, rotated/RTL text ignored, a short block of right-aligned dates can read as a second column.
- [x] DOCX text extraction, including text boxes (VML via mammoth, DrawingML via a built-in fallback) and tables (grid tables as rows, layout tables cell by cell). Headers and footers are not extracted.
- [x] Input detection by magic bytes (file name only breaks ties); `parseResume` accepts `string | Uint8Array | { data, filename?, format? }`, and `extractText` / `detectFormat` are exported on their own.
- [x] ~~Extraction adapters are optional peer dependencies so the core stays small.~~ Decided otherwise: `unpdf` and `mammoth` are regular dependencies loaded on demand, so `npx @cvparse/core ./cv.pdf` works without extra installs. OCR stays an adapter (0.2).
- [x] Fixture set expanded with synthetic PDF and DOCX files (`test/fixtures/pdf`, `test/fixtures/docx`) generated deterministically by `npm run fixtures:pdf` and `npm run fixtures:docx` from the same synthetic content as the text fixtures.
- [x] Remaining date forms: relative dates ("hace 3 años", "3 years ago"), season names ("verano 2020"), quarter/semester notation, ranges written as a single token ("2019-21").
- [x] Degree and title normalization for Spain and LATAM (Licenciatura, Tecnicatura, Grado, Ingeniería, Máster, Doctorado, and their equivalents), mapped to `education[].studyType` with the original preserved.
- [x] Optional `temperature` pass-through in `ParseOptions` (`maxRetries` already exists since 0.0.1).

## 0.2 — Scanned documents

Goal: a scanned or photographed CV goes in, JSON comes out.

- [x] ~~OCR adapter interface: `(input: Buffer) => Promise<string>`.~~ Shipped as `OcrAdapter` (`recognize(input) => OcrPage | OcrPage[]`): adapters can return positioned items instead of plain text, and those go through the same reading-order code as PDFs, so two-column scans read column by column. Adapters that take PDFs directly declare `supports.pdf`; otherwise cvparse renders scanned PDFs to PNG with `@napi-rs/canvas` (optional peer, max 20 pages). See `docs/ocr.md`.
- [x] Reference adapters: Tesseract (`@cvparse/core/ocr/tesseract`, local, privacy-preserving) and AWS Textract (`@cvparse/core/ocr/textract`, hosted, `detect` or `layout`). Engines are optional peer dependencies, loaded on first use.
- [x] Vision-model path: `ocr: "vision"` sends the page images (max 5) to the model instead of OCR text. Works locally with `gemma3:4b` through Ollama.
- [x] Image inputs (PNG, JPEG, WebP, TIFF) in the CLI, with `--ocr tesseract|textract|vision` and `--ocr-lang`.
- [x] OCR quality surfaced: `source.ocr.confidence` (mean word confidence) and an `ocr:` warning for pages below 0.7, so consumers can route low-confidence results to human review.

## 0.3 — Prove it

Goal: numbers instead of claims.

- [x] Public evaluation dataset: 60 synthetic Spanish CVs (Spain, Argentina, Mexico, Colombia, Chile, Peru, Uruguay variants) with hard layouts: two columns, scanned, DOCX from Canva, mixed language, functional format, academic format.
- [x] Field-level scoring harness (exact match, fuzzy match, date tolerance) that runs against any AI SDK model.
- [x] Published benchmark: cvparse with a small local model (llama3.1 8B on Ollama) versus open-resume and resume-parser on the same dataset.
- [ ] More models in the benchmark: a mid-size local model and a frontier API model. Contributions welcome: `npm run eval -- --system cvparse --model <id>`.
- [x] Results table in the README, regenerated by a script so it does not rot.
- [x] `npm run eval` for contributors to check regressions before a PR.

## Later

Unscheduled; roughly in priority order.

- **Agent skill packaging.** Ship a skill definition so coding agents can invoke cvparse on files in a repository.
- **MCP server.** `@cvparse/mcp` exposing `parse_resume` as a tool, so assistants and agent frameworks can call it without glue code.
- **Portuguese.** Brazilian CVs share most of the layout problems with Spanish ones and are the next largest market.
- **Streaming partial results** for UIs that want to render fields as they arrive.
- **Anonymization helper**: strip `basics` PII from a parsed resume for blind-screening workflows.
- **Skill taxonomy mapping** (ESCO or similar) for `x_cvparse.normalizedSkills`, as an optional adapter.
- **1.0** when the schema has been stable for two consecutive minor releases and the benchmark harness exists.

## Explicitly out of scope

- A web UI or hosted API. cvparse is a library and a CLI.
- CV-to-job matching or scoring. Other projects do this; cvparse feeds them.
- Browser support. LLM calls belong on a server or a local machine.
- Custom provider adapters. The Vercel AI SDK already covers providers; cvparse will not maintain its own.
