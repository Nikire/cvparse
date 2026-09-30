import { describe, expect, it } from "vitest";
import {
  BasicsSchema,
  EducationSchema,
  ExtensionLocationSchema,
  ExtensionSchema,
  ISO_DATE_REGEX,
  isIsoDate,
  RESUME_EXTRACTION_JSON_SCHEMA,
  RESUME_JSON_SCHEMA,
  type Resume,
  ResumeExtractionSchema,
  ResumeSchema,
  SkillSchema,
  WorkSchema,
} from "../src/index.js";

const spanishResume: Resume = {
  basics: {
    name: "Carlos Andrés Ramírez Mejía",
    label: "Ejecutivo de Ventas B2B",
    email: "carlos.ramirez@example.com",
    phone: "+57 300 456 7890",
    location: { city: "Medellín", region: "Antioquia", countryCode: "CO" },
  },
  work: [
    {
      name: "SaludTech Colombia S.A.S.",
      position: "Ejecutivo de Cuentas Senior",
      location: "Medellín",
      startDate: "2022-01",
      endDate: null,
      highlights: ["Cierre de 35 cuentas nuevas en 2023 (120% de la meta anual)."],
    },
    {
      name: "Distribuidora Médica del Norte",
      position: "Asesor Comercial",
      startDate: "2019-03-15",
      endDate: "2021-12",
    },
  ],
  education: [
    {
      institution: "Universidad de Antioquia",
      area: "Administración de Empresas",
      studyType: "Profesional",
      startDate: "2014",
      endDate: "2018",
    },
  ],
  skills: [{ name: "CRM", keywords: ["HubSpot", "Salesforce"] }],
  languages: [
    { language: "Español", fluency: "nativo" },
    { language: "Inglés", fluency: "B1" },
  ],
  x_cvparse: {
    detectedLanguage: "es",
    normalizedSkills: ["crm", "hubspot", "salesforce", "negotiation", "excel"],
    location: {
      countryCode: "CO",
      adminRegion: "Antioquia",
      city: "Medellín",
      raw: "Medellín, Antioquia, Colombia",
    },
    confidenceNotes: [],
  },
};

describe("ResumeSchema", () => {
  it("accepts a complete Spanish resume", () => {
    const result = ResumeSchema.safeParse(spanishResume);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.basics?.name).toBe("Carlos Andrés Ramírez Mejía");
  });

  it("accepts an empty object (every field is optional)", () => {
    expect(ResumeSchema.safeParse({}).success).toBe(true);
  });

  it("accepts null for any field", () => {
    const result = ResumeSchema.safeParse({
      basics: null,
      work: null,
      education: [{ institution: null, startDate: null, courses: null }],
      x_cvparse: null,
    });
    expect(result.success).toBe(true);
  });

  it("rejects non-ISO dates", () => {
    for (const bad of ["Marzo 2021", "03/2021", "2021-3", "2021-13", "2021-02-30x", "20211"]) {
      const result = WorkSchema.safeParse({ startDate: bad });
      expect(result.success, bad).toBe(false);
    }
  });

  it("accepts the three ISO precisions", () => {
    for (const good of ["2021", "2021-03", "2021-03-15"]) {
      expect(WorkSchema.safeParse({ startDate: good }).success, good).toBe(true);
    }
  });

  it("rejects wrong types", () => {
    expect(BasicsSchema.safeParse({ name: 42 }).success).toBe(false);
    expect(SkillSchema.safeParse({ keywords: "Node.js" }).success).toBe(false);
    expect(EducationSchema.safeParse({ courses: [1, 2] }).success).toBe(false);
    expect(ResumeSchema.safeParse({ work: {} }).success).toBe(false);
    expect(ResumeSchema.safeParse("not an object").success).toBe(false);
  });

  it("strips unknown keys so JSON Resume consumers do not choke", () => {
    const result = ResumeSchema.safeParse({ basics: { name: "Ana", foo: "bar" }, extra: 1 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ basics: { name: "Ana" } });
    }
  });
});

describe("ResumeExtractionSchema", () => {
  it("accepts non-ISO dates (they are normalized after extraction)", () => {
    const result = ResumeExtractionSchema.safeParse({
      work: [{ startDate: "Marzo 2021", endDate: "Actualidad" }],
    });
    expect(result.success).toBe(true);
  });

  it("has the same top-level keys as ResumeSchema", () => {
    expect(Object.keys(ResumeExtractionSchema.shape)).toEqual(Object.keys(ResumeSchema.shape));
  });

  it("marks every property required-but-nullable (strict structured outputs need this)", () => {
    type JsonSchema = {
      type?: string | string[];
      anyOf?: JsonSchema[];
      properties?: Record<string, JsonSchema>;
      required?: string[];
      additionalProperties?: boolean;
      items?: JsonSchema;
      description?: string;
    };
    // Nullable fields serialize as either `type: [T, "null"]` or `anyOf: [T, { type: "null" }]`.
    const unwrapNullable = (node: JsonSchema, path: string): JsonSchema => {
      if (node.anyOf) {
        const nonNull = node.anyOf.filter((n) => n.type !== "null");
        expect(node.anyOf.length - nonNull.length, `${path} allows null`).toBe(1);
        expect(nonNull, path).toHaveLength(1);
        return nonNull[0] as JsonSchema;
      }
      expect(node.type, `${path} allows null`).toContain("null");
      return node;
    };
    const visit = (node: JsonSchema, path: string) => {
      if (node.properties) {
        expect(node.required, path).toEqual(Object.keys(node.properties));
        expect(node.additionalProperties, path).toBe(false);
        for (const [key, child] of Object.entries(node.properties)) {
          visit(unwrapNullable(child, `${path}.${key}`), `${path}.${key}`);
        }
      }
      if (node.items) visit(node.items, `${path}[]`);
    };
    const json = RESUME_EXTRACTION_JSON_SCHEMA as JsonSchema;
    visit(json, "$");
    const basics = unwrapNullable(json.properties?.basics as JsonSchema, "$.basics");
    const name = unwrapNullable(basics.properties?.name as JsonSchema, "$.basics.name");
    expect(name.description).toBe("Full name of the candidate.");
  });

  it("validates leniently: missing keys are fine, wrong types are not", () => {
    expect(ResumeExtractionSchema.safeParse({ basics: { name: "Ana" } }).success).toBe(true);
    expect(ResumeExtractionSchema.safeParse({ basics: { name: 1 } }).success).toBe(false);
  });
});

describe("ISO date helpers", () => {
  it("isIsoDate / ISO_DATE_REGEX agree", () => {
    expect(isIsoDate("1999")).toBe(true);
    expect(isIsoDate("1999-12-31")).toBe(true);
    expect(isIsoDate("1999-12-32")).toBe(false);
    expect(isIsoDate(1999)).toBe(false);
    expect(ISO_DATE_REGEX.test("2020-00")).toBe(false);
  });
});

describe("RESUME_JSON_SCHEMA", () => {
  it("is a JSON Schema object with the JSON Resume sections", () => {
    expect(RESUME_JSON_SCHEMA.$schema).toContain("json-schema.org");
    expect(RESUME_JSON_SCHEMA.type).toBe("object");
    const properties = RESUME_JSON_SCHEMA.properties as Record<string, unknown>;
    for (const key of [
      "basics",
      "work",
      "volunteer",
      "education",
      "awards",
      "certificates",
      "publications",
      "skills",
      "languages",
      "interests",
      "references",
      "projects",
      "x_cvparse",
    ]) {
      expect(properties, key).toHaveProperty(key);
    }
  });

  it("round-trips through JSON", () => {
    expect(JSON.parse(JSON.stringify(RESUME_JSON_SCHEMA))).toEqual(RESUME_JSON_SCHEMA);
  });
});

describe("x_cvparse extension keys", () => {
  // README.md / README.es.md document these names; renaming one must update the docs too.
  it("match the documented shape", () => {
    expect(Object.keys(ExtensionSchema.shape)).toEqual([
      "detectedLanguage",
      "normalizedSkills",
      "location",
      "confidenceNotes",
    ]);
    expect(Object.keys(ExtensionLocationSchema.shape)).toEqual([
      "countryCode",
      "adminRegion",
      "city",
      "raw",
    ]);
  });
});
