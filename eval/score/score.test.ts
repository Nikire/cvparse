import { describe, expect, it } from "vitest";
import type { GroundTruth, Prediction } from "../types.js";
import {
  cityMatches,
  nameTokens,
  normalizeCity,
  normalizeDateValue,
  normalizeEmail,
  normalizeLanguage,
  normalizePhone,
  normalizeSkill,
  normalizeText,
  parsePhone,
  phonesMatch,
  splitPhones,
} from "./normalize.js";
import {
  aggregate,
  assign,
  COMMON_FIELDS,
  educationWithCertificates,
  fromCounts,
  scoreDates,
  scoreEntry,
} from "./score.js";

const truth: GroundTruth = {
  basics: {
    name: "María José Gómez",
    email: "Maria.Gomez+cv@Gmail.com",
    phone: "+54 9 351 555-1234",
    location: { city: "Córdoba", countryCode: "AR" },
  },
  work: [
    {
      name: "Mercado Libre S.R.L.",
      position: "Desarrolladora Backend Senior",
      startDate: "2021-03",
      endDate: null,
    },
    { name: "Globant", position: "Desarrolladora Node.js", startDate: "2018", endDate: "2021-02" },
  ],
  education: [
    {
      institution: "Universidad Nacional de Córdoba",
      studyType: "Licenciatura",
      area: "Ciencias de la Computación",
      startDate: "2012",
      endDate: "2017",
    },
  ],
  skills: [
    { name: "Backend", keywords: ["Node.js", "TypeScript", "PostgreSQL"] },
    { name: "Docker" },
  ],
  languages: [{ language: "Español" }, { language: "Inglés", fluency: "C1" }],
  x_cvparse: {
    educationLevels: [{ level: "bachelor", original: "Licenciatura", canonical: "Licenciatura" }],
  },
};

const clone = (value: GroundTruth): GroundTruth => structuredClone(value);

describe("normalization", () => {
  it("strips accents, case, punctuation and extra whitespace", () => {
    expect(normalizeText("  Ciencias de la  Computación, UNC! ")).toBe(
      "ciencias de la computacion unc",
    );
    expect(normalizeText(null)).toBe("");
  });
  it("keeps @ . + in emails", () => {
    expect(normalizeEmail(" María.Gómez+cv@GMAIL.com ")).toBe("maria.gomez+cv@gmail.com");
  });
  it("compares phones on the last 8 digits", () => {
    expect(normalizePhone("+54 9 351 555-1234")).toBe(normalizePhone("(0351) 555-1234"));
    expect(normalizePhone("(011) 4555-1234")).toBe("45551234");
  });
  it("keeps C++ and C# apart from C", () => {
    expect(normalizeSkill("C++")).toBe("c++");
    expect(normalizeSkill("C#")).toBe("c#");
    expect(normalizeSkill("C.")).toBe("c");
    expect(normalizeSkill("Node.js")).toBe("node.js");
  });
  it("maps language names in es/en/pt to ISO codes", () => {
    expect(normalizeLanguage("Inglés")).toBe("en");
    expect(normalizeLanguage("ingles (C1)")).toBe("en");
    expect(normalizeLanguage("English")).toBe("en");
    expect(normalizeLanguage("Português")).toBe("pt");
    expect(normalizeLanguage("Castellano")).toBe("es");
    expect(normalizeLanguage("en")).toBe("en");
    expect(normalizeLanguage("Klingon")).toBe("klingon");
  });
  it("treats present/actualidad as ongoing", () => {
    expect(normalizeDateValue("Actualidad")).toBeNull();
    expect(normalizeDateValue("Present")).toBeNull();
    expect(normalizeDateValue("")).toBeNull();
    expect(normalizeDateValue("2021-03")).toBe("2021-03");
    expect(normalizeDateValue("marzo 2021")).toBe("marzo 2021");
  });
});

describe("fromCounts", () => {
  it("computes precision, recall and F1", () => {
    expect(fromCounts(2, 1, 1)).toMatchObject({ precision: 2 / 3, recall: 2 / 3, support: 3 });
    expect(fromCounts(0, 0, 3).f1).toBe(0);
    expect(fromCounts(0, 2, 0).f1).toBe(0);
  });
});

describe("scoreEntry", () => {
  it("gives a perfect score to the truth itself", () => {
    const scores = scoreEntry(truth, clone(truth));
    for (const [field, score] of Object.entries(scores)) {
      expect(score?.f1, field).toBe(1);
    }
    expect(Object.keys(scores).sort()).toEqual(
      [
        "basics.email",
        "basics.location",
        "basics.name",
        "basics.phone",
        "education.dates",
        "education.entries",
        "education.level",
        "languages",
        "skills",
        "work.dates",
        "work.entries",
      ].sort(),
    );
  });

  it("scores a null prediction as all false negatives", () => {
    const scores = scoreEntry(truth, null, { educationLevel: true });
    expect(scores["basics.name"]).toMatchObject({ tp: 0, fp: 0, fn: 1, f1: 0 });
    expect(scores["work.entries"]).toMatchObject({ tp: 0, fp: 0, fn: 2 });
    // 2 start dates + 2 end dates (the ongoing one included)
    expect(scores["work.dates"]).toMatchObject({ tp: 0, fp: 0, fn: 4 });
    expect(scores["education.level"]).toMatchObject({ fn: 1 });
    expect(scores.skills).toMatchObject({ tp: 0, fn: 4 });
    expect(scores.languages).toMatchObject({ tp: 0, fn: 2 });
  });

  it("does not score education.level for predictions without x_cvparse", () => {
    const predicted = clone(truth);
    delete predicted.x_cvparse;
    expect(scoreEntry(truth, predicted)["education.level"]).toBeUndefined();
    expect(scoreEntry(truth, null)["education.level"]).toBeUndefined();
  });

  it("is accent and case insensitive", () => {
    const predicted = clone(truth);
    predicted.basics = {
      name: "MARIA JOSE GOMEZ",
      email: "maria.gomez+cv@gmail.com",
      phone: "351 5551234",
      location: { city: "cordoba", countryCode: "ar" },
    };
    predicted.skills = [
      { name: "Tech", keywords: ["node.js", "typescript", "postgresql", "DOCKER"] },
    ];
    predicted.languages = [{ language: "espanol" }, { language: "ingles" }];
    const scores = scoreEntry(truth, predicted);
    expect(scores["basics.name"]?.f1).toBe(1);
    expect(scores["basics.email"]?.f1).toBe(1);
    expect(scores["basics.phone"]?.f1).toBe(1);
    expect(scores["basics.location"]?.f1).toBe(1);
    expect(scores.skills?.f1).toBe(1);
    expect(scores.languages?.f1).toBe(1);
  });

  it("matches names by token Jaccard >= 0.8", () => {
    const fourTokens: GroundTruth = { basics: { name: "Juan Carlos Pérez López" } };
    expect(
      scoreEntry(fourTokens, { basics: { name: "López Pérez Juan Carlos" } })["basics.name"]?.f1,
    ).toBe(1);
    // 3/4 = 0.75 → miss (FP + FN)
    expect(
      scoreEntry(fourTokens, { basics: { name: "Juan Pérez López" } })["basics.name"],
    ).toMatchObject({
      tp: 0,
      fp: 1,
      fn: 1,
    });
  });

  it("scores a wrong email as FP + FN and a hallucinated one as FP", () => {
    expect(
      scoreEntry(truth, { basics: { email: "otra@gmail.com" } })["basics.email"],
    ).toMatchObject({
      tp: 0,
      fp: 1,
      fn: 1,
    });
    expect(scoreEntry({}, { basics: { email: "x@y.com" } })["basics.email"]).toMatchObject({
      tp: 0,
      fp: 1,
      fn: 0,
      support: 0,
    });
    expect(scoreEntry({}, {})["basics.email"]).toBeUndefined();
  });

  it("requires country codes to agree only when both are present", () => {
    const t: GroundTruth = { basics: { location: { city: "Córdoba", countryCode: "AR" } } };
    expect(
      scoreEntry(t, { basics: { location: { city: "Cordoba" } } })["basics.location"]?.f1,
    ).toBe(1);
    expect(
      scoreEntry(t, { basics: { location: { city: "Córdoba", countryCode: "ES" } } })[
        "basics.location"
      ]?.f1,
    ).toBe(0);
    expect(
      scoreEntry(t, { x_cvparse: { location: { city: "Córdoba", countryCode: "AR" } } })[
        "basics.location"
      ]?.f1,
    ).toBe(1);
  });

  it("matches work entries by company + position and ignores legal suffixes", () => {
    const predicted: GroundTruth = {
      work: [
        // order swapped, suffix dropped, position slightly different
        {
          name: "Globant",
          position: "Desarrolladora Node.js",
          startDate: "2018-05",
          endDate: "2021-02",
        },
        { name: "Mercado Libre", position: "Desarrolladora Backend Sr", startDate: "2021-03-01" },
        { name: "Freelance", position: "Consultora", startDate: "2016" },
      ],
    };
    const scores = scoreEntry(truth, predicted);
    expect(scores["work.entries"]).toMatchObject({ tp: 2, fp: 1, fn: 0 });
    // more precise predictions compare at the truth precision; ongoing (null/null) is a TP
    expect(scores["work.dates"]).toMatchObject({ tp: 4, fp: 0, fn: 0 });
  });

  it("counts date mismatches as FP + FN and less precise predictions as mismatches", () => {
    const predicted: GroundTruth = {
      work: [
        {
          name: "Mercado Libre",
          position: "Desarrolladora Backend Senior",
          startDate: "2021",
          endDate: "2023-01",
        },
        {
          name: "Globant",
          position: "Desarrolladora Node.js",
          startDate: "2019",
          endDate: "Present",
        },
      ],
    };
    const scores = scoreEntry(truth, predicted);
    expect(scores["work.entries"]).toMatchObject({ tp: 2, fp: 0, fn: 0 });
    // ML start "2021" vs "2021-03" → miss; ML end "2023-01" vs ongoing → miss;
    // Globant start 2019 vs 2018 → miss; Globant end ongoing vs 2021-02 → FN only
    expect(scores["work.dates"]).toMatchObject({ tp: 0, fp: 3, fn: 4 });
  });

  it("rejects entries below the 0.5 similarity threshold and counts their dates as FN", () => {
    const predicted: GroundTruth = {
      work: [{ name: "Accenture", position: "Analista", startDate: "2021-03" }],
    };
    const scores = scoreEntry(truth, predicted);
    expect(scores["work.entries"]).toMatchObject({ tp: 0, fp: 1, fn: 2 });
    expect(scores["work.dates"]).toMatchObject({ tp: 0, fp: 0, fn: 4 });
  });

  it("matches education by institution + studyType/area and scores levels on matched pairs", () => {
    const predicted: GroundTruth = {
      education: [
        {
          institution: "Universidad Nacional de Cordoba",
          studyType: "Lic.",
          area: "Ciencias de la Computación",
          startDate: "2012-03",
          endDate: "2017",
        },
      ],
      x_cvparse: { educationLevels: [{ level: "master", original: "Lic.", canonical: null }] },
    };
    const scores = scoreEntry(truth, predicted);
    expect(scores["education.entries"]).toMatchObject({ tp: 1, fp: 0, fn: 0 });
    expect(scores["education.dates"]).toMatchObject({ tp: 2, fp: 0, fn: 0 });
    expect(scores["education.level"]).toMatchObject({ tp: 0, fp: 1, fn: 1 });
  });

  it("uses exact normalized skill names (no substring matches)", () => {
    const scores = scoreEntry(truth, {
      skills: [
        { name: "Node", keywords: ["Node", "TypeScript", "Postgres", "Docker", "Kubernetes"] },
      ],
    });
    // TypeScript and Docker hit; Node ≠ Node.js, Postgres ≠ PostgreSQL, Kubernetes is extra
    expect(scores.skills).toMatchObject({ tp: 2, fp: 3, fn: 2 });
  });
});

describe("assign", () => {
  it("finds the optimal assignment, not the greedy one", () => {
    // greedy would take (0,0)=0.9 and leave row 1 unmatched; optimal is (0,1)+(1,0)
    const pairs = assign([
      [0.9, 0.8],
      [0.85, 0.1],
    ]);
    expect(pairs).toEqual([
      [0, 1],
      [1, 0],
    ]);
  });
  it("ignores pairs below the threshold and handles empty input", () => {
    expect(assign([[0.4]])).toEqual([]);
    expect(assign([])).toEqual([]);
    expect(assign([[]])).toEqual([]);
  });
});

describe("aggregate", () => {
  it("micro-averages counts per field and averages field F1s", () => {
    const a = scoreEntry(truth, clone(truth));
    const b = scoreEntry(truth, null, { educationLevel: true });
    const { fields, overallF1 } = aggregate([{ fields: a }, { fields: b }]);
    expect(fields["work.entries"]).toMatchObject({
      tp: 2,
      fp: 0,
      fn: 2,
      precision: 1,
      recall: 0.5,
    });
    expect(fields["basics.name"]?.f1).toBeCloseTo(2 / 3);
    expect(fields["education.level"]).toBeDefined();
    // overall averages the common fields only (education.level is a cvparse-only diagnostic)
    const f1s = COMMON_FIELDS.flatMap((f) => (fields[f] ? [fields[f].f1] : []));
    expect(overallF1).toBeCloseTo(f1s.reduce((x, y) => x + y, 0) / f1s.length);
  });
  it("returns zero overall for no entries", () => {
    expect(aggregate([])).toEqual({ fields: {}, overallF1: 0 });
  });
  it("recovers counts from scores without tp/fp/fn", () => {
    const { fields } = aggregate([
      { fields: { skills: { precision: 0.5, recall: 0.5, f1: 0.5, support: 4 } } },
    ]);
    expect(fields.skills).toMatchObject({ tp: 2, fp: 2, fn: 2 });
  });
});

describe("review fixes", () => {
  it("excludes education.level from overallF1 and skips unsupported-format entries", () => {
    const perfect = scoreEntry(truth, clone(truth));
    const badLevel = clone(truth);
    badLevel.x_cvparse = {
      educationLevels: [{ level: "master", original: null, canonical: null }],
    };
    const { overallF1 } = aggregate([{ fields: scoreEntry(truth, badLevel) }]);
    expect(overallF1).toBe(1);
    expect(aggregate([{ fields: perfect }]).overallF1).toBe(1);
    const missed = scoreEntry(truth, null);
    // a skipped entry contributes nothing (it lowers coverage, not F1)
    expect(
      aggregate([{ fields: perfect }, { fields: missed, skipped: "unsupported-format" }]).overallF1,
    ).toBe(1);
    expect(COMMON_FIELDS).not.toContain("education.level");
    expect(COMMON_FIELDS).toHaveLength(10);
  });

  it("appends certificates to the predicted education list", () => {
    const t: GroundTruth = {
      education: [
        {
          institution: "Universidad de Chile",
          studyType: "Ingeniería",
          area: "Civil",
          endDate: "2015",
        },
        { institution: "Platzi", studyType: "Curso", area: "Scrum", endDate: "2020" },
      ],
      x_cvparse: {
        educationLevels: [
          { level: "bachelor", original: null, canonical: null },
          { level: "course", original: null, canonical: null },
        ],
      },
    };
    const predicted: Prediction = {
      education: [
        {
          institution: "Universidad de Chile",
          studyType: "Ingeniería",
          area: "Civil",
          endDate: "2015",
        },
      ],
      certificates: [{ name: "Curso Scrum", issuer: "Platzi", date: "2020" }],
      x_cvparse: { educationLevels: [{ level: "bachelor", original: null, canonical: null }] },
    };
    expect(educationWithCertificates(predicted)).toMatchObject({ fromCertificates: 1 });
    expect(educationWithCertificates(predicted).entries[1]).toEqual({
      institution: "Platzi",
      studyType: "Curso Scrum",
      endDate: "2020",
    });
    const scores = scoreEntry(t, predicted);
    expect(scores["education.entries"]).toMatchObject({ tp: 2, fp: 0, fn: 0 });
    expect(scores["education.dates"]).toMatchObject({ tp: 2, fp: 0, fn: 0 });
    // certificate-derived entries count as level "course"
    expect(scores["education.level"]).toMatchObject({ tp: 2, fp: 0, fn: 0 });
    // without certificates the course is missed
    const without = scoreEntry(t, { ...predicted, certificates: null });
    expect(without["education.entries"]).toMatchObject({ tp: 1, fn: 1 });
  });

  it("matches cities through aliases and token subsets", () => {
    expect(normalizeCity("Ciudad Autónoma de Buenos Aires")).toBe("buenos aires");
    expect(normalizeCity("CABA")).toBe("buenos aires");
    expect(normalizeCity("Capital Federal")).toBe("buenos aires");
    expect(normalizeCity("México D.F.")).toBe("ciudad de mexico");
    expect(normalizeCity("CDMX")).toBe("ciudad de mexico");
    expect(normalizeCity("Bogotá D.C.")).toBe("bogota");
    expect(cityMatches("Buenos Aires", "Ciudad Autónoma de Buenos Aires")).toBe(true);
    expect(cityMatches("Ciudad de México", "CDMX")).toBe(true);
    expect(cityMatches("Bogotá", "Bogotá D.C., Colombia")).toBe(true);
    expect(cityMatches("Medellín", "Medellín, Antioquia")).toBe(true);
    expect(cityMatches("Medellín", "Bogotá")).toBe(false);
    expect(cityMatches("San José", "San Juan")).toBe(false);
    const t: GroundTruth = {
      basics: { location: { city: "Buenos Aires", region: "CABA", countryCode: "AR" } },
    };
    expect(
      scoreEntry(t, { basics: { location: { city: "Ciudad Autónoma de Buenos Aires" } } })[
        "basics.location"
      ]?.f1,
    ).toBe(1);
  });

  it("compares phones by country code + national digits, with fallbacks and multiple numbers", () => {
    expect(parsePhone("+54 9 11 4567-1234")).toEqual({ country: "54", national: "91145671234" });
    expect(parsePhone("0054 11 4567 1234")).toEqual({ country: "54", national: "1145671234" });
    expect(parsePhone("(011) 4567-1234")).toEqual({ country: "", national: "1145671234" });
    expect(parsePhone("+598 99 123 456")).toEqual({ country: "598", national: "99123456" });
    // both with a country code: full national number must agree
    expect(phonesMatch("+54 9 11 4567-1234", "+54 9 11 4567 1234")).toBe(true);
    expect(phonesMatch("+54 9 11 4567-1234", "+56 9 11 4567 1234")).toBe(false);
    expect(phonesMatch("+57 300 123 4567", "+57 310 123 4567")).toBe(false);
    // one side without a code: last 8 digits
    expect(phonesMatch("+54 9 11 4567-1234", "11 4567-1234")).toBe(true);
    // neither: full digits
    expect(phonesMatch("4567-1234", "4567-1235")).toBe(false);
    // several numbers: best pair
    expect(splitPhones("+56 9 8765 4321 / +56 2 2345 6789")).toHaveLength(2);
    expect(phonesMatch("+56 2 2345 6789", "+56 9 8765 4321 / +56 2 2345 6789")).toBe(true);
    expect(
      scoreEntry(
        { basics: { phone: "+56 9 8765 4321" } },
        { basics: { phone: "+56 2 1111 2222, +56 9 8765 4321" } },
      )["basics.phone"]?.f1,
    ).toBe(1);
  });

  it("ignores name particles in the name Jaccard", () => {
    expect([...nameTokens("María de la Paz Gómez y Ruiz")]).toEqual([
      "maria",
      "paz",
      "gomez",
      "ruiz",
    ]);
    const t: GroundTruth = { basics: { name: "Juan de la Cruz Pérez" } };
    expect(scoreEntry(t, { basics: { name: "Juan Cruz Pérez" } })["basics.name"]?.f1).toBe(1);
  });

  it("treats more Spanish ongoing phrases as ongoing", () => {
    for (const text of ["a la fecha", "Hasta la fecha", "en curso", "hasta hoy", "la fecha"]) {
      expect(normalizeDateValue(text)).toBeNull();
    }
  });

  it("credits an ongoing end only when a start date was predicted", () => {
    const t = { startDate: "2021-03", endDate: null };
    expect(scoreDates(t, { startDate: "2021-03", endDate: null })).toEqual({ tp: 2, fp: 0, fn: 0 });
    // no dates predicted at all: both slots are FN, not "ongoing" for free
    expect(scoreDates(t, {})).toEqual({ tp: 0, fp: 0, fn: 2 });
    // wrong start, no end: start is FP + FN, the ongoing end still counts (a start was given)
    expect(scoreDates(t, { startDate: "2020" })).toEqual({ tp: 1, fp: 1, fn: 1 });
    expect(scoreDates(t, { startDate: "2021-03", endDate: "2022" })).toEqual({
      tp: 1,
      fp: 1,
      fn: 1,
    });
  });

  it("scores single-date courses in either predicted slot", () => {
    const course = { endDate: "2020" };
    expect(scoreDates(course, { endDate: "2020" })).toEqual({ tp: 1, fp: 0, fn: 0 });
    expect(scoreDates(course, { startDate: "2020" })).toEqual({ tp: 1, fp: 0, fn: 0 });
    expect(scoreDates(course, { startDate: "2019", endDate: "2020" })).toEqual({
      tp: 1,
      fp: 1,
      fn: 0,
    });
    expect(scoreDates(course, {})).toEqual({ tp: 0, fp: 0, fn: 1 });
    expect(scoreDates(course, { startDate: "2019" })).toEqual({ tp: 0, fp: 1, fn: 1 });
    // undated truth: predicted dates are FP
    expect(scoreDates({}, { startDate: "2019" })).toEqual({ tp: 0, fp: 1, fn: 0 });
  });
});
