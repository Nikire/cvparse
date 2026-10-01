# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the major version is 0, minor releases may contain breaking changes; they are called out explicitly.

## [Unreleased]

## [0.1.0] - 2026-10-01

### Added

- CLI `--extract-only`: print the reading-order text extracted from a PDF/DOCX/text file and exit without calling a model; needs no provider or key. Useful to check two-column reading order and for bug reports.
- PDF input. Text is extracted with pdf.js (via `unpdf`) and put back in reading order with a recursive XY-cut: a vertical gutter is detected first (two-column and sidebar layouts, with full-width headers and footers kept in place), then horizontal bands. Known limits: three or more columns are only handled incidentally, tables may be read row by row, rotated and right-to-left text is ignored, and a short block of right-aligned dates can be read as a second column.
- DOCX input via `mammoth`. Headings, lists and tables are kept as text: grid tables become `a | b` rows and layout tables (cells with several blocks) are read cell by cell, so two-column table CVs read left column then right. VML text boxes come from mammoth; DrawingML text boxes, which mammoth drops, are recovered from `word/document.xml` and appended at the end with a warning. Headers and footers are not extracted.
- `parseResume` accepts the document bytes: `string | Uint8Array | { data, filename?, format? }` (`ResumeInput`). A Node `Buffer` works. The format is detected from magic bytes (`%PDF-`, ZIP with `word/` entries, UTF-8 text); `filename` only breaks ties and `format` skips detection.
- `ParseResult.source: { format, pages?, layout }` reports what was read; `layout` is `"single-column"`, `"multi-column"` or `"unknown"`.
- `extractText(input)` and `detectFormat(data, filename?)` exported as standalone utilities, with the types `DocumentInput`, `ExtractedDocument`, `InputFormat`, `DetectedLayout`, `DetectedFormat`, `ExtractionSource`, `ResumeInput` and `TextItem`.
- Error codes `UNSUPPORTED_INPUT` (images, legacy `.doc`, ZIPs that are not DOCX, unrecognized bytes), `NO_TEXT_LAYER` (PDF without text: scanned or image-only) and `EXTRACTION_FAILED` (corrupt or password-protected PDF, broken DOCX).
- CLI: `npx @cvparse/core ./cv.pdf` and `./cv.docx` work; the format is detected from the bytes, and stdin may be bytes (`cat cv.pdf | npx @cvparse/core -`). For non-text input the CLI prints `info: read pdf, 2 page(s), multi-column layout` to stderr. Exit code `2` for images, legacy office formats, empty input, unsupported bytes and `NO_TEXT_LAYER`; `1` for `EXTRACTION_FAILED` and provider errors.
- Synthetic PDF and DOCX fixtures under `test/fixtures/pdf` and `test/fixtures/docx`, generated deterministically by `npm run fixtures:pdf` (`pdf-lib`) and `npm run fixtures:docx` (`docx`) from `scripts/fixtures/`.

### Changed

- `parseResume(text, options)` is now `parseResume(input, options)` with the widened `ResumeInput` type. Passing a string behaves as before.
- `unpdf` and `mammoth` are runtime dependencies, loaded on demand (dynamic import) so that passing a string never loads them. `npx @cvparse/core ./cv.pdf` must work out of the box; OCR stays an adapter.
- Extraction warnings are added to `ParseResult.warnings` with an `extract:` prefix.
- `CVPARSE_VERSION` is injected at build time from `package.json` instead of being duplicated in source.
- Releases are cut with `npm run release:patch|minor|major`, which bumps the version, dates the Unreleased changelog section, commits and tags in one step.

## [0.0.2] - 2026-10-01

### Changed

- Releases are now published from GitHub Actions via npm Trusted Publishing, with provenance attestations. No functional changes.
- CLI messages and docs no longer hardcode the preview version number.

## [0.0.1] - 2026-09-30

Initial preview release. Plain-text input only.

### Added

- Published on npm as `@cvparse/core`; the CLI binary is `cvparse`.
- `parseResume(text, options)`: extracts a structured resume from plain CV text using the Vercel AI SDK's structured output (`generateText` with `Output.object` and a JSON Schema derived from the Zod schema) and any AI SDK `LanguageModel`. Returns `{ resume, usage, warnings }`.
- `ParseOptions` with `model`, optional `language` (`'auto' | 'es' | 'en'`), optional `instructions`, optional `abortSignal` and optional `maxRetries`.
- `CvparseError` (with `CvparseError.is()` type guard) thrown by `parseResume`, with `code` one of `INVALID_INPUT`, `NO_OBJECT_GENERATED`, `PROVIDER_ERROR`, `VALIDATION_ERROR`, plus `statusCode` and `rawText` when available and the original error as `cause`.
- Zod schema compatible with JSON Resume v1 (`basics`, `work`, `volunteer`, `education`, `awards`, `certificates`, `publications`, `skills`, `languages`, `interests`, `references`, `projects`). All fields optional and null-tolerant; dates as `YYYY`, `YYYY-MM` or `YYYY-MM-DD` strings.
- `x_cvparse` extension block: `normalizedSkills`, LATAM-friendly structured `location` (`countryCode`, `adminRegion`, `city`, `raw`), `detectedLanguage`, `confidenceNotes`.
- Deterministic post-processing (`normalizeResume`): `normalizeDate` turns es/en/pt month names, ongoing markers ("actualidad", "presente", "current") and day-first numeric dates into ISO strings, with a warning per date it cannot normalize; `detectLanguage` is a small heuristic used as a hint when `language` is `auto`.
- Exported schemas and types: `ResumeSchema`, `Resume`, `BasicsSchema`, `WorkSchema`, `EducationSchema`, `SkillSchema`, `ExtensionSchema`, `ExtensionLocationSchema` and the remaining section schemas; `ResumeExtractionSchema`, `RESUME_JSON_SCHEMA` and `RESUME_EXTRACTION_JSON_SCHEMA` (the JSON Schema sent to the model); `buildSystemPrompt` / `buildUserPrompt`.
- `CVPARSE_VERSION` constant.
- `cvparse` CLI (`npx @cvparse/core ./cv.txt`, or `-` for stdin) with `--provider ollama|openai|openai-compatible`, `--model`, `--base-url`, `--api-key` (or env `CVPARSE_API_KEY`; `OPENAI_API_KEY` is used for `--provider openai` only), `--lang es|en|auto`, `--pretty`, `-h/--help` and `-v/--version`. Defaults to Ollama at `http://localhost:11434/v1`. The resume JSON goes to stdout; warnings, help and errors to stderr. Exit code `0` on success, `1` when extraction fails, `2` on usage errors (including `.pdf`/`.docx`/image inputs, which 0.0.1 cannot read). Built on Node's `util.parseArgs`, no CLI framework.
- ESM-only package targeting Node >= 22. Runtime dependencies: `ai`, `zod`, `@ai-sdk/openai-compatible`.
- English README with Spanish mirror (`README.es.md`), contributing guide, code of conduct (Contributor Covenant 2.1), security policy, MIT license, roadmap.

[Unreleased]: https://github.com/Nikire/cvparse/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Nikire/cvparse/compare/v0.0.2...v0.1.0
[0.0.2]: https://github.com/Nikire/cvparse/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/Nikire/cvparse/releases/tag/v0.0.1
