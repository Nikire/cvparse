# OCR: images and scanned PDFs

A CV that is a photo, a scan, or a PDF without a text layer has no text for cvparse to read. Without OCR configured, `parseResume` rejects these inputs with `CvparseError` code `OCR_REQUIRED`. You have two ways to handle them, set with `ParseOptions.ocr`:

| | OCR adapter | Vision mode |
| --- | --- | --- |
| Option | `ocr: createTesseractAdapter()` / `createTextractAdapter()` / your own | `ocr: "vision"` |
| What happens | An OCR engine turns the image into positioned text. cvparse works out the reading order (columns, sidebars) the same way it does for PDFs, then sends the text to `model`. | The page images go straight to `model`, which reads them itself. |
| Model requirement | Any model | A vision-capable model (GPT-4o, Claude, Gemini, `gemma3:4b`, ...) |
| Privacy | Tesseract runs locally; Textract sends the image to AWS | Wherever `model` runs |
| Best for | Clean scans, local-only pipelines, cheap text models | Photos, odd designs, when you already pay for a multimodal model |

From the CLI:

```bash
npx @cvparse/core ./scan.png --ocr tesseract --ocr-lang es,en
npx @cvparse/core ./scan.pdf --ocr textract
npx @cvparse/core ./photo.jpg --ocr vision --provider openai --model gpt-4o-mini
```

`--ocr-lang` (and `ParseOptions.ocrLanguages`) takes ISO 639-1 codes. When you leave it out, cvparse uses `--language` / `language` if you set one, and otherwise the adapter's default (Spanish + English for Tesseract).

Both reference adapters load their engine from an **optional peer dependency**, on first use. If the package is missing you get `CvparseError` code `MISSING_DEPENDENCY`, and the message includes the `npm install` command. Engine and API failures come back as `OCR_FAILED`, with the original error in `cause`.

## Tesseract

[Tesseract](https://github.com/tesseract-ocr/tesseract) through [tesseract.js](https://github.com/naptha/tesseract.js) (WASM, in a worker thread). It runs entirely on your machine, so paired with Ollama nothing leaves it.

```bash
npm install tesseract.js
```

```ts
import { readFileSync } from "node:fs";
import { parseResume } from "@cvparse/core";
import { createTesseractAdapter } from "@cvparse/core/ocr/tesseract";

const ocr = createTesseractAdapter({ languages: ["es"] });
try {
  const result = await parseResume(readFileSync("scan.png"), { model, ocr });
  console.log(result.source.ocr); // { adapter: "tesseract", confidence: 0.91, pages: 1 }
} finally {
  await ocr.dispose?.(); // the worker thread keeps the process alive until terminated
}
```

Reuse one adapter for a batch of CVs. The worker starts on the first call and stays loaded. If a call asks for different languages, the adapter reloads them (it does not start a new worker). Calls on the same adapter run one at a time. For parallel throughput, create one adapter per CPU core.

Options:

| Option | Default | |
| --- | --- | --- |
| `languages` | `["spa", "eng"]` | ISO 639-1 (`es`, `en`, `pt`, ...) or Tesseract codes (`spa`, `chi_sim`). Put the main language first. `ocrLanguages` overrides it per call. |
| `psm` | `PSM.AUTO` (`"3"`) | Page segmentation. `AUTO` runs full layout analysis, which keeps the columns of a two-column CV in separate blocks. `PSM.SPARSE_TEXT` (`"11"`) picks up stray text in icon-heavy sidebars but is noisier. |
| `rotateAuto` | `false` | Detects and corrects small skew. Use it for phone photos. |
| `langPath` | jsDelivr CDN | Directory or base URL for `<lang>.traineddata.gz`. |
| `cachePath` | current directory | Where downloaded traineddata is cached. The directory is created if it does not exist. |
| `logger` | none | Progress callback (download, recognition). |
| `oem`, `workerPath`, `corePath` | tesseract.js defaults | Passed through to tesseract.js. |

### Traineddata and offline use

On first use for a language, tesseract.js downloads `<lang>.traineddata` (about 3 to 4 MB per language) from the jsDelivr CDN and writes it to `cachePath`, which defaults to your process's working directory. That download needs network access, and it tells a third party which languages you use. The image itself is never sent.

For an offline or air-gapped setup, do one of the following:

- **Pre-fill the cache.** Run once with network access and `cachePath: "/var/lib/cvparse/tessdata"`, then ship that directory. tesseract.js looks in `cachePath` before it tries the network.
- **Serve the files yourself.** Download `https://cdn.jsdelivr.net/npm/@tesseract.js-data/spa/4.0.0_best_int/spa.traineddata.gz` (and the same path for `eng`, `por`, ...) into a directory, then pass `langPath: "/path/to/that/dir"`.

### Quality tips

- **Resolution.** Aim for 200 to 300 DPI. Below ~150 DPI, accents (`á`, `ñ`) and small contact lines degrade first. Scanned PDFs are rendered at 2× (about 144 DPI), which works well for typical 10 to 12 pt CV text.
- **Languages.** Use the right ones. `spa` alone reads English words fine, but `eng` alone drops Spanish accents. The default `spa+eng` costs a little speed.
- **Photos.** Crop to the page and turn on `rotateAuto`. Tesseract does not correct perspective; a phone photo taken at an angle is a job for vision mode or Textract.
- **Confidence.** `result.source.ocr.confidence` is the mean word confidence (0 to 1). cvparse adds a warning below 0.7. Below about 0.6, expect garbled names and emails.

### Limits

- Image input only (PNG, JPEG, WebP, TIFF). Passing a PDF directly fails with `OCR_FAILED`. cvparse renders scanned PDFs to PNG before calling the adapter (see [Scanned PDFs](#scanned-pdfs)).
- Tesseract cannot cancel a job in progress. An abort rejects immediately and terminates the worker, and the next call starts a new one, which takes about a second to load the cached languages.
- Handwriting, text over photos, and very stylized display fonts are out of reach.
- About 1 to 3 s per page on a laptop CPU.

## AWS Textract

[Amazon Textract](https://aws.amazon.com/textract/) through `@aws-sdk/client-textract`. Hosted and paid per page. It handles photos and poor scans better than Tesseract, and it has a layout model.

```bash
npm install @aws-sdk/client-textract
```

**Credentials and region** come from the standard AWS SDK chain: `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (plus `AWS_SESSION_TOKEN`), `AWS_PROFILE`, SSO, or an instance/container role. The region comes from the `region` option, `AWS_REGION`, or your shared config. The IAM principal needs `textract:DetectDocumentText`. With `features: "layout"`, it also needs `textract:AnalyzeDocument`.

```ts
import { createTextractAdapter } from "@cvparse/core/ocr/textract";

const ocr = createTextractAdapter({ region: "us-east-1" });
const result = await parseResume(readFileSync("scan.jpg"), { model, ocr });
await ocr.dispose?.();
```

You can pass your own client with `createTextractAdapter({ client: new TextractClient({ ... }) })`. Do this for custom credentials, retries, or a proxy. The adapter never destroys a client you passed in. `dispose()` only closes a client the adapter created itself.

### `detect` vs `layout`

| `features` | API call | Reading order | Price (us-east-1, first 1M pages/month) |
| --- | --- | --- | --- |
| `"detect"` (default) | `DetectDocumentText` | Textract returns positioned lines; cvparse orders them with its own column detection, so `source.layout` reports `multi-column`. | ~$1.50 / 1,000 pages |
| `"layout"` | `AnalyzeDocument` + `LAYOUT` | Textract's layout model returns titles, section headers, lists and paragraphs in reading order. cvparse uses that order as is. | ~$4.00 / 1,000 pages |

Start with `detect`. Switch to `layout` when sidebars, floating boxes or unusual designs come out in the wrong order. Prices change, so check the [Textract pricing page](https://aws.amazon.com/textract/pricing/).

### Limits

- The adapter uses the synchronous API: JPEG, PNG or TIFF, up to 10 MB. Larger inputs are rejected before the call. WebP is not accepted; convert it to PNG first. Scanned PDFs are rendered to PNG by cvparse, one call per page.
- `UnsupportedDocumentException`, `BadDocumentException`, throttling, access-denied and credentials errors are mapped to `OCR_FAILED` with a message saying what to fix. `statusCode` carries the HTTP status.
- The `abortSignal` is forwarded to the HTTP request.

### Privacy

With Textract, **the CV leaves your machine** and is processed by AWS in the region you choose. A CV is personal data (and under GDPR, LGPD or Ley 25.326 often the most sensitive data a recruiting system holds). Before using Textract on real candidates, check your data processing agreement with AWS, the region, and whether your opt-out of [AWS AI service content use](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_ai-opt-out.html) is in place. If none of that is settled, use Tesseract.

## Writing your own adapter

An adapter is any object that implements `OcrAdapter` (exported from `@cvparse/core`):

```ts
interface OcrAdapter {
  readonly name: string;                       // shown in result.source.ocr.adapter and warnings
  readonly supports?: { readonly pdf?: boolean }; // true: receive the PDF bytes, not rendered pages
  recognize(input: OcrInput): Promise<OcrPage | OcrPage[]>;
  dispose?(): Promise<void>;
}

interface OcrInput {
  data: Uint8Array;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/tiff" | "application/pdf";
  page?: number;                  // 1-based, when rendered from a PDF
  languages?: readonly string[];  // ISO 639-1 hints from ocrLanguages / language
  abortSignal?: AbortSignal;
}

interface OcrPage {
  width?: number;      // image size in pixels; required with items
  height?: number;
  items?: OcrItem[];   // positioned text: cvparse computes the reading order
  text?: string;       // or plain text, used as is when items are absent
  confidence?: number; // 0..1
  warnings?: string[];
}

interface OcrItem {
  text: string;
  x: number; y: number; width: number; height: number; // pixels, origin top-left
  confidence?: number; // 0..1
}
```

**Items or text?** Return `items` when your engine gives you boxes. cvparse then runs the same column/sidebar detection it uses for PDFs, and reports `layout: "multi-column"`. Return `text` when the engine already produces trustworthy reading order (as Textract's layout model does) or gives no geometry.

Some guidelines for items:

- **Granularity.** Use one item per line or per phrase, with the words already joined by spaces. Do not return one item per word. cvparse inserts a space between items from the gap between their boxes. That works for PDF text runs, but OCR word boxes are tight to the ink, so after a wide glyph (`—`, `M`) two words can end up glued. If your engine runs a line across a column gutter, split it at the wide gap. The Tesseract adapter splits at gaps wider than 0.8 × the line height.
- **Item order.** Emit items in the engine's reading order: column by column, or block by block. cvparse uses that order to tell real columns (emitted as contiguous runs) from table rows (emitted cell by cell).
- **Coordinates.** Coordinates only need to be consistent within a page. If the engine returns normalized boxes (0 to 1), scale them to a nominal page, for example 1000 × 1414 for A4 portrait, and report that as `width`/`height`. The Textract adapter does exactly this. Keep the real aspect ratio: column detection uses widths relative to the page.
- **Line boxes.** Give all items on a line the same `y` and `height`, taken from the line box rather than the word box. Otherwise a word with no ascenders ("con", "ama") sits on a different baseline from its neighbours.

**Errors.** Throw `CvparseError` with `OCR_FAILED` (or `MISSING_DEPENDENCY` for a missing package) to control the message. Any other error is wrapped in `OCR_FAILED` as `"<name>: <message>"`. Check `abortSignal` before expensive work.

```ts
import { CvparseError, type OcrAdapter } from "@cvparse/core";

const myOcr: OcrAdapter = {
  name: "my-ocr",
  async recognize({ data, mimeType, languages, abortSignal }) {
    abortSignal?.throwIfAborted();
    const res = await fetch("https://ocr.internal/v1/read", {
      method: "POST",
      headers: { "content-type": mimeType, "x-langs": (languages ?? ["es"]).join(",") },
      body: data,
      signal: abortSignal,
    });
    if (!res.ok) throw new CvparseError("OCR_FAILED", `my-ocr: HTTP ${res.status}`);
    const { width, height, lines } = await res.json();
    return {
      width,
      height,
      items: lines.map((l) => ({ text: l.text, x: l.x, y: l.y, width: l.w, height: l.h })),
    };
  },
};
```

## Scanned PDFs

When a PDF has no text layer (or nearly none), cvparse treats it as scanned:

- **With an adapter that does not take PDFs** (`supports.pdf` not `true`, which includes both reference adapters): cvparse renders each page to PNG with pdf.js and [`@napi-rs/canvas`](https://github.com/Brooooooklyn/canvas), at scale 2 (2 px per PDF point, about 144 DPI). It then calls `recognize` once per page, in order. `@napi-rs/canvas` is another optional peer: `npm install @napi-rs/canvas`. Without it, you get `MISSING_DEPENDENCY`.
- **With an adapter that declares `supports: { pdf: true }`**: the adapter receives the PDF bytes once and may return one `OcrPage` per page.
- **With `ocr: "vision"`**: cvparse renders the pages the same way and sends the images to the model, at most 5 pages (images are expensive in tokens).

For OCR adapters, at most **20 pages** are rendered, and a warning says when a document was cut short. CVs longer than that are almost always several documents merged into one file.

`result.source` tells you what happened: `format: "pdf"`, `pages`, `layout`, and `ocr: { adapter, confidence, pages }`.
