/**
 * Text cleanup shared by every extractor (PDF text layer, DOCX, OCR, plain text).
 *
 * PDF fonts often encode accented letters as a base glyph plus a combining mark, and for "í" the
 * base is frequently the dotless "ı" (U+0131), because a dotted "i" plus an acute would show two
 * marks. Copy-paste then yields "Albarracı́n" (U+0131 U+0301), which neither NFC-composes nor
 * matches "Albarracín". Fonts also emit typographic ligatures (U+FB00-U+FB04) and no-break spaces.
 */

/** Typographic Latin ligatures expanded to their letters. */
const LIGATURES: Readonly<Record<string, string>> = {
  ﬀ: "ff",
  ﬁ: "fi",
  ﬂ: "fl",
  ﬃ: "ffi",
  ﬄ: "ffl",
  ﬅ: "st",
  ﬆ: "st",
};

/**
 * Normalizes extracted text:
 * - a dotless "ı" (U+0131) followed by a combining mark (U+0300-U+036F) becomes "i" + that mark,
 *   so NFC composes it ("ı" + U+0301 -> "í"); a lone "ı" (Turkish) is kept;
 * - ligatures "ﬀ ﬁ ﬂ ﬃ ﬄ ﬅ ﬆ" are expanded to plain letters;
 * - no-break spaces (U+00A0, U+202F, U+2007) become regular spaces;
 * - the result is NFC-normalized, so decomposed accents ("e" + U+0301) become "é".
 */
export function cleanExtractedText(text: string): string {
  return text
    .replace(/ı(?=[̀-ͯ])/g, "i")
    .replace(/[ﬀ-ﬆ]/g, (ch) => LIGATURES[ch] ?? ch)
    .replace(/[   ]/g, " ")
    .normalize("NFC");
}
