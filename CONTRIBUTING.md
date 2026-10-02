# Contributing to cvparse

Thanks for taking the time. This document covers local setup, the scripts you will use, how to add test fixtures, and what a good pull request or issue looks like.

By participating you agree to the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Setup

Requirements:

- Node.js **>= 22**. CI tests on Node 22 and 24; `.node-version` pins the version for local development.
- npm (the lockfile is `package-lock.json`; do not add a pnpm, yarn or bun lockfile).
- For running the CLI or integration tests against a real model: [Ollama](https://ollama.com) with a model pulled, e.g. `ollama pull llama3.1`. Unit tests do not need a model.

```bash
git clone https://github.com/Nikire/cvparse.git
cd cvparse
npm ci
```

## Scripts

| Script | What it does |
| --- | --- |
| `npm run build` | Bundle `src/` to `dist/` with tsup (ESM + `.d.ts`). |
| `npm run dev` | Same as build, in watch mode. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm test` | Run the test suite once with Vitest. |
| `npm run test:watch` | Vitest in watch mode. |
| `npm run lint` | Biome lint and format check. |
| `npm run lint:fix` | Apply Biome's safe fixes. |
| `npm run format` | Format with Biome. |
| `npm run release:check` | `npm pack --dry-run`, to see exactly what would be published. |
| `npm run fixtures:pdf` | Regenerate the PDF fixtures in `test/fixtures/pdf/` with `pdf-lib` (`scripts/fixtures/make-pdf-fixtures.mjs`). |
| `npm run fixtures:docx` | Regenerate the DOCX fixtures in `test/fixtures/docx/` with `docx` (`scripts/fixtures/make-docx-fixtures.mjs`). |
| `npm run fixtures:image` | Regenerate the OCR fixtures (`test/fixtures/image/*.png`, `*.jpg` and `test/fixtures/pdf/scanned-es.pdf`) with `@napi-rs/canvas` and `pdf-lib` (`scripts/fixtures/make-image-fixtures.mjs`). |

Before opening a PR, run `npm run lint && npm run typecheck && npm test`. `prepublishOnly` runs the same checks plus the build.

The OCR unit tests use a fake Tesseract worker and a fake Textract client, so they need no network or AWS account. One integration test runs the real tesseract.js on a two-column image; it is skipped unless you set `CVPARSE_OCR_TESTS=1`, because the first run downloads the Spanish traineddata (a few MB) from the jsDelivr CDN into your temp directory:

```bash
CVPARSE_OCR_TESTS=1 npx vitest run test/ocr-tesseract.test.ts
```

Run it when you change the Tesseract adapter or the layout code.

To try the CLI from source without building, use `tsx`:

```bash
npx tsx src/cli.ts ./path/to/cv.pdf --pretty
```

### Fixtures

The PDF and DOCX files under `test/fixtures/` are committed, but they are generated, not hand-made: every one of them comes from a script in `scripts/fixtures/` that builds it from synthetic content. If you change a script, run `npm run fixtures:pdf` or `npm run fixtures:docx` and commit the result. The scripts pin metadata dates, zip timestamps and shape ids so the output is byte-for-byte deterministic; running them twice must produce no diff. Keep it that way, and never replace a generated fixture with a file exported from a real document.

The OCR fixtures (`npm run fixtures:image`) are the exception: text rendering depends on the fonts installed on your machine, so the output is deterministic per machine but not across machines. The committed files are the reference; regenerate them only when the content changes, and commit all three files together.

## Project layout

```
src/
  index.ts            public API: parseResume, extractText, schemas, types, errors, CVPARSE_VERSION
  parse.ts            parseResume: extraction, prompt, AI SDK call, normalization, validation
  prompt.ts           system / user prompt builders
  errors.ts           CvparseError and its error codes
  types.ts            ResumeInput, ParseOptions, ParseResult, ExtractionSource, ParseLanguage
  version.ts          CVPARSE_VERSION
  vision.ts           vision mode: images / rendered PDF pages for multimodal models
  extract/
    index.ts          extractText, detectFormat (magic bytes), DocumentInput; lazy-loads pdf/docx/ocr
    types.ts          ExtractedDocument, InputFormat, DetectedLayout, TextItem
    pdf.ts            pdf.js (unpdf) text items -> reading-order text
    layout.ts         recursive XY-cut: gutter / band detection, pure and unit-tested
    docx.ts           mammoth HTML -> text, minimal zip reader, DrawingML text-box fallback
    ocr.ts            recognizeWithAdapter: runs an OcrAdapter, orders items, collects confidence
    raster.ts         renderPdfPages: scanned PDF pages -> PNG via @napi-rs/canvas (optional peer)
  ocr/
    types.ts          OcrAdapter contract
    tesseract.ts      createTesseractAdapter (@cvparse/core/ocr/tesseract, peer tesseract.js)
    textract.ts       createTextractAdapter (@cvparse/core/ocr/textract, peer @aws-sdk/client-textract)
  schema/
    index.ts          re-exports
    resume.ts         Zod schemas (JSON Resume + x_cvparse extensions) and derived JSON Schema
  normalize/
    dates.ts          normalizeDate: month names, ongoing markers, numeric dates -> ISO
    language.ts       detectLanguage heuristic
    resume.ts         normalizeResume: applies the passes above to a raw extraction
  cli.ts              bin entry (shebang + shim over cli/main.ts)
  cli/
    args.ts           util.parseArgs wiring, USAGE text, defaults
    main.ts           testable main(argv, env, io) returning the exit code
    provider.ts       createOpenAICompatible model factory
    ocr.ts            --ocr engine -> adapter, imported lazily
test/
  *.test.ts           Vitest suites (unit, CLI, fake HTTP server end-to-end)
  helpers.ts          fixture loader and sample extractions
  fixtures/           synthetic CVs used by tests (see below); pdf/, docx/ and image/ are generated
scripts/
  fixtures/           generators for the PDF, DOCX and image fixtures (npm run fixtures:pdf|docx|image)
docs/
  ROADMAP.md
  ocr.md              OCR and vision guide
```

## Adding a fixture CV

Fixtures are how cvparse gets better at real-world layouts, and they are also the most sensitive thing in the repository. The rules are strict:

1. **Synthetic only.** Every fixture must be invented. Never commit a real person's CV, even anonymized, even your own, even with permission. Names, emails, phone numbers, addresses, employers, universities and dates must all be made up. Use `example.com` domains and obviously fake phone numbers (`+54 11 5555 0100`, `+34 600 000 000`).
2. **Make it plausible.** A fixture is useful only if it looks like something a candidate would actually send: realistic section headings, realistic messiness. Copy the *structure* of the hard cases you see in practice, not the content.
3. **Name the difficulty.** Fixtures live flat in `test/fixtures/` as `cv-<lang>-<case>.txt`, where `<lang>` is the ISO 639-1 code of the CV's main language: `cv-es-backend.txt`, `cv-es-two-column-canva.txt`, `cv-en-functional.txt`.
4. **Pair it with a test.** Nothing loads a fixture automatically. Load it with `fixture("cv-es-....txt")` from `test/helpers.ts` inside the test that needs it, and assert on the fields that matter for the case you are adding (use `toMatchObject` for a subset). A fixture-driven harness with `.expected.json` files and a scoring script is planned for 0.3 (see the roadmap); until then, expectations live in the test code.
5. **Binary fixtures are generated.** PDF and DOCX fixtures live in `test/fixtures/pdf/` and `test/fixtures/docx/` and are produced by the scripts in `scripts/fixtures/` (see [Fixtures](#fixtures)). Add a new case to the script, not a file exported from a real document with fields replaced: metadata leaks, and the output must stay byte-deterministic.
6. **Spanish is welcome and needed.** Fixtures in Spanish (Spain and every LATAM variant), Portuguese, and mixed Spanish/English are the ones most likely to expose bugs. Please add them.

If you are unsure whether something counts as personal data, it does. Ask in the PR before committing it.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(schema): add x_cvparse.location.region
fix(cli): exit with code 2 on missing input file
docs: document PDF and DOCX input in README
test(fixtures): add cv-es-two-column-canva
chore: bump ai to 7.0.130
```

Common types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `chore`, `ci`. Use `!` or a `BREAKING CHANGE:` footer for anything that changes the public API or the output schema.

Do not add attribution trailers or "generated by" lines to commits.

## Pull request checklist

- [ ] The change is scoped to one thing. Unrelated refactors go in a separate PR.
- [ ] `npm run lint`, `npm run typecheck` and `npm test` pass locally.
- [ ] New behaviour has a test. Schema changes have a fixture that exercises them.
- [ ] Fixtures are synthetic (see above).
- [ ] Public API or schema changes are reflected in `README.md`, `README.es.md` and `CHANGELOG.md` under **Unreleased**.
- [ ] No new runtime dependencies without discussing it in an issue first. The runtime dependency list is deliberately short: `ai`, `zod`, `@ai-sdk/openai-compatible`, plus `unpdf` and `mammoth`, which are loaded on demand.
- [ ] Commit messages follow Conventional Commits.

Small PRs get reviewed quickly. Large PRs get reviewed eventually. If you are planning something big, open an issue first so we can agree on the approach.

## Reporting "my CV doesn't parse"

These are the most valuable issues we get, and also the hardest to act on without the right information. Please include:

1. **An anonymized, reproducible sample.** Do not paste the real CV. Rewrite it with invented names, contacts and employers, but keep the exact structure that breaks: the same section order, the same date formats, the same weird bullet characters, the same column layout. If the problem is a PDF or DOCX, describe how it was produced (Canva, Word, LaTeX, scanned), include the `info:` line and any `extract:` warnings the CLI printed, and, if you can, attach a synthetic file built the same way (or the output of `extractText` on it, with the content rewritten).
2. **The expected JSON.** The `Resume` object you believe is correct for that sample, or at least the fields that came out wrong and what they should be.
3. **The actual JSON** cvparse produced, plus the `warnings` array.
4. **Provider and model**, e.g. `ollama / llama3.1`, `openai / gpt-4o-mini`, and the `--lang` value if you set one.
5. **cvparse version** (`npm ls @cvparse/core`) and Node version (`node -v`).

Use the **Parse quality** issue template. Issues that contain what looks like real personal data will be edited or deleted by a maintainer to protect the person involved; please do not make us do that.

## Releases

Maintainers only. Releases follow [Semantic Versioning](https://semver.org/). While the major version is 0, minor bumps may contain breaking changes; they are always listed in `CHANGELOG.md`.

The version lives only in `package.json`; `CVPARSE_VERSION` is injected at build time. To cut a release:

1. Make sure the `## [Unreleased]` section of `CHANGELOG.md` lists the changes (the release script refuses to run if it is empty).
2. Run `npm run release:check` to see the tarball contents and validate the changelog.
3. Run `npm run release:patch`, `release:minor` or `release:major`. This runs lint, typecheck and tests, bumps `package.json`, turns the Unreleased section into a dated `## [x.y.z]` section, commits as `release: vx.y.z` and creates the `vx.y.z` tag.
4. Run `git push --follow-tags`. The `Release` workflow publishes to npm with provenance and creates the GitHub Release.

### Repository settings checklist (maintainers)

Things the files in this repository assume but GitHub does not set up on its own:

- Enable **Discussions** (the issue chooser links to it).
- Create the labels used by the issue templates and Dependabot: `bug`, `enhancement`, `parse-quality`, `dependencies`, `npm`, `github-actions`.
- Configure npm Trusted Publishing for `@cvparse/core` (publisher: GitHub Actions, repo `Nikire/cvparse`, workflow `release.yml`). No `NPM_TOKEN` secret is used.

## Questions

Open a discussion or an issue. There is no chat server yet; if the project grows enough to need one, it will be linked from the README.
