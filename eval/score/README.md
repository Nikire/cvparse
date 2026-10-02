# Scoring rules

`scoreEntry(truth, predicted)` compares one prediction with its ground truth and returns, per
field, true positives (TP), false positives (FP) and false negatives (FN) plus precision, recall,
F1 and support (`TP + FN`). `aggregate(entries)` micro-averages: it sums TP/FP/FN per field over
all CVs and recomputes P/R/F1.

`overallF1` is the plain mean of the per-field F1 values over the **common fields**: every field
below except `education.level` (10 fields). cvparse and the baselines are therefore averaged over
the same fields; `education.level` is reported separately as a cvparse-only diagnostic.

A field with nothing on either side (no truth, no prediction) is omitted, not scored as 1 or 0.
A failed CV (`predicted = null`) scores every truth item as FN.

A CV in a format the system cannot read (`EvalSystem.supports`, e.g. DOCX and images for
open-resume) is **skipped**: the runner marks it `skipped: "unsupported-format"`, it is left out
of every field score, and it shows up as lower **coverage** (CVs attempted / CVs in the dataset)
instead of as zeros. The report also gives a **PDF only** overall on the PDF subset, which every
system reads, so systems can be compared on equal inputs.

## Text normalization

Unicode NFD, diacritics removed, lowercase, punctuation replaced by spaces, whitespace collapsed.
Emails keep `@ . + _ -`; skills keep `+ # .` (so `C++`, `C#` and `C` stay different).

## Scalar fields (`basics.*`)

| Field | Match rule |
| --- | --- |
| `basics.name` | Token-set Jaccard >= 0.8. Word order and accents are ignored and the particles `de`, `del`, `la`, `las`, `los`, `y` are dropped ("Juan de la Cruz Pérez" = "Juan Cruz Pérez"). "Juan Pérez López" vs "Juan Carlos Pérez López" = 0.75 is a miss. |
| `basics.email` | Exact after normalization. |
| `basics.phone` | See [Phones](#phones). |
| `basics.location` | See [Locations](#locations). |

Counting: match → TP; wrong value → FP + FN; missing prediction → FN; prediction without truth → FP.

### Phones

- Each side is split into numbers on `/`, `,`, `;` and `|` (fragments with fewer than 6 digits
  are dropped); the field matches when **any** truth/predicted pair matches.
- A number written with a leading `+` or `00` has its calling code separated (longest match from
  a table of Spain, Latin American and a few other codes). A leading trunk `0` of the rest is dropped.
- Both numbers with a calling code: the codes and the **full** national digit strings must be
  equal (`+54 9 11 4567-1234` ≠ `+54 11 4567-1234`).
- Only one with a calling code: the last 8 digits are compared (`+54 9 11 4567-1234` =
  `11 4567-1234`).
- Neither: the full digit strings are compared.

### Locations

- City from `basics.location.city`, falling back to `x_cvparse.location.city`; country code
  likewise. The country code must agree only when both sides have one.
- City aliases are mapped first: `CABA`, `Capital Federal`, `Ciudad Autónoma de Buenos Aires`,
  `Ciudad de Buenos Aires` → `buenos aires`; `CDMX`, `Ciudad de México`, `México D.F.` →
  `ciudad de mexico`; `Bogotá D.C.` → `bogota`. The truth for a Buenos Aires CV is city "Buenos
  Aires", region "CABA"; a parser that writes the official name of the city is not wrong.
- Then the city matches when every truth token appears among the predicted tokens (token subset):
  "Medellín" matches "Medellín, Antioquia"; "San José" does not match "San Juan".

## Entries (`work.entries`, `education.entries`)

Similarity between a truth and a predicted entry is the mean token Jaccard of:

- work: company (`name`) and `position`;
- education: `institution` and `studyType + area`.

Tokens exclude articles and legal suffixes (`de`, `la`, `the`, `S.A.`, `S.R.L.`, `SL`, `Inc`, ...).
A component empty on both sides is left out of the mean. Pairs are assigned one-to-one to
maximize total similarity (exact search up to 16 predicted entries, greedy beyond; deterministic),
and only pairs with similarity >= 0.5 match. TP = matched pairs, FP = unmatched predicted entries,
FN = unmatched truth entries.

### Certificates count as education

The truth keeps short courses, bootcamps and diplomas in `education[]` (as printed under
"Formación" / "Cursos"). JSON Resume also has `certificates[]`, and cvparse files short courses
there. Before matching education, the scorer appends every predicted `certificates[]` item to the
predicted education list as `{ institution: issuer, studyType: name, endDate: date }`. A course
filed under certificates therefore still matches its truth entry; a course listed in both places
costs one FP. For `education.level`, entries that came from certificates count as level `course`.
Baselines that produce no certificates are unaffected.

## Dates (`work.dates`, `education.dates`)

Each matched pair contributes its date slots:

- Compared at the truth's precision: truth `2021-03` matches predicted `2021-03` or `2021-03-15`;
  predicted `2021` (less precise) is a mismatch. Mismatch → FP + FN. Missing prediction → FN.
- "Ongoing" phrases count as no end date: `present`, `presente`, `actual`, `actualidad`,
  `actualmente`, `hoy`, `hasta hoy`, `now`, `current`, `la fecha`, `a la fecha`, `hasta la fecha`,
  `en curso`, `hasta la actualidad`.
- **Ongoing end date.** When the truth has a start date and no end date (ongoing), the end slot is
  a TP only if the prediction has no end date **and has a start date** for that entry. A predicted
  entry with no dates at all scores the end slot as FN, so a parser cannot earn "ongoing" credit by
  extracting nothing. A predicted end date for an ongoing truth is FP + FN.
- **Single-date entries.** Short courses and graduation-only education carry one date in the truth,
  stored as `endDate` with no `startDate`. That slot is compared with the predicted `endDate`, or,
  when the prediction has no `endDate`, with its `startDate` (a single date may land in either
  slot). If the prediction has both, the extra `startDate` is one FP.
- A truth entry with no dates at all: every predicted date is FP.
- Unmatched truth entries add their date slots as FN (2 for an entry with a start date, 1 for a
  single-date entry), so a system that misses entries cannot get a high date score. Unmatched
  predicted entries are already penalized in `*.entries` and add nothing here.

## Education level (`education.level`, cvparse-only diagnostic)

`x_cvparse.educationLevels[i].level` on matched education pairs (exact enum match). Truth levels
of unmatched truth entries are FN. Scored only when the prediction carries `x_cvparse` (the runner
forces it on for cvparse, so a failed cvparse CV counts as FN). Baselines never produce it, so the
field is absent from their results.

It is **not** part of `overallF1`. The dataset's degree vocabulary was written alongside cvparse's
degree normalizer (`src/normalize/education.ts`), so this field mostly checks that the model copies
the degree text and the normalizer maps it; it is not an independent measure.

## Skills and languages (set F1)

- `skills`: set of every `skills[].keywords[]` item, plus `skills[].name` for groups without
  keywords. Exact match after normalization; no substring or synonym matching (`Node` ≠
  `Node.js`, `Postgres` ≠ `PostgreSQL`).
- `languages`: `languages[].language` mapped to ISO 639-1 with a small table of Spanish, English
  and Portuguese names (`Inglés`, `ingles`, `English` → `en`; `Castellano` → `es`; ...). The first
  recognized word wins (`Inglés (C1)` → `en`); unknown names are compared as normalized text.

## Reproducibility

The runner caches predictions in `eval/.cache/predictions/<system>/<id>.json`. The cache key
includes the system details (model, provider, OCR engine, temperature, `referenceDate`, Ollama
version and model digest, tesseract.js version, baseline version or commit), the dataset version
and a hash of `manifest.json` + every truth file, the cvparse git commit (`git rev-parse HEAD`)
and a hash of `src/**/*.ts`, so editing the prompt or the truth invalidates cached predictions.
Display-only details (hardware, command line, Node version) are recorded but not keyed. Each
result records the exact command it was produced with (`system.details.command`).

Runs restricted with `--only` or `--limit` are written to `eval/results/partial/` and never
overwrite a full-dataset result; `npm run eval:report` only reports results that cover every CV in
the manifest.
