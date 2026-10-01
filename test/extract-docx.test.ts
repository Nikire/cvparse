import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Document, Packer } from "docx";
import { describe, expect, it } from "vitest";
import { CvparseError } from "../src/errors.js";
import {
  decodeEntities,
  extractDocxText,
  htmlToText,
  isZip64Eocd,
  mainPartFromRels,
  readDocxPackage,
  textBoxParagraphs,
} from "../src/extract/docx.js";

const here = dirname(fileURLToPath(import.meta.url));

/** Reads a generated fixture from `test/fixtures/docx/` (see scripts/fixtures/make-docx-fixtures.mjs). */
function docxFixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(here, "fixtures", "docx", name)));
}

/** Index of `needle` in `text`, failing the test if absent. */
function indexOf(text: string, needle: string): number {
  const index = text.indexOf(needle);
  expect(index, `expected to find ${JSON.stringify(needle)}`).toBeGreaterThanOrEqual(0);
  return index;
}

async function expectExtractionFailed(data: Uint8Array): Promise<CvparseError> {
  let caught: unknown;
  try {
    await extractDocxText(data);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(CvparseError);
  const error = caught as CvparseError;
  expect(error.code).toBe("EXTRACTION_FAILED");
  return error;
}

describe("extractDocxText", () => {
  it("returns docx metadata with no page count and unknown layout", async () => {
    const result = await extractDocxText(docxFixture("simple-es.docx"));
    expect(result.format).toBe("docx");
    expect(result.layout).toBe("unknown");
    expect(result.pages).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });

  describe("simple-es.docx", () => {
    it("keeps section titles in reading order", async () => {
      const { text } = await extractDocxText(docxFixture("simple-es.docx"));
      const titles = [
        "OBJETIVO PROFESIONAL",
        "EXPERIENCIA",
        "EDUCACIÓN",
        "HABILIDADES",
        "IDIOMAS",
        "REFERENCIAS",
      ];
      const positions = titles.map((title) => indexOf(text, title));
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
      // Headings sit on their own line.
      for (const title of titles) expect(text).toMatch(new RegExp(`(^|\\n)${title}\\n`));
    });

    it("preserves bullets as their own '- ' lines", async () => {
      const { text } = await extractDocxText(docxFixture("simple-es.docx"));
      const lines = text.split("\n");
      expect(lines).toContain("- Cierre de 35 cuentas nuevas en 2023 (120% de la meta anual).");
      expect(lines).toContain(
        "- Manejo de cartera de 60 clientes hospitalarios en Antioquia y Eje Cafetero.",
      );
      expect(lines).toContain("- Ventas de insumos médicos a clínicas y farmacias.");
      expect(lines).toContain("- Capacitación a 3 asesores nuevos.");
      // Consecutive bullets are adjacent lines (no blank line between items).
      expect(text).toContain(
        "- Ventas de insumos médicos a clínicas y farmacias.\n- Capacitación a 3 asesores nuevos.",
      );
    });

    it("keeps accents and ñ intact", async () => {
      const { text } = await extractDocxText(docxFixture("simple-es.docx"));
      expect(text).toContain("Carlos Andrés Ramírez Mejía");
      expect(text).toContain("Medellín, Antioquia, Colombia");
      expect(text).toContain("Profesional en administración con 5 años");
      expect(text).toContain("Español (nativo) · Inglés (B1)");
      expect(text).toContain("Cámara de Comercio de Medellín");
    });

    it("separates blocks with a single blank line and has no trailing whitespace", async () => {
      const { text } = await extractDocxText(docxFixture("simple-es.docx"));
      expect(text).not.toMatch(/\n{3,}/);
      expect(text).not.toMatch(/[ \t]\n/);
      expect(text).toBe(text.trim());
      expect(text.startsWith("Carlos Andrés Ramírez Mejía\n\nEjecutivo de Ventas B2B")).toBe(true);
    });
  });

  describe("table-layout-es.docx (two-column table used as page layout)", () => {
    it("includes the text of both cells, left column first", async () => {
      const { text } = await extractDocxText(docxFixture("table-layout-es.docx"));
      // Left cell
      const contact = indexOf(text, "lucia.fernandez@example.com");
      const skills = indexOf(text, "- Investigación con usuarios");
      // Right cell
      const profile = indexOf(text, "PERFIL");
      const experience = indexOf(text, "EXPERIENCIA");
      const education = indexOf(text, "Diplomado en UX Research");
      expect(contact).toBeLessThan(skills);
      expect(skills).toBeLessThan(profile);
      expect(profile).toBeLessThan(experience);
      expect(experience).toBeLessThan(education);
      // Cells are not collapsed into one "a | b" line.
      expect(text).not.toContain(" | ");
    });

    it("keeps the experience block with its open-ended date", async () => {
      const { text } = await extractDocxText(docxFixture("table-layout-es.docx"));
      const experience = text.slice(indexOf(text, "EXPERIENCIA"), indexOf(text, "EDUCACIÓN"));
      expect(experience).toContain("Product Designer Senior — Banco Digital Andino");
      expect(experience).toContain("marzo 2021 – actualidad");
      expect(experience).toContain("- Creé el design system usado por 4 squads.");
    });

    it("keeps soft line breaks inside a paragraph as separate lines", async () => {
      const { text } = await extractDocxText(docxFixture("table-layout-es.docx"));
      expect(text).toContain(
        "Santiago, Chile\n+56 9 8765 4321\nlucia.fernandez@example.com\nlinkedin.com/in/luciafo",
      );
    });
  });

  describe("text boxes", () => {
    it("reads a VML text box (w:pict/v:textbox) natively, in place", async () => {
      const { text, warnings } = await extractDocxText(docxFixture("textbox-es.docx"));
      expect(text).toContain("DATOS ADICIONALES");
      expect(text).toContain("Licencia de conducción categoría B1");
      expect(text).toContain("Vehículo propio");
      // The box sits after the contact line and before the first section.
      expect(indexOf(text, "DATOS ADICIONALES")).toBeLessThan(
        indexOf(text, "OBJETIVO PROFESIONAL"),
      );
      expect(warnings).toEqual([]);
    });

    it("recovers a DrawingML text box (wps:txbx) mammoth drops and appends it at the end", async () => {
      const { text, warnings } = await extractDocxText(docxFixture("textbox-drawing-es.docx"));
      expect(warnings).toContain("text box content appended at the end");
      expect(text.endsWith("Vehículo propio")).toBe(true);
      expect(indexOf(text, "DATOS ADICIONALES")).toBeGreaterThan(
        indexOf(text, "Disponibles a solicitud."),
      );
      expect(text).toContain(
        "DATOS ADICIONALES\nDisponibilidad inmediata\nLicencia de conducción categoría B1\nVehículo propio",
      );
      // Nothing from the main body was lost or duplicated.
      expect(text.match(/OBJETIVO PROFESIONAL/g)).toHaveLength(1);
      expect(text.match(/Vehículo propio/g)).toHaveLength(1);
    });

    it("keeps box lines that are substrings of a body line, and the same line from two boxes", async () => {
      const { text, warnings } = await extractDocxText(docxFixture("textbox-overlap-es.docx"));
      expect(warnings).toContain("text box content appended at the end");
      const lines = text.split("\n");
      expect(lines).toContain("Requisito del puesto: Vehículo propio y licencia B1 vigente.");
      // Both lines of the first box survive even though the body contains them as substrings.
      expect(lines).toContain("Vehículo propio");
      expect(lines).toContain("Licencia de conducción categoría B1");
      // "Inglés" is a substring of the IDIOMAS line and sits in two different boxes: two lines.
      expect(lines.filter((line) => line === "Inglés")).toHaveLength(2);
      expect(lines).toContain("Español (nativo) · Inglés (B1)");
    });
  });

  describe("package layout", () => {
    it("reads a DOCX whose main part is word/document2.xml (resolved from _rels/.rels)", async () => {
      const result = await extractDocxText(docxFixture("document2-es.docx"));
      const reference = await extractDocxText(docxFixture("simple-es.docx"));
      expect(result.text).toBe(reference.text);
      expect(result.warnings).toEqual([]);
      const pkg = readDocxPackage(Buffer.from(docxFixture("document2-es.docx")));
      expect(pkg.mainPart).toBe("word/document2.xml");
      expect(pkg.issue).toBeUndefined();
      expect(pkg.documentXml).toContain("Carlos Andrés Ramírez Mejía");
    });

    it("reads a zip64 archive through mammoth and warns that text boxes were not scanned", async () => {
      const result = await extractDocxText(docxFixture("zip64-es.docx"));
      const reference = await extractDocxText(docxFixture("simple-es.docx"));
      expect(result.text).toBe(reference.text);
      expect(result.warnings).toEqual(["zip64 archive: text boxes could not be scanned"]);
      const pkg = readDocxPackage(Buffer.from(docxFixture("zip64-es.docx")));
      expect(pkg.documentXml).toBeUndefined();
      expect(pkg.issue?.kind).toBe("zip64");
    });

    it("detects the zip64 markers of the end-of-central-directory record", () => {
      expect(isZip64Eocd(0xffff, 100, 200)).toBe(true);
      expect(isZip64Eocd(3, 0xffffffff, 200)).toBe(true);
      expect(isZip64Eocd(3, 100, 0xffffffff)).toBe(true);
      expect(isZip64Eocd(3, 100, 200)).toBe(false);
      expect(isZip64Eocd(0xfffe, 0xfffffffe, 0xfffffffe)).toBe(false);
    });

    it("rejects a main part that inflates past the size limit, before running mammoth", () => {
      const buffer = Buffer.from(docxFixture("simple-es.docx"));
      let caught: unknown;
      try {
        readDocxPackage(buffer, 1024);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(CvparseError);
      const error = caught as CvparseError;
      expect(error.code).toBe("EXTRACTION_FAILED");
      expect(error.message).toMatch(/size limit/);
      expect(error.message).toMatch(/0 MiB/); // 1024 bytes rounds to 0 MiB
      expect(error.cause).toBeDefined();
      // The default limit is far above any real CV.
      expect(readDocxPackage(buffer).documentXml).toContain("<w:body>");
    });
  });

  describe("failures", () => {
    it("rejects bytes that only look like a zip", async () => {
      const error = await expectExtractionFailed(new Uint8Array(Buffer.from("PK garbage")));
      expect(error.message).toMatch(/not a docx/i);
    });

    it("rejects a non-zip buffer", async () => {
      await expectExtractionFailed(new Uint8Array(Buffer.from("hola, esto no es un docx")));
      await expectExtractionFailed(new Uint8Array());
    });

    it("rejects a truncated DOCX", async () => {
      const whole = docxFixture("simple-es.docx");
      const error = await expectExtractionFailed(whole.subarray(0, Math.floor(whole.length / 2)));
      expect(error.message).toMatch(/corrupt|damaged|truncated|not found/i);
      expect(error.cause).toBeDefined();
    });

    it("rejects a zip without word/document.xml", async () => {
      // Minimal valid zip with one stored entry "hello.txt" and nothing else.
      const name = Buffer.from("hello.txt");
      const data = Buffer.from("hi");
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(name.length, 26);
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt32LE(data.length, 20);
      central.writeUInt32LE(data.length, 24);
      central.writeUInt16LE(name.length, 28);
      central.writeUInt32LE(0, 42);
      const eocd = Buffer.alloc(22);
      eocd.writeUInt32LE(0x06054b50, 0);
      eocd.writeUInt16LE(1, 8);
      eocd.writeUInt16LE(1, 10);
      eocd.writeUInt32LE(central.length + name.length, 12);
      eocd.writeUInt32LE(local.length + name.length + data.length, 16);
      const zip = Buffer.concat([local, name, data, central, name, eocd]);
      const error = await expectExtractionFailed(new Uint8Array(zip));
      expect(error.message).toMatch(/word\/document\.xml/);
    });
  });

  it("returns empty text for a DOCX with an empty body", async () => {
    const empty = await Packer.toBuffer(new Document({ sections: [{ children: [] }] }));
    const result = await extractDocxText(new Uint8Array(empty));
    expect(result.text).toBe("");
    expect(result.format).toBe("docx");
  });
});

describe("htmlToText (mammoth HTML subset)", () => {
  it("puts headings and paragraphs in their own blocks and decodes entities", () => {
    expect(
      htmlToText(
        "<h1>T&iacute;tulo &amp; m&#225;s</h1><p>Uno &lt;b&gt; &quot;dos&quot; &#39;tres&#39;</p>",
      ),
    ).toBe("T&iacute;tulo & más\n\nUno <b> \"dos\" 'tres'");
  });

  it("turns <br> into a line break inside a paragraph", () => {
    expect(htmlToText("<p>a<br />b<br/>c</p><p>d</p>")).toBe("a\nb\nc\n\nd");
  });

  it("prefixes list items with '- ' and indents nested lists", () => {
    const html = "<ul><li>uno</li><li>dos<ul><li>dos.a</li></ul></li></ul><ol><li>tres</li></ol>";
    expect(htmlToText(html)).toBe("- uno\n- dos\n  - dos.a\n\n- tres");
  });

  it("joins the cells of a data table with ' | '", () => {
    const html =
      "<table><tr><th>Idioma</th><th>Nivel</th></tr><tr><td><p>Español</p></td><td><p>nativo</p></td></tr><tr><td></td><td></td></tr></table>";
    expect(htmlToText(html)).toBe("Idioma | Nivel\nEspañol | nativo");
  });

  it("emits a layout table cell by cell when cells hold several blocks", () => {
    const html =
      "<table><tr><td><p>izq 1</p><p>izq 2</p></td><td><p>der 1</p><ul><li>x</li></ul></td></tr></table>";
    expect(htmlToText(html)).toBe("izq 1\n\nizq 2\n\nder 1\n\n- x");
  });

  it("ignores inline formatting, images, anchors and comments", () => {
    const html =
      '<!-- c --><p><strong>Negrita</strong> <em>cursiva</em> <a href="#x">link</a><img src="data:x" /><a id="a"></a></p>';
    expect(htmlToText(html)).toBe("Negrita cursiva link");
  });

  it("returns an empty string for empty input", () => {
    expect(htmlToText("")).toBe("");
    expect(htmlToText("<p></p><p> </p>")).toBe("");
  });
});

describe("textBoxParagraphs", () => {
  it("extracts paragraph text from w:txbxContent and dedupes mc:Choice/mc:Fallback copies", () => {
    const box =
      '<w:txbxContent><w:p><w:r><w:t xml:space="preserve">Hola </w:t></w:r><w:r><w:t>mundo &amp; m&#225;s</w:t></w:r></w:p><w:p><w:r><w:t>Segunda</w:t><w:tab/><w:t>línea</w:t></w:r></w:p></w:txbxContent>';
    const xml = `<w:document><w:body><mc:AlternateContent><mc:Choice>${box}</mc:Choice><mc:Fallback>${box}</mc:Fallback></mc:AlternateContent></w:body></w:document>`;
    expect(textBoxParagraphs(xml)).toEqual(["Hola mundo & más", "Segunda línea"]);
  });

  it("returns nothing when the document has no text boxes", () => {
    expect(textBoxParagraphs("<w:document><w:body><w:p/></w:body></w:document>")).toEqual([]);
  });

  it("dedupes only within one mc:AlternateContent block, not across boxes", () => {
    const box = (text: string) =>
      `<w:txbxContent><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:txbxContent>`;
    const alternate = (text: string) =>
      `<mc:AlternateContent><mc:Choice Requires="wps">${box(text)}</mc:Choice><mc:Fallback>${box(text)}</mc:Fallback></mc:AlternateContent>`;
    // Two Word-style boxes (Choice + Fallback each) that both say "Inglés".
    expect(
      textBoxParagraphs(`<w:body>${alternate("Inglés")}${alternate("Inglés")}</w:body>`),
    ).toEqual(["Inglés", "Inglés"]);
    // Two bare boxes (no AlternateContent) with the same text are two boxes.
    expect(textBoxParagraphs(`<w:body>${box("Inglés")}${box("Inglés")}</w:body>`)).toEqual([
      "Inglés",
      "Inglés",
    ]);
    // Different boxes inside one AlternateContent are both kept.
    expect(
      textBoxParagraphs(
        `<mc:AlternateContent><mc:Choice>${box("A")}${box("B")}</mc:Choice><mc:Fallback>${box("A")}${box("B")}</mc:Fallback></mc:AlternateContent>`,
      ),
    ).toEqual(["A", "B"]);
  });

  it("treats a self-closing <w:t/> as empty text", () => {
    expect(
      textBoxParagraphs(
        "<w:txbxContent><w:p><w:r><w:t/></w:r><w:r><w:t>Hola</w:t></w:r></w:p></w:txbxContent>",
      ),
    ).toEqual(["Hola"]);
    expect(
      textBoxParagraphs(
        '<w:txbxContent><w:p><w:r><w:t xml:space="preserve"/><w:t>A</w:t></w:r></w:p><w:p><w:r><w:t>B</w:t></w:r></w:p></w:txbxContent>',
      ),
    ).toEqual(["A", "B"]);
  });

  it("maps w:tab to a space and w:br / w:cr to separate lines", () => {
    expect(
      textBoxParagraphs(
        '<w:txbxContent><w:p><w:r><w:t>Uno</w:t><w:tab/><w:t>dos</w:t><w:br/><w:t>tres</w:t><w:cr/><w:t>cuatro</w:t><w:br w:type="textWrapping"/></w:r></w:p></w:txbxContent>',
      ),
    ).toEqual(["Uno dos", "tres", "cuatro"]);
  });
});

describe("mainPartFromRels", () => {
  const rels = (inner: string) =>
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${inner}</Relationships>`;

  it("returns the officeDocument target without a leading slash", () => {
    expect(
      mainPartFromRels(
        rels(
          '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
            '<Relationship Target="/word/document2.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Id="rId1"/>',
        ),
      ),
    ).toBe("word/document2.xml");
  });

  it("accepts the strict (ISO) relationship namespace", () => {
    expect(
      mainPartFromRels(
        rels(
          '<Relationship Id="rId1" Type="http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument" Target="word/document.xml"/>',
        ),
      ),
    ).toBe("word/document.xml");
  });

  it("returns undefined when there is no officeDocument relationship", () => {
    expect(mainPartFromRels(rels(""))).toBeUndefined();
    expect(mainPartFromRels("not xml at all")).toBeUndefined();
    expect(
      mainPartFromRels(
        rels(
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="http://example.com/x.docx" TargetMode="External"/>',
        ),
      ),
    ).toBeUndefined();
  });
});

describe("decodeEntities", () => {
  it("replaces code points outside Unicode or in the surrogate range with U+FFFD", () => {
    expect(decodeEntities("a&#x110000;b")).toBe("a�b");
    expect(decodeEntities("a&#1114112;b")).toBe("a�b");
    expect(decodeEntities("&#xD800;&#xDFFF;&#55296;")).toBe("���");
    expect(decodeEntities("&#xFFFFFFFFFFFFFFFFFFFF;")).toBe("�");
  });

  it("still decodes valid numeric and named entities", () => {
    expect(decodeEntities("&#x1F600; &#225; &amp; &nbsp;x &#x10FFFF;")).toBe(
      "\u{1F600} á &  x \u{10FFFF}", // nbsp deliberately decodes to a plain space
    );
  });

  it("does not let a bad entity escape as a RangeError through the extractor", () => {
    expect(() => htmlToText("<p>&#x110000;</p>")).not.toThrow();
    expect(htmlToText("<p>&#x110000;</p>")).toBe("�");
    expect(
      textBoxParagraphs(
        "<w:txbxContent><w:p><w:r><w:t>x&#x110000;</w:t></w:r></w:p></w:txbxContent>",
      ),
    ).toEqual(["x�"]);
  });
});
