import { describe, expect, it } from "vitest";
import { dehyphenate, orderTextItems } from "../src/extract/layout.js";
import type { TextItem } from "../src/extract/types.js";

const PAGE = { width: 612, height: 792 };
const CHAR = 5;
const HEIGHT = 10;

/** Builds an item whose width is derived from its length (5 pt per char). */
function item(str: string, x: number, y: number, overrides: Partial<TextItem> = {}): TextItem {
  return { str, x, y, width: str.length * CHAR, height: HEIGHT, hasEOL: false, ...overrides };
}

/** Stacks lines of text at `x`, 12 pt apart, starting at `top`. */
function column(lines: string[], x: number, top: number, step = 12): TextItem[] {
  return lines.map((line, index) => item(line, x, top - index * step));
}

/** Index of `needle` in `text`, failing the test when it is absent. */
function indexOf(text: string, needle: string): number {
  const index = text.indexOf(needle);
  expect(index, `expected "${needle}" in:\n${text}`).toBeGreaterThanOrEqual(0);
  return index;
}

describe("orderTextItems", () => {
  it("returns empty text and unknown layout for no items", () => {
    expect(orderTextItems([], PAGE)).toEqual({ text: "", layout: "unknown" });
    expect(orderTextItems([item("   ", 10, 10)], PAGE)).toEqual({ text: "", layout: "unknown" });
  });

  it("orders a single column top to bottom regardless of input order", () => {
    const lines = ["PERFIL", "Primera línea", "Segunda línea", "Tercera línea"];
    const items = column(lines, 50, 700).reverse();
    const result = orderTextItems(items, PAGE);
    expect(result.layout).toBe("single-column");
    expect(result.text).toBe(lines.join("\n"));
  });

  it("joins items on the same baseline with a space only when the gap is wide enough", () => {
    const items = [
      // "Ho" + "la" with a sub-character gap -> no space.
      item("Ho", 50, 700),
      item("la", 60.5, 700),
      // "mundo" separated by more than a third of a char -> space.
      item("mundo", 73, 700),
      // Baseline jitter well within half the line height still counts as the same line.
      item("hoy", 110, 702),
    ];
    expect(orderTextItems(items, PAGE).text).toBe("Hola mundo hoy");
  });

  it("collapses whitespace runs and keeps items in x order", () => {
    const items = [item("tres", 100, 700), item("uno  ", 50, 700), item(" dos", 75, 700)];
    expect(orderTextItems(items, PAGE).text).toBe("uno dos tres");
  });

  it("breaks the line after an item flagged hasEOL", () => {
    const items = [item("Empresa", 50, 700, { hasEOL: true }), item("Cargo", 100, 700)];
    expect(orderTextItems(items, PAGE).text).toBe("Empresa\nCargo");
  });

  it("separates bands with a blank line at large vertical gaps", () => {
    const items = [
      ...column(["EXPERIENCIA", "Puesto A"], 50, 700),
      ...column(["IDIOMAS", "Español"], 50, 640),
    ];
    expect(orderTextItems(items, PAGE).text).toBe("EXPERIENCIA\nPuesto A\n\nIDIOMAS\nEspañol");
  });

  it("emits a full-width header, then the left column, then the right column", () => {
    const header = column(
      [
        "MARÍA FERNANDA LÓPEZ GARCÍA — Desarrolladora Backend",
        "CABA · +54 9 11 5555-1234 · mfernanda@example.com",
      ],
      50,
      750,
    );
    const left = column(
      ["EXPERIENCIA", "Fintonic Latam", "Tech Lead Backend", "Mercado Local", "Backend Ssr."],
      50,
      724,
    );
    const right = column(["HABILIDADES", "Node.js", "TypeScript", "IDIOMAS", "Español"], 330, 724);
    const result = orderTextItems([...right, ...header, ...left], PAGE);

    expect(result.layout).toBe("multi-column");
    const text = result.text;
    const positions = [
      indexOf(text, "MARÍA FERNANDA"),
      indexOf(text, "CABA"),
      indexOf(text, "EXPERIENCIA"),
      indexOf(text, "Backend Ssr."),
      indexOf(text, "HABILIDADES"),
      indexOf(text, "Español"),
    ];
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(text).toContain(
      "EXPERIENCIA\nFintonic Latam\nTech Lead Backend\nMercado Local\nBackend Ssr.",
    );
    expect(text).toContain("HABILIDADES\nNode.js\nTypeScript\nIDIOMAS\nEspañol");
  });

  it("reads a full-height sidebar before the main column", () => {
    const sidebar = column(
      [
        "CONTACTO",
        "CABA",
        "+54 9 11",
        "HABILIDADES",
        "Node.js",
        "TypeScript",
        "Docker",
        "IDIOMAS",
        "Español",
        "Inglés",
      ],
      40,
      760,
      14,
    );
    const main = column(
      [
        "MARÍA LÓPEZ",
        "PERFIL",
        "Backend developer con 7 años de experiencia",
        "EXPERIENCIA",
        "Fintonic Latam",
        "Tech Lead",
        "Mercado Local",
        "Backend Ssr.",
      ],
      220,
      760,
    );
    const result = orderTextItems([...main, ...sidebar], PAGE);

    expect(result.layout).toBe("multi-column");
    expect(indexOf(result.text, "Inglés")).toBeLessThan(indexOf(result.text, "MARÍA LÓPEZ"));
    expect(result.text).toContain("Fintonic Latam\nTech Lead\nMercado Local\nBackend Ssr.");
  });

  it("prefers the vertical cut even when both columns share a horizontal gap", () => {
    const left = [
      ...column(["Izquierda 1", "Izquierda 2"], 50, 700),
      ...column(["Izquierda 3", "Izquierda 4"], 50, 640),
    ];
    const right = [
      ...column(["Derecha 1", "Derecha 2"], 330, 700),
      ...column(["Derecha 3", "Derecha 4"], 330, 640),
    ];
    const result = orderTextItems([...left, ...right], PAGE);

    expect(result.layout).toBe("multi-column");
    expect(result.text).toBe(
      "Izquierda 1\nIzquierda 2\n\nIzquierda 3\nIzquierda 4\n\nDerecha 1\nDerecha 2\n\nDerecha 3\nDerecha 4",
    );
  });

  it("keeps a few right-aligned dates joined to their rows instead of making a column", () => {
    const rows = [
      [item("Fintonic Latam — Tech Lead", 50, 700), item("2021 – actualidad", 400, 700)],
      [item("Mercado Local — Backend Ssr.", 50, 688), item("2018 – 2021", 400, 688)],
      [item("Freelance — Full Stack", 50, 676), item("2016 – 2018", 400, 676)],
    ].flat();
    const result = orderTextItems(rows, PAGE);

    expect(result.layout).toBe("single-column");
    expect(result.text).toBe(
      "Fintonic Latam — Tech Lead 2021 – actualidad\nMercado Local — Backend Ssr. 2018 – 2021\nFreelance — Full Stack 2016 – 2018",
    );
  });

  it("does not treat a short line plus a long line as two columns", () => {
    const items = [
      item("HABILIDADES", 50, 700),
      item("Backend: Node.js, TypeScript, NestJS, Express, PostgreSQL, MongoDB, Kafka", 50, 688),
      item("DevOps: Docker", 50, 676),
      item("Metodologías: Scrum, Kanban", 50, 664),
    ];
    const result = orderTextItems(items, PAGE);
    expect(result.layout).toBe("single-column");
    expect(result.text.split("\n")).toHaveLength(4);
  });

  it("ignores items with non-finite coordinates", () => {
    const items = [item("ok", 50, 700), item("bad", Number.NaN, 700)];
    expect(orderTextItems(items, PAGE).text).toBe("ok");
  });

  describe("tables vs columns (stream order)", () => {
    it("keeps 4+ rows with right-aligned dates joined per row (emitted row by row)", () => {
      const rows: [string, string][] = [
        ["Licenciatura en Sistemas — UBA", "2010 – 2015"],
        ["Curso de Kubernetes — Platzi", "2016 – actualidad"],
        ["Diplomatura en Datos — UTN", "2017 – 2018"],
        ["Inglés técnico — Cultural Inglesa", "2019"],
      ];
      const rightEdge = 540;
      const items = rows.flatMap(([entry, date], index) => [
        item(entry, 50, 700 - index * 12),
        item(date, rightEdge - date.length * CHAR, 700 - index * 12),
      ]);
      const result = orderTextItems(items, PAGE);

      expect(result.layout).toBe("single-column");
      expect(result.text).toBe(rows.map(([entry, date]) => `${entry} ${date}`).join("\n"));
    });

    it("keeps a Europass-style left date column with 5 entries joined per row", () => {
      const rows: [string, string][] = [
        ["2019 – actualidad", "Tech Lead Backend, Fintonic Latam"],
        ["2015 – 2019", "Desarrolladora Backend Ssr., Mercado Local S.A."],
        ["2012 – 2015", "Desarrolladora Full Stack, Freelance"],
        ["2010", "Pasantía en sistemas, Municipalidad de Córdoba"],
        ["2008 – 2010", "Ayudante de cátedra, UTN FRC"],
      ];
      const items = rows.flatMap(([date, entry], index) => [
        item(date, 50, 700 - index * 12),
        item(entry, 150, 700 - index * 12),
      ]);
      const result = orderTextItems(items, PAGE);

      expect(result.layout).toBe("single-column");
      expect(result.text).toBe(rows.map(([date, entry]) => `${date} ${entry}`).join("\n"));
    });

    it("reads a 3-line sidebar on the main column's baseline grid sidebar-first", () => {
      const sidebar = column(["CONTACTO", "mf@example.com", "+54 9 11 5555"], 40, 700);
      const main = column(
        [
          "MARÍA LÓPEZ",
          "Rol",
          "Empresa 1",
          "Rol 2",
          "Empresa 2",
          "Descripción del puesto",
          "Empresa 3",
          "Rol 3",
        ],
        220,
        700,
      );
      // Emitted column by column, as Word tables and Canva grids do.
      const result = orderTextItems([...sidebar, ...main], PAGE);

      expect(result.layout).toBe("multi-column");
      expect(result.text).toBe(
        "CONTACTO\nmf@example.com\n+54 9 11 5555\n\nMARÍA LÓPEZ\nRol\nEmpresa 1\nRol 2\nEmpresa 2\nDescripción del puesto\nEmpresa 3\nRol 3",
      );
    });

    it("still reads two columns of free text when the producer emitted them row by row", () => {
      const left = [
        "Diseñé la arquitectura de pagos (NestJS, Kafka)",
        "que procesa 1,2 M de transacciones mensuales",
        "Reduje el tiempo de despliegue de 40 a 8 min",
        "con GitHub Actions y Kubernetes en producción",
        "Mentoría de 4 desarrolladores junior del equipo",
        "Integración con Mercado Pago y AFIP para facturar",
      ];
      const right = [
        "Desarrolladora backend con 7 años de experiencia",
        "construyendo APIs y sistemas distribuidos en Node",
        "Lideré equipos de hasta 5 personas y migraciones",
        "a microservicios en fintech y comercio electrónico",
        "Busco un rol de liderazgo técnico en producto",
      ];
      // Canva worst case: items interleaved by row (left[i], right[i], left[i+1], ...).
      const items: TextItem[] = [];
      for (let i = 0; i < left.length; i++) {
        items.push(item(left[i] as string, 50, 700 - i * 12));
        if (right[i] !== undefined) {
          items.push(item(right[i] as string, 330, 700 - i * 12));
        }
      }
      const result = orderTextItems(items, PAGE);

      expect(result.layout).toBe("multi-column");
      expect(result.text).toBe(`${left.join("\n")}\n\n${right.join("\n")}`);
    });

    it("reads interleaved long cells that pair up line for line as table rows", () => {
      // Documented limit: equal line counts, matching baselines and row-major emission read as
      // a table even when both cells are long text.
      const rows: [string, string][] = [
        ["Responsable de la plataforma de pagos", "Fintonic Latam, Buenos Aires, Argentina"],
        ["Desarrollo de APIs REST para el checkout", "Mercado Local S.A., Córdoba, Argentina"],
        ["Sitios y tiendas online para pymes locales", "Freelance, trabajo remoto desde Rosario"],
        ["Ayudante de cátedra de Algoritmos y Datos", "Universidad Tecnológica Nacional, FRC"],
      ];
      const items = rows.flatMap(([a, b], index) => [
        item(a, 50, 700 - index * 12),
        item(b, 330, 700 - index * 12),
      ]);
      const result = orderTextItems(items, PAGE);

      expect(result.layout).toBe("single-column");
      expect(result.text).toBe(rows.map(([a, b]) => `${a} ${b}`).join("\n"));
    });
  });

  describe("side-by-side blocks under a single-column body", () => {
    // Canva-style page: ten full-width lines, then "LANGUAGES" (3 lines, x 50–250) next to
    // "TECHNICAL SKILLS" (6 lines, x 320–560), both blocks starting on the same baseline.
    const body = Array.from(
      { length: 10 },
      (_, i) => `Línea ${i + 1} de la experiencia a todo el ancho de la página, sin cortes....`,
    );
    const languages = ["LANGUAGES", "English (C1)", "Spanish (native)"];
    const skills = [
      "TECHNICAL SKILLS",
      "Python, Pandas",
      "SQL, PostgreSQL",
      "Docker, Kubernetes",
      "Git, GitHub Actions",
      "AWS (S3, Lambda)",
    ];
    const expected = [body.join("\n"), languages.join("\n"), skills.join("\n")].join("\n\n");

    /** Body items followed by the two blocks, `gap` points below the last body line. */
    function page(gap: number, order: "column-major" | "row-major"): TextItem[] {
      const top = 700 - (body.length - 1) * 12 - gap;
      const left = column(languages, 50, top);
      const right = column(skills, 320, top);
      const blocks: TextItem[] = [];
      if (order === "column-major") {
        blocks.push(...left, ...right);
      } else {
        for (let i = 0; i < right.length; i++) {
          const l = left[i];
          if (l) blocks.push(l);
          blocks.push(right[i] as TextItem);
        }
      }
      for (const b of body) expect(b.length * CHAR).toBeGreaterThan(320 - 50);
      return [...column(body, 50, 700), ...blocks];
    }

    it("reads the blocks one after the other when no vertical gap separates them from the body", () => {
      // Needs peeling the whole 10-line body off the top, beyond the 8-line / 40% cap.
      const result = orderTextItems(page(12, "column-major"), PAGE);
      expect(result.layout).toBe("multi-column");
      expect(result.text).toBe(expected);
    });

    it("reads the blocks one after the other when the producer emitted them row by row", () => {
      // The band is isolated by its gap, but the stream interleaves the sides: short lines and
      // 3 vs 6 lines fail the free-text rule, so the side-by-side block rule has to decide.
      for (const gap of [12, 30]) {
        const result = orderTextItems(page(gap, "row-major"), PAGE);
        expect(result.layout).toBe("multi-column");
        expect(result.text).toBe(expected);
      }
    });

    it("reads two headed blocks of equal length emitted row by row as blocks", () => {
      const left = column(["IDIOMAS", "Inglés C1", "Portugués B2"], 50, 700);
      const right = column(["HABILIDADES", "Node.js", "Docker"], 330, 700);
      const items = [left[0], right[0], left[1], right[1], left[2], right[2]] as TextItem[];
      const result = orderTextItems(items, PAGE);
      expect(result.layout).toBe("multi-column");
      expect(result.text).toBe("IDIOMAS\nInglés C1\nPortugués B2\n\nHABILIDADES\nNode.js\nDocker");
    });

    it("recognizes taller first lines as block headings when they are not all caps", () => {
      const left = column(["Idiomas", "Inglés C1", "Portugués B2"], 50, 700);
      const right = column(["Habilidades", "Node.js", "Docker"], 330, 700);
      for (const heading of [left[0], right[0]] as TextItem[]) heading.height = 14;
      const items = [left[0], right[0], left[1], right[1], left[2], right[2]] as TextItem[];
      expect(orderTextItems(items, PAGE).text).toBe(
        "Idiomas\nInglés C1\nPortugués B2\n\nHabilidades\nNode.js\nDocker",
      );
    });

    it("still joins a row-major table whose last cell wraps to one extra line", () => {
      const rows = [
        [item("2020 – 2024", 50, 700), item("Licenciatura en Sistemas, UBA", 150, 700)],
        [item("2018 – 2019", 50, 688), item("Curso de Python, Coderhouse", 150, 688)],
        [item("Certificado con honores", 150, 676)],
      ].flat();
      const result = orderTextItems(rows, PAGE);
      expect(result.layout).toBe("single-column");
      expect(result.text).toBe(
        "2020 – 2024 Licenciatura en Sistemas, UBA\n2018 – 2019 Curso de Python, Coderhouse\nCertificado con honores",
      );
    });

    it("still joins a Europass table whose rows all have multi-line cells", () => {
      // Unpaired right-side lines sit BETWEEN the left-side lines: not top-aligned blocks.
      const rows = [
        [item("2019 – actualidad", 50, 700), item("Tech Lead Backend, Fintonic Latam", 150, 700)],
        [item("Lideré el equipo de pagos", 150, 688)],
        [item("2015 – 2019", 50, 676), item("Desarrolladora Backend Ssr.", 150, 676)],
        [item("Desarrollo de APIs REST", 150, 664)],
        [item("2012 – 2015", 50, 652), item("Desarrolladora Full Stack", 150, 652)],
        [item("Sitios para pymes", 150, 640)],
      ].flat();
      const result = orderTextItems(rows, PAGE);
      expect(result.layout).toBe("single-column");
      expect(result.text.split("\n")).toHaveLength(6);
      expect(result.text).toContain("2015 – 2019 Desarrolladora Backend Ssr.");
    });

    it("does not peel a long table row by row looking for columns", () => {
      // 30 rows emitted row by row: every suffix has the geometric hole; none is a column split.
      const items: TextItem[] = [];
      for (let r = 0; r < 30; r++) {
        items.push(item(`Entrada ${r} de la tabla`, 50, 700 - r * 12));
        items.push(item(`20${String(10 + (r % 15)).padStart(2, "0")}`, 400, 700 - r * 12));
      }
      const result = orderTextItems(items, PAGE);
      expect(result.layout).toBe("single-column");
      expect(result.text.split("\n")).toHaveLength(30);
      expect(result.text).toContain("Entrada 29 de la tabla 2024");
    });
  });

  describe("overprinted text", () => {
    it("drops a duplicate of the same text at (almost) the same position", () => {
      const items = [
        item("MARÍA LÓPEZ", 50, 700),
        item("MARÍA LÓPEZ", 50.4, 700.3),
        item("Backend", 50, 688),
      ];
      expect(orderTextItems(items, PAGE).text).toBe("MARÍA LÓPEZ\nBackend");
    });

    it("keeps the same text at a different position", () => {
      // Same text one line below, and again on the first line one character to the right.
      const items = [item("2019", 50, 700), item("2019", 50, 688), item("2019", 72, 700)];
      expect(orderTextItems(items, PAGE).text).toBe("2019 2019\n2019");
    });

    it("drops a drop-shadow copy offset by up to 15% of the glyph height", () => {
      // 28 pt name drawn twice, 1.5 pt down and right (the old 1 pt rule kept the copy).
      const name = { height: 28 };
      const items = [
        item("LORENA", 50, 700, { ...name, width: 100 }),
        item("LORENA", 51.5, 698.5, { ...name, width: 100 }),
        item("FRANCO", 50, 668, { ...name, width: 100 }),
        item("FRANCO", 51.5, 666.5, { ...name, width: 100 }),
        item("Backend developer", 50, 640),
      ];
      expect(orderTextItems(items, PAGE).text).toBe("LORENA\nFRANCO\nBackend developer");
    });

    it("uses a 2 pt floor for small text and ignores trailing spaces in the comparison", () => {
      const items = [
        item("LORENA ", 50, 700),
        item("LORENA", 51.5, 701.5),
        item("Backend", 50, 688),
      ];
      expect(orderTextItems(items, PAGE).text).toBe("LORENA\nBackend");
    });

    it("drops a same-line copy whose vertical offset exceeds the overprint tolerance", () => {
      // Shadow 3 pt below (same baseline line at 10 pt, tolerance 5) starting 0.5 pt right.
      const items = [item("FRANCO", 50, 700), item("FRANCO", 50.5, 697), item("Dev", 50, 688)];
      expect(orderTextItems(items, PAGE).text).toBe("FRANCO\nDev");
    });

    it("keeps genuinely repeated words on a line", () => {
      const items = [item("muy", 50, 700), item("muy", 70, 700), item("bueno", 90, 700)];
      expect(orderTextItems(items, PAGE).text).toBe("muy muy bueno");
    });
  });

  describe("hyphenation at line breaks", () => {
    it("joins a word hyphenated across lines when the continuation is lowercase", () => {
      const items = column(["Habilidades de Comunica-", "ción efectiva y liderazgo"], 50, 700);
      expect(orderTextItems(items, PAGE).text).toBe(
        "Habilidades de Comunicación efectiva y liderazgo",
      );
    });

    it("keeps the hyphen when the next line starts with a capital or a digit", () => {
      expect(orderTextItems(column(["Desarrollador Full-", "Stack"], 50, 700), PAGE).text).toBe(
        "Desarrollador Full-\nStack",
      );
      expect(orderTextItems(column(["Período 2019-", "2021"], 50, 700), PAGE).text).toBe(
        "Período 2019-\n2021",
      );
    });

    it("needs at least three letters on each side of the break", () => {
      expect(dehyphenate(["co-", "fundador"])).toEqual(["co-", "fundador"]);
      expect(dehyphenate(["Comunica-", "ción"])).toEqual(["Comunicación"]);
      expect(dehyphenate(["Node.js -", "backend"])).toEqual(["Node.js -", "backend"]);
      expect(dehyphenate(["una línea", "otra"])).toEqual(["una línea", "otra"]);
    });

    it("does not join across blocks", () => {
      const items = [...column(["Comunica-"], 50, 700), ...column(["ción", "efectiva"], 50, 640)];
      expect(orderTextItems(items, PAGE).text).toBe("Comunica-\n\nción\nefectiva");
    });
  });

  describe("header and footer peeling", () => {
    it("peels a header and a footer at once when no vertical gap separates them", () => {
      const header = item(
        "MARÍA FERNANDA LÓPEZ GARCÍA · CABA · +54 9 11 5555-1234 · mfernanda@example.com",
        50,
        700,
      );
      const left = column(
        [
          "EXPERIENCIA",
          "Fintonic Latam",
          "Tech Lead Backend",
          "Mercado Local",
          "Backend Ssr.",
          "Freelance",
          "Full Stack",
          "Sitios web",
        ],
        50,
        688,
      );
      const right = column(
        [
          "HABILIDADES",
          "Node.js",
          "TypeScript",
          "NestJS",
          "Docker",
          "IDIOMAS",
          "Español",
          "Inglés",
        ],
        330,
        688,
      );
      const footer = item(
        "Referencias disponibles a pedido · CABA, Argentina · Página 1 de 1 · mfernanda@example.com",
        50,
        592,
      );
      const result = orderTextItems([header, ...left, ...right, footer], PAGE);

      expect(result.layout).toBe("multi-column");
      expect(result.text).toBe(
        [
          header.str,
          left.map((i) => i.str).join("\n"),
          right.map((i) => i.str).join("\n"),
          footer.str,
        ].join("\n\n"),
      );
    });
  });

  describe("narrow sidebars", () => {
    const main = [
      "Desarrolladora backend con 7 años de experiencia construyendo APIs en Node.js",
      "Lideré equipos de hasta 5 personas y migraciones a microservicios en fintech",
      "Diseñé la arquitectura de pagos (NestJS, PostgreSQL, Kafka) de Fintonic Latam",
      "Reduje el tiempo de despliegue de 40 a 8 minutos con GitHub Actions y Kubernetes",
      "Desarrollo de APIs REST en Express y MongoDB para el carrito y el checkout",
      "Integración con Mercado Pago y AFIP para facturación electrónica de pymes",
    ];

    it("accepts a gutter outside the 20–80% window when it is wide relative to the page", () => {
      const sidebar = ["CONTACTO", "CABA", "+54 9 11", "mf@ex.com", "SKILLS", "Node.js", "Docker"];
      const items = [...column(sidebar, 10, 700), ...column(main, 110, 700)];
      const result = orderTextItems(items, PAGE);

      expect(result.layout).toBe("multi-column");
      expect(result.text).toBe(`${sidebar.join("\n")}\n\n${main.join("\n")}`);
    });

    it("needs 4 lines per side for a gutter accepted only by the page-relative floor", () => {
      const items = [...column(["Tel", "Email"], 10, 700), ...column(main.slice(0, 2), 110, 700)];
      const result = orderTextItems(items, PAGE);

      expect(result.layout).toBe("single-column");
      expect(result.text).toBe(`Tel ${main[0]}\nEmail ${main[1]}`);
    });
  });
});
