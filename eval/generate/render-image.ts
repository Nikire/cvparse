/**
 * "Scanned" renderers: the CV is drawn on a @napi-rs/canvas page (A4 at 150 DPI, 1240x1754),
 * slightly rotated (< 1°) with sparse grey specks, then saved as PNG or embedded as a JPEG in an
 * image-only PDF. Text rendering depends on the fonts installed on the machine, so the committed
 * files are the reference (byte-identical when regenerated on the same machine).
 */

import { crc32, deflateSync } from "node:zlib";
import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";
import type { CvDoc } from "./doc.js";
import { A4, createPdf, savePdf } from "./pdf-kit.js";
import type { RenderResult } from "./render-pdf.js";

const WIDTH = 1240;
const HEIGHT = 1754;
const FONT = "Arial";

interface Line {
  text: string;
  size?: number;
  bold?: boolean;
  gap?: number;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/**
 * Encodes RGBA pixels as an 8-bit grayscale PNG (a scan is grey anyway). About 3x smaller than the
 * canvas RGBA PNG and independent of the canvas encoder version. Per-row adaptive filtering
 * (minimum sum of absolute differences), deflate level 9.
 */
function encodeGrayPng(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): Buffer {
  const gray = new Uint8Array(width * height);
  for (let i = 0; i < gray.length; i++) {
    const r = rgba[i * 4] as number;
    const g = rgba[i * 4 + 1] as number;
    const b = rgba[i * 4 + 2] as number;
    gray[i] = Math.round((r * 299 + g * 587 + b * 114) / 1000);
  }
  const out = Buffer.alloc((width + 1) * height);
  const candidate = new Uint8Array(width);
  const best = new Uint8Array(width);
  for (let y = 0; y < height; y++) {
    const row = gray.subarray(y * width, (y + 1) * width);
    const up = y > 0 ? gray.subarray((y - 1) * width, y * width) : new Uint8Array(width);
    let bestSum = Number.POSITIVE_INFINITY;
    let bestType = 0;
    for (let type = 0; type < 5; type++) {
      let sum = 0;
      for (let x = 0; x < width; x++) {
        const a = x > 0 ? (row[x - 1] as number) : 0;
        const b = up[x] as number;
        const c = x > 0 ? (up[x - 1] as number) : 0;
        let predictor = 0;
        if (type === 1) predictor = a;
        else if (type === 2) predictor = b;
        else if (type === 3) predictor = (a + b) >> 1;
        else if (type === 4) {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        }
        const value = ((row[x] as number) - predictor) & 0xff;
        candidate[x] = value;
        sum += value < 128 ? value : 256 - value;
      }
      if (sum < bestSum) {
        bestSum = sum;
        bestType = type;
        best.set(candidate);
      }
    }
    out[y * (width + 1)] = bestType;
    out.set(best, y * (width + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(out, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function wrapCanvas(ctx: SKRSContext2D, text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width <= width || !current) current = candidate;
    else {
      out.push(current);
      current = word;
    }
  }
  if (current) out.push(current);
  return out;
}

function drawColumn(
  ctx: SKRSContext2D,
  lines: Line[],
  x: number,
  top: number,
  width: number,
): number {
  let y = top;
  for (const line of lines) {
    const size = line.size ?? 25;
    ctx.font = `${line.bold ? "bold " : ""}${size}px ${FONT}`;
    for (const piece of line.text === "" ? [""] : wrapCanvas(ctx, line.text, width)) {
      if (piece) ctx.fillText(piece, x, y);
      y += Math.round(size * 1.38);
    }
    y += line.gap ?? 0;
  }
  if (y > HEIGHT - 50) throw new Error(`scanned page overflow (${y}px)`);
  return y;
}

function render(doc: CvDoc, twoColumn: boolean): { png: Buffer; jpeg: Buffer; angle: number } {
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  const rng = doc.rng;
  const angle = (rng.chance(0.5) ? 1 : -1) * (0.25 + rng.float() * 0.6);
  ctx.save();
  ctx.translate(WIDTH / 2, HEIGHT / 2);
  ctx.rotate((angle * Math.PI) / 180);
  ctx.translate(-WIDTH / 2, -HEIGHT / 2);
  ctx.fillStyle = "#151515";
  ctx.textBaseline = "top";

  const t = doc.titles;
  const p = doc.person;
  const header: Line[] = [
    { text: p.name, size: 46, bold: true, gap: 4 },
    { text: p.label, size: 28 },
    { text: doc.locationText, size: 23 },
    { text: `${doc.phoneLabel}${p.phone} · ${doc.emailLabel}${p.email}`, size: 23 },
  ];
  const experience: Line[] = [
    { text: t.experience.toUpperCase(), bold: true, size: 27, gap: 6 },
    ...doc.jobs.flatMap((j): Line[] => [
      { text: j.position, bold: true },
      { text: `${j.company} — ${j.location}` },
      { text: j.dates },
      ...j.highlights.map((h): Line => ({ text: `- ${h}`, size: 23 })),
      { text: "", size: 10 },
    ]),
  ];
  const education: Line[] = [
    { text: t.education.toUpperCase(), bold: true, size: 27, gap: 6 },
    ...doc.studies.flatMap((s): Line[] => [
      { text: s.title, bold: true },
      { text: `${s.institution}, ${s.dates}`, gap: 8 },
    ]),
  ];
  const skills: Line[] = [
    { text: t.skills.toUpperCase(), bold: true, size: 27, gap: 6 },
    ...(twoColumn ? doc.skills.map((s): Line => ({ text: s })) : [{ text: doc.skills.join(", ") }]),
    { text: "", size: 10 },
  ];
  const languages: Line[] = [
    { text: t.languages.toUpperCase(), bold: true, size: 27, gap: 6 },
    ...doc.languages.map((l): Line => ({ text: l })),
  ];

  const margin = 90;
  const bodyTop = drawColumn(ctx, header, margin, margin, WIDTH - margin * 2) + 40;
  if (twoColumn) {
    const leftWidth = 640;
    drawColumn(ctx, [...experience, ...education], margin, bodyTop, leftWidth);
    drawColumn(
      ctx,
      [...skills, ...languages],
      margin + leftWidth + 60,
      bodyTop,
      WIDTH - margin * 2 - leftWidth - 60,
    );
  } else {
    drawColumn(
      ctx,
      [...experience, { text: "", size: 8 }, ...education, ...skills, ...languages],
      margin,
      bodyTop,
      WIDTH - margin * 2,
    );
  }
  ctx.restore();

  // Scanner specks.
  ctx.fillStyle = "#9a9a9a";
  const specks = rng.int(120, 260);
  for (let i = 0; i < specks; i++) {
    ctx.fillRect(rng.int(0, WIDTH - 2), rng.int(0, HEIGHT - 2), rng.int(1, 2), rng.int(1, 2));
  }
  const rgba = ctx.getImageData(0, 0, WIDTH, HEIGHT).data;
  return {
    png: encodeGrayPng(rgba, WIDTH, HEIGHT),
    jpeg: canvas.toBuffer("image/jpeg", 72),
    angle,
  };
}

export async function renderScannedImage(doc: CvDoc): Promise<RenderResult> {
  const twoColumn = doc.spec.variant >= 2;
  const { png } = render(doc, twoColumn);
  return {
    bytes: new Uint8Array(png),
    tags: ["rotated", twoColumn ? "two-columns" : "one-column"],
  };
}

export async function renderScannedPdf(doc: CvDoc): Promise<RenderResult> {
  const twoColumn = doc.spec.variant % 2 === 1;
  const { jpeg } = render(doc, twoColumn);
  const ctx = await createPdf(`Scan ${doc.spec.id}`);
  const image = await ctx.doc.embedJpg(jpeg);
  const page = ctx.doc.addPage([A4.width, A4.height]);
  page.drawImage(image, { x: 0, y: 0, width: A4.width, height: A4.height });
  const tags = ["rotated", "jpeg-in-pdf", twoColumn ? "two-columns" : "one-column"];
  if (twoColumn) {
    // A short real-text stamp, like scanner apps add; cvparse treats such pages as scanned.
    page.drawText("Escaneado con CamScanner", { x: 230, y: 18, size: 9, font: ctx.fonts.regular });
    tags.push("scanner-stamp");
  }
  return { bytes: await savePdf(ctx.doc), tags };
}
