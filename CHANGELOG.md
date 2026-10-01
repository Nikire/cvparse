# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the major version is 0, minor releases may contain breaking changes; they are called out explicitly.

## [Unreleased]

### Changed

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

[Unreleased]: https://github.com/Nikire/cvparse/compare/v0.0.2...HEAD
[0.0.2]: https://github.com/Nikire/cvparse/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/Nikire/cvparse/releases/tag/v0.0.1
