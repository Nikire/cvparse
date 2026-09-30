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

Before opening a PR, run `npm run lint && npm run typecheck && npm test`. `prepublishOnly` runs the same checks plus the build.

To try the CLI from source without building, use `tsx`:

```bash
npx tsx src/cli.ts ./path/to/cv.txt --pretty
```

## Project layout

```
src/
  index.ts            public API: parseResume, schemas, types, errors, CVPARSE_VERSION
  parse.ts            parseResume: prompt, AI SDK call, normalization, validation
  prompt.ts           system / user prompt builders
  errors.ts           CvparseError and its error codes
  types.ts            ParseOptions, ParseResult, ParseUsage, ParseLanguage
  version.ts          CVPARSE_VERSION
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
test/
  *.test.ts           Vitest suites (unit, CLI, fake HTTP server end-to-end)
  helpers.ts          fixture loader and sample extractions
  fixtures/           synthetic CVs used by tests (see below)
docs/
  ROADMAP.md
```

## Adding a fixture CV

Fixtures are how cvparse gets better at real-world layouts, and they are also the most sensitive thing in the repository. The rules are strict:

1. **Synthetic only.** Every fixture must be invented. Never commit a real person's CV, even anonymized, even your own, even with permission. Names, emails, phone numbers, addresses, employers, universities and dates must all be made up. Use `example.com` domains and obviously fake phone numbers (`+54 11 5555 0100`, `+34 600 000 000`).
2. **Make it plausible.** A fixture is useful only if it looks like something a candidate would actually send: realistic section headings, realistic messiness. Copy the *structure* of the hard cases you see in practice, not the content.
3. **Name the difficulty.** Fixtures live flat in `test/fixtures/` as `cv-<lang>-<case>.txt`, where `<lang>` is the ISO 639-1 code of the CV's main language: `cv-es-backend.txt`, `cv-es-two-column-canva.txt`, `cv-en-functional.txt`.
4. **Pair it with a test.** Nothing loads a fixture automatically. Load it with `fixture("cv-es-....txt")` from `test/helpers.ts` inside the test that needs it, and assert on the fields that matter for the case you are adding (use `toMatchObject` for a subset). A fixture-driven harness with `.expected.json` files and a scoring script is planned for 0.3 (see the roadmap); until then, expectations live in the test code.
5. **Text only, for now.** Until 0.1 ships PDF/DOCX extraction, fixtures are `.txt`. When binary fixtures arrive, the same rules apply, and every PDF or DOCX must be generated from synthetic content (not exported from a real document with fields replaced; metadata leaks).
6. **Spanish is welcome and needed.** Fixtures in Spanish (Spain and every LATAM variant), Portuguese, and mixed Spanish/English are the ones most likely to expose bugs. Please add them.

If you are unsure whether something counts as personal data, it does. Ask in the PR before committing it.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(schema): add x_cvparse.location.region
fix(cli): exit with code 2 on missing input file
docs: clarify plain-text-only status in README
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
- [ ] No new runtime dependencies without discussing it in an issue first. The runtime dependency list is deliberately short: `ai`, `zod`, `@ai-sdk/openai-compatible`.
- [ ] Commit messages follow Conventional Commits.

Small PRs get reviewed quickly. Large PRs get reviewed eventually. If you are planning something big, open an issue first so we can agree on the approach.

## Reporting "my CV doesn't parse"

These are the most valuable issues we get, and also the hardest to act on without the right information. Please include:

1. **An anonymized, reproducible sample.** Do not paste the real CV. Rewrite it with invented names, contacts and employers, but keep the exact structure that breaks: the same section order, the same date formats, the same weird bullet characters, the same column layout (as text, until PDF support ships). If the problem is a PDF or DOCX, describe how it was produced (Canva, Word, LaTeX, scanned) and, if you can, attach a synthetic file built the same way.
2. **The expected JSON.** The `Resume` object you believe is correct for that sample, or at least the fields that came out wrong and what they should be.
3. **The actual JSON** cvparse produced, plus the `warnings` array.
4. **Provider and model**, e.g. `ollama / llama3.1`, `openai / gpt-4o-mini`, and the `--lang` value if you set one.
5. **cvparse version** (`npm ls cvparse`) and Node version (`node -v`).

Use the **Parse quality** issue template. Issues that contain what looks like real personal data will be edited or deleted by a maintainer to protect the person involved; please do not make us do that.

## Releases

Maintainers only. Releases follow [Semantic Versioning](https://semver.org/). While the major version is 0, minor bumps may contain breaking changes; they are always listed in `CHANGELOG.md`.

### Repository settings checklist (maintainers)

Things the files in this repository assume but GitHub does not set up on its own:

- Enable **Discussions** (the issue chooser links to it).
- Create the labels used by the issue templates and Dependabot: `bug`, `enhancement`, `parse-quality`, `dependencies`, `npm`, `github-actions`.
- Add the `NPM_TOKEN` secret for the release workflow, or configure npm trusted publishing.

## Questions

Open a discussion or an issue. There is no chat server yet; if the project grows enough to need one, it will be linked from the README.
