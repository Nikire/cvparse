# Importing CVs into a dataset

`eval/import` turns a folder of dropped-in CVs into dataset entries the runner can score. It is
written for the private set (`eval/private`, gitignored, real people) but works on any dataset
directory that follows the `eval/types.ts` layout.

```
inbox/  →  npm run eval:import  →  files/<id>.<ext>  +  text/<id>.txt  +  truth/<id>.json (draft)  +  manifest.json
```

## Flow

1. **Drop files into `<dataset>/inbox/`.** Prefix the name with the source so provenance is
   recorded: `consent-…`, `linkedin-…`, `public-<cc>-…` (`cc` = ISO country, e.g. `public-mx-…`),
   `fake-…`, `fixture-…`. Anything else is imported with source `unknown`.
2. **Import.** Ollama by default (`llama3.1`); any CLI provider works.

   ```sh
   npm run eval:import -- --dataset eval/private
   npm run eval:import -- --dataset eval/private --dry-run      # plan only: ids, formats, layouts
   npm run eval:import -- --dataset eval/private --provider openai --model gpt-4o-mini
   ```

   In PowerShell `npm run … --` drops the flags; run the script directly:
   `node node_modules/tsx/dist/cli.mjs eval/import/index.ts --dataset eval/private`.

   For each inbox file the tool:
   - detects the format from the bytes (`detectFormat`), rejects unsupported ones (left in the inbox);
   - assigns a stable id `<source>-<cc>-NNN` (`consent-xx-001`, `public-mx-003`), continuing after
     the highest number already in the manifest for that prefix;
   - extracts the text (Tesseract OCR for images and scanned pages) to `text/<id>.txt` and records
     the layout (`single-column`, `two-column`, `scanned`) and language (`es`, `en`, `pt`, `mixed`
     when Spanish and English section headings coexist, else `unknown`);
   - runs `parseResume` (temperature 0, today as reference date) and writes the scored subset of
     the result to `truth/<id>.json` with `"_review": { "status": "draft", "source": "<model>",
     "warnings": [...] }`. An existing truth file is never overwritten;
   - moves the file to `files/<id>.<ext>` and appends the manifest entry (sorted by id) with
     `source`, `pii`, `acquired` (file date), `originalName`, `country` (`XX` unless the prefix
     had one) and `tags` (`real`, the source, `ocr`, `two-columns`).

   A failure in extraction or in the model call leaves that file in the inbox and reports it;
   re-run after fixing the cause.
3. **Review the drafts.** Open `truth/<id>.json` next to `text/<id>.txt` (or the original file),
   fix the fields, then set `_review.status` to `"reviewed"` (or delete `_review`). Fix `country`,
   `dateStyles` and `tags` in the manifest while you are there. Until then the runner skips the
   entry (`skipped: "draft-truth"`), so a model's own output never silently becomes its ground truth.
4. **Run.**

   ```sh
   npm run eval -- --dataset eval/private --ocr tesseract                 # reviewed entries only
   npm run eval -- --dataset eval/private --ocr tesseract --include-drafts  # drafts too (sanity check)
   ```

## Rules for the private set

See `eval/private/README.md`: nothing from there goes into `eval/dataset/` or into any published
file. Publish aggregate scores only. This tool contains no CV data and is safe to commit.
