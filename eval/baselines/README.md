# Baselines

Rule-based CV parsers that cvparse is benchmarked against. Each module exports
`createSystem(): Promise<EvalSystem>` (see `eval/types.ts`) and maps the baseline's own output
into the `GroundTruth` subset the scorer evaluates.

```sh
npm run eval:baselines:setup   # fetches both baselines into eval/.cache/ (gitignored)
npx vitest run eval/baselines  # mapping unit tests + smoke tests (skipped without setup)
```

| Baseline | Version | License | How we get it | Supports |
| --- | --- | --- | --- | --- |
| [open-resume](https://github.com/xitanggg/open-resume) parser | commit `4f8255a2c763479837f69f1dccf2a3338730cd79` (`main`, 2026-10-02) | AGPL-3.0 | `git fetch --depth 1` of the pinned commit into `eval/.cache/open-resume/` | `pdf` |
| [resume-parser](https://www.npmjs.com/package/resume-parser) (perminder-klair) | `1.1.0` (last release, 2022) | ISC | `npm pack` + `npm install` into `eval/.cache/resume-parser/` | `pdf`, `docx`, `text` (via our text extraction) |

The pinned versions live in `setup.ts` (`OPEN_RESUME_COMMIT`, `RESUME_PARSER_VERSION`). The
adapters refuse to run if the cache holds a different version.

## Why open-resume is fetched, not vendored

open-resume is AGPL-3.0; cvparse is MIT. Copying its code into this repo (or publishing it in the
npm package) would put AGPL code in an MIT codebase. So nothing of it is committed: the setup
script clones it into the gitignored cache and the adapter imports it at runtime, only for the
benchmark. Nothing under `eval/` ships in the npm package.

To make their modules loadable from Node without Next.js:

- **Path aliases.** Their files import `lib/...` (tsconfig `baseUrl`). Setup copies the parser
  modules (`src/app/lib/parse-resume-from-pdf/**` minus `read-pdf.ts` and `index.ts`, plus
  `redux/types.ts` and `deep-clone.ts`) into `eval/.cache/open-resume-node/` and rewrites only the
  import specifiers to relative `.ts` paths. The cloned checkout is left untouched; the code is
  otherwise unchanged.
- **Redux shim.** `extract-skills.ts` imports `initialFeaturedSkills` from `redux/resumeSlice.ts`,
  which pulls in `@reduxjs/toolkit`. Setup writes a one-constant replacement with the same value.
- **PDF reading.** Their `read-pdf.ts` uses the browser pdf.js worker. `readPdfTextItems` in
  `open-resume.ts` is a Node port producing the same `TextItem` shape (text, x, y, width, height,
  original font name via `commonObjs`, `hasEOL`, same filtering and `-­‐` fix-up), using the
  pdf.js bundled with unpdf (they pin `pdfjs-dist ^3.7`). Steps 2-4 (`groupTextItemsIntoLines`,
  `groupLinesIntoSections`, `extractResumeFromSections`) are their code.

A smoke test feeds a small English one-column PDF through the whole pipeline and checks that name,
email, job, school and skills come out, so poor results on Spanish CVs are their rules, not the port.

## Why resume-parser is not a devDependency

Its dependency tree (`textract` → `got@5` with `engines: node <7`, `request`) fails to install
under this repo's `engine-strict`, and would add deprecated packages to our lockfile. Setup
installs it, with its own dependencies, in the cache instead.

## Fairness notes

- **Dates use our normalizer.** Rule-based parsers return date text verbatim ("Jun 2022 - Present").
  We convert it with cvparse's `splitDateRange` / `normalizeDate`, so the comparison measures whether
  the right date text was extracted, not date formatting. A single date goes to `startDate` for work
  and `endDate` for education (graduation date); an ongoing end becomes `endDate: null`.
- **resume-parser gets our text.** Its own reader goes through `textract`, which needs the
  `pdftotext` (poppler) binary for PDFs. To keep the benchmark portable it is fed the reading-order
  text from cvparse's `extractText` (two-column ordering included), prepared exactly like its
  `processing.js` does, and passed to its `parser.parse`. It therefore benefits from our PDF/DOCX
  reading. Images are not supported (that would need our OCR too).
- **No network.** resume-parser downloads GitHub/LinkedIn profile pages it finds in the CV; those
  handlers are removed before parsing.
- **Mapping only reshapes.** Skills: open-resume's `featuredSkills` + `descriptions`, and
  resume-parser's `skills` section text, are split on commas, bullets, semicolons and pipes, with a
  leading "Category:" label dropped. Languages: open-resume has no languages section (empty);
  resume-parser's `languages` section text is split per line into language / fluency.
  resume-parser returns work and education only as raw section text, so they stay empty: turning
  that text into entries would be us parsing on its behalf. Locations written as one string become
  `{ city, region }` from the comma-separated parts.
- **Unsupported formats are skipped, not zeroed.** open-resume reads only PDFs, so its 16 DOCX and
  4 image CVs are marked `skipped: "unsupported-format"` and left out of its scores. The report
  shows coverage (CVs attempted / 60) and a "PDF only" overall on the 40 PDFs every system reads.
  resume-parser likewise skips the 4 images; its 2 image-only PDFs fail (no text layer) and do
  count, as they would for any system without OCR.
- **English-only rules.** Both match section headings by English keywords (open-resume:
  "experience", "education", "skill"...; resume-parser: "experience", "education", "skills",
  "languages"...). On Spanish CVs ("EXPERIENCIA LABORAL", "FORMACIÓN", "HABILIDADES", "IDIOMAS")
  most sections are not recognized. That is the gap this benchmark exists to show.
