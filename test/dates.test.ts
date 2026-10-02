import { describe, expect, it } from "vitest";
import { normalizeDate } from "../src/index.js";
import { pickLatestDate, reduceDatePrecision, splitDateRange } from "../src/normalize/dates.js";

/** Fixed anchor so relative dates are deterministic: 1 October 2026. */
const REF = { referenceDate: new Date(Date.UTC(2026, 9, 1)) };

describe("normalizeDate", () => {
  it("keeps ISO input untouched", () => {
    expect(normalizeDate("2021").value).toBe("2021");
    expect(normalizeDate("2021-03").value).toBe("2021-03");
    expect(normalizeDate("2021-03-15").value).toBe("2021-03-15");
  });

  it("treats null/undefined/empty as unknown, not unparsed", () => {
    for (const input of [null, undefined, "", "   ", "N/A", "-", "null"]) {
      expect(normalizeDate(input)).toEqual({ value: null, current: false, unparsed: false });
    }
  });

  it.each([
    ["Actualidad", true],
    ["actualidad", true],
    ["ACTUALMENTE", true],
    ["Presente", true],
    ["a la fecha", true],
    ["Hasta la fecha", true],
    ["hasta hoy", true],
    ["En curso", true],
    ["Present", true],
    ["current", true],
    ["Now", true],
    ["to date", true],
    ["Atualmente", true],
  ])("recognizes ongoing marker %s", (input, current) => {
    expect(normalizeDate(input)).toEqual({ value: null, current, unparsed: false });
  });

  it.each([
    ["Marzo 2021", "2021-03"],
    ["marzo de 2021", "2021-03"],
    ["Marzo del 2021", "2021-03"],
    ["mar. 2021", "2021-03"],
    ["Sept 2019", "2019-09"],
    ["setiembre 2019", "2019-09"],
    ["noviembre de 2022", "2022-11"],
    ["Dic 2020", "2020-12"],
    ["Ene 24", "2024-01"],
    ["15 de marzo de 2020", "2020-03-15"],
    ["1 ene 2019", "2019-01-01"],
    ["March 2021", "2021-03"],
    ["Aug 2018", "2018-08"],
    ["March 15, 2020", "2020-03-15"],
    ["Fevereiro 2020", "2020-02"],
    ["março 2020", "2020-03"],
  ])("parses month names: %s -> %s", (input, expected) => {
    expect(normalizeDate(input)).toEqual({ value: expected, current: false, unparsed: false });
  });

  it.each([
    ["06/2018", "2018-06"],
    ["6/2018", "2018-06"],
    ["06-2018", "2018-06"],
    ["06.2018", "2018-06"],
    ["03/21", "2021-03"],
    ["15/03/2020", "2020-03-15"],
    ["15-03-2020", "2020-03-15"],
    ["15/03/20", "2020-03-15"],
    ["2020/03", "2020-03"],
    ["2020-3", "2020-03"],
    ["2020-3-5", "2020-03-05"],
    ["2020/03/15", "2020-03-15"],
    ["2020-03-15T00:00:00Z", "2020-03-15"],
    ["2020–03", "2020-03"],
  ])("parses numeric dates day-first: %s -> %s", (input, expected) => {
    expect(normalizeDate(input).value).toBe(expected);
  });

  it("falls back to US order when day-first is impossible", () => {
    expect(normalizeDate("03/25/2020").value).toBe("2020-03-25");
  });

  it("extracts a bare year from short phrases", () => {
    expect(normalizeDate("Año 2019").value).toBe("2019");
    expect(normalizeDate("2019 (aprox.)").value).toBe("2019");
    expect(normalizeDate("desde 2015").value).toBe("2015");
    expect(normalizeDate("from 2015").value).toBe("2015");
  });

  it("flags unparseable input", () => {
    for (const input of ["hace poco", "recently", "13/2020", "32/01/2020", "1800", "trimestre"]) {
      expect(normalizeDate(input), input).toEqual({ value: null, current: false, unparsed: true });
    }
  });

  describe("relative dates", () => {
    it.each([
      ["hace 3 años", "2023"],
      ["Hace 6 meses", "2026-04"],
      ["hace un año", "2025"],
      ["hace 1 año", "2025"],
      ["hace dos años", "2024"],
      ["hace 10 meses", "2025-12"],
      ["hace 12 meses", "2025-10"],
      ["desde hace 2 años", "2024"],
      ["3 years ago", "2023"],
      ["6 months ago", "2026-04"],
      ["18 months ago", "2025-04"],
      ["a year ago", "2025"],
      ["one year ago", "2025"],
      ["2 yrs ago", "2024"],
      ["há 2 anos", "2024"],
      ["ha 2 anos", "2024"],
      ["2 anos atrás", "2024"],
      ["há 3 meses", "2026-07"],
    ])("resolves %s against the reference date -> %s", (input, expected) => {
      const result = normalizeDate(input, REF);
      expect(result.value).toBe(expected);
      expect(result.current).toBe(false);
      expect(result.unparsed).toBe(false);
      expect(result.note).toContain("2026-10-01");
    });

    it("does month arithmetic across year boundaries in UTC", () => {
      const ref = { referenceDate: new Date("2026-01-31T23:30:00Z") };
      expect(normalizeDate("hace 1 mes", ref).value).toBe("2025-12");
      expect(normalizeDate("hace 13 meses", ref).value).toBe("2024-12");
    });

    it("defaults the reference date to now", () => {
      const now = new Date();
      expect(normalizeDate("hace 1 año").value).toBe(String(now.getUTCFullYear() - 1));
    });

    it("rejects vague relative phrases", () => {
      for (const input of ["hace poco", "hace mucho tiempo", "years ago", "hace años"]) {
        expect(normalizeDate(input, REF), input).toEqual({
          value: null,
          current: false,
          unparsed: true,
        });
      }
    });

    it("rejects relative dates that fall outside the supported year range", () => {
      expect(normalizeDate("hace 200 años", REF).unparsed).toBe(true);
    });
  });

  describe("seasons", () => {
    it.each([
      ["verano 2020", "2020-06"],
      ["verano de 2020", "2020-06"],
      ["Verano del 2020", "2020-06"],
      ["invierno 2019", "2019-12"],
      ["otoño 2021", "2021-09"],
      ["primavera 2022", "2022-03"],
      ["summer 2020", "2020-06"],
      ["Summer of 2020", "2020-06"],
      ["fall 2019", "2019-09"],
      ["autumn 2019", "2019-09"],
      ["spring 2021", "2021-03"],
      ["winter 2018", "2018-12"],
      ["verão 2020", "2020-06"],
      ["inverno 2020", "2020-12"],
      ["2019 (verano)", "2019-06"],
    ])("maps %s to the Northern-hemisphere start month %s", (input, expected) => {
      const result = normalizeDate(input);
      expect(result.value).toBe(expected);
      expect(result.unparsed).toBe(false);
      expect(result.note).toMatch(/hemisphere/);
    });
  });

  describe("quarters, semesters and cuatrimestres", () => {
    it.each([
      ["Q1 2021", "2021-01"],
      ["Q2 2021", "2021-04"],
      ["2021 Q3", "2021-07"],
      ["Q4-2021", "2021-10"],
      ["1T 2021", "2021-01"],
      ["T1 2021", "2021-01"],
      ["3T 2020", "2020-07"],
      ["1er trimestre 2021", "2021-01"],
      ["2do trimestre de 2021", "2021-04"],
      ["4to trimestre 2021", "2021-10"],
      ["1er semestre 2020", "2020-01"],
      ["primer semestre 2020", "2020-01"],
      ["2do semestre 2020", "2020-07"],
      ["segundo semestre de 2020", "2020-07"],
      ["2020-S1", "2020-01"],
      ["2020/S2", "2020-07"],
      ["S2 2020", "2020-07"],
      ["1S 2020", "2020-01"],
      ["H1 2021", "2021-01"],
      ["H2 2021", "2021-07"],
      ["1° cuatrimestre 2020", "2020-01"],
      ["2° cuatrimestre 2020", "2020-05"],
      ["3º cuatrimestre 2020", "2020-09"],
      ["first quarter 2021", "2021-01"],
      ["2nd quarter of 2021", "2021-04"],
      ["second half of 2020", "2020-07"],
      ["Q3 2020", "2020-07"],
    ])("maps %s to the start of the period %s", (input, expected) => {
      expect(normalizeDate(input)).toEqual({ value: expected, current: false, unparsed: false });
    });

    it("rejects periods that do not exist", () => {
      for (const input of ["Q5 2021", "3er semestre 2020", "4to cuatrimestre 2020", "S0 2020"]) {
        expect(normalizeDate(input).unparsed, input).toBe(true);
      }
    });
  });

  describe("range tokens", () => {
    it.each([
      "2019-21",
      "2019–2021",
      "2019/2021",
      "2019 - 2021",
      "2019 a 2021",
      "2019 hasta 2021",
      "mar 2019 - jun 2021",
      "03/2019-06/2021",
      "2019 - actualidad",
      "2019–presente",
      "2019 - current",
      "2019 to 2021",
      "de 2019 a 2021",
    ])("does not produce a date for %s (caller should use splitDateRange)", (input) => {
      expect(normalizeDate(input)).toEqual({ value: null, current: false, unparsed: true });
    });

    it("still reads open-ended starts as a plain date", () => {
      expect(normalizeDate("desde 2019").value).toBe("2019");
    });
  });
});

describe("splitDateRange", () => {
  it.each([
    ["2019-21", "2019", "2021"],
    ["2019-2021", "2019", "2021"],
    ["2019–2021", "2019", "2021"],
    ["2019—2021", "2019", "2021"],
    ["2019/2021", "2019", "2021"],
    ["2019/21", "2019", "2021"],
    ["2019 - 2021", "2019", "2021"],
    ["2019 -2021", "2019", "2021"],
    ["2019 a 2021", "2019", "2021"],
    ["2019 al 2021", "2019", "2021"],
    ["2019 hasta 2021", "2019", "2021"],
    ["2019 to 2021", "2019", "2021"],
    ["2019 até 2021", "2019", "2021"],
    ["de 2019 a 2021", "2019", "2021"],
    ["del 2019 al 2021", "2019", "2021"],
    ["entre 2019 y 2021", "2019", "2021"],
    ["between 2019 and 2021", "2019", "2021"],
    ["from 2019 to 2021", "2019", "2021"],
    ["mar 2019 - jun 2021", "2019-03", "2021-06"],
    ["Marzo 2019 – Junio 2021", "2019-03", "2021-06"],
    ["marzo de 2019 a junio de 2021", "2019-03", "2021-06"],
    ["03/2019-06/2021", "2019-03", "2021-06"],
    ["03/2019 - 06/2021", "2019-03", "2021-06"],
    ["15/03/2019 - 20/06/2021", "2019-03-15", "2021-06-20"],
    ["1998-99", "1998", "1999"],
    ["Q1 2020 - Q3 2021", "2020-01", "2021-07"],
    ["verano 2019 - invierno 2020", "2019-06", "2020-12"],
  ])("splits %s into %s .. %s", (input, start, end) => {
    expect(splitDateRange(input)).toEqual({ start, end, current: false });
  });

  it.each([
    ["2019 - actualidad", "2019"],
    ["2019–presente", "2019"],
    ["2019 - current", "2019"],
    ["2019 - present", "2019"],
    ["2019 to date", "2019"],
    ["marzo 2019 a la fecha", "2019-03"],
    ["2019 hasta la actualidad", "2019"],
    ["2019 - hasta hoy", "2019"],
    ["Mar 2019 – Present", "2019-03"],
    ["hace 3 años - actualidad", "2023"],
  ])("treats %s as ongoing from %s", (input, start) => {
    expect(splitDateRange(input, REF)).toEqual({ start, end: null, current: true });
  });

  it("returns an open-ended range for 'desde' / 'from' / 'since'", () => {
    expect(splitDateRange("desde 2019")).toEqual({ start: "2019", end: null, current: false });
    expect(splitDateRange("from 2019")).toEqual({ start: "2019", end: null, current: false });
    expect(splitDateRange("since March 2019")).toEqual({
      start: "2019-03",
      end: null,
      current: false,
    });
  });

  it("returns null for tokens that are not ranges", () => {
    for (const input of [
      null,
      undefined,
      "",
      "2019-03",
      "1998-02",
      "2010-11",
      "2019",
      "marzo 2021",
      "15-03-2020",
      "2020-03-15",
      "06/2018",
      "actualidad",
      "foo - bar",
      "2019 - foo",
      "2019 y 2021",
      "Q1 2021",
      "hace 3 años",
    ]) {
      expect(splitDateRange(input, REF), String(input)).toBeNull();
    }
  });

  it("reads a two-digit end as a year only when it is after the start's last two digits", () => {
    expect(splitDateRange("2019-21")).toEqual({ start: "2019", end: "2021", current: false });
    expect(splitDateRange("2019 - 21")).toEqual({ start: "2019", end: "2021", current: false });
    // Valid YYYY-MM always wins over a range reading.
    expect(splitDateRange("2019-03")).toBeNull();
    expect(normalizeDate("2019-03").value).toBe("2019-03");
    // Not a valid month and not after the start: still not a range.
    expect(splitDateRange("2019-19")).toBeNull();
    expect(splitDateRange("2019-15")).toBeNull();
  });
});

describe("pickLatestDate", () => {
  it("keeps the latest of several listed dates", () => {
    expect(pickLatestDate("2012, 2019")).toBe("2019");
    expect(pickLatestDate("2019; 2012")).toBe("2019");
    expect(pickLatestDate("Mar 2018 y Jun 2020")).toBe("2020-06");
    expect(pickLatestDate("2015 and 2017 & 2016")).toBe("2017");
    expect(pickLatestDate("2015 / 2017")).toBe("2017");
    expect(pickLatestDate("2019, mayo 2019")).toBe("2019-05");
  });

  it("returns null unless at least two parts are dates", () => {
    expect(pickLatestDate("2019")).toBeNull();
    expect(pickLatestDate("2019, unknown")).toBeNull();
    expect(pickLatestDate("Mayo, 2019")).toBeNull();
    expect(pickLatestDate("")).toBeNull();
    expect(pickLatestDate(null)).toBeNull();
  });
});

describe("reduceDatePrecision", () => {
  it("drops a month the document never wrote (regression: '(2020–2021)' became 2020-01)", () => {
    const text = "Universidad Nacional — Computer Engineering (2020–2021)";
    expect(reduceDatePrecision("2020-01", text)).toEqual({ value: "2020", reason: "month" });
    expect(reduceDatePrecision("2021-01", text)).toEqual({ value: "2021", reason: "month" });
    expect(reduceDatePrecision("2020-01-01", text)).toEqual({ value: "2020", reason: "month" });
  });

  it("keeps the month when a month expression is next to the year", () => {
    for (const text of [
      "Enero 2020 - Marzo 2021",
      "enero de 2020",
      "Jan. 2020",
      "January, 2020",
      "janeiro de 2020",
      "01/2020",
      "1-2020",
      "2020-01",
      "2020/01",
      "Q1 2020",
      "2020-S1",
      "primer semestre 2020",
    ]) {
      expect(reduceDatePrecision("2020-01", text), text).toBeNull();
    }
  });

  it("keeps the month when any occurrence of the year has one", () => {
    expect(reduceDatePrecision("2020-01", "Curso (2020)\nEmpresa X, enero 2020 - hoy")).toBeNull();
  });

  it("does not borrow a month that belongs to the next date of a range", () => {
    expect(reduceDatePrecision("2019-01", "2019 - Marzo 2020")).toEqual({
      value: "2019",
      reason: "month",
    });
  });

  it("drops an invented day but keeps a written month", () => {
    expect(reduceDatePrecision("2020-03-01", "Marzo 2020 – Junio 2021")).toEqual({
      value: "2020-03",
      reason: "day",
    });
    expect(reduceDatePrecision("2020-01-01", "Enero 2020")).toEqual({
      value: "2020-01",
      reason: "day",
    });
    expect(reduceDatePrecision("2020-03-01", "01/03/2020")).toBeNull();
    expect(reduceDatePrecision("2020-03-01", "1 de marzo de 2020")).toBeNull();
    expect(reduceDatePrecision("2020-03-01", "March 1, 2020")).toBeNull();
    expect(reduceDatePrecision("2020-03-01", "2020-03-01")).toBeNull();
  });

  it("leaves everything else alone", () => {
    // The year is not in the text: nothing to compare against.
    expect(reduceDatePrecision("2020-01", "Experiencia en Node.js")).toBeNull();
    // Not "-01" padding.
    expect(reduceDatePrecision("2020-03", "2020")).toBeNull();
    expect(reduceDatePrecision("2020-01-15", "2020")).toBeNull();
    expect(reduceDatePrecision("2020", "2020")).toBeNull();
    // "12020" is not the year 2020.
    expect(reduceDatePrecision("2020-01", "Legajo 12020")).toBeNull();
  });
});

describe("normalizeDate: 'in progress' markers", () => {
  it.each([
    "In progress",
    "in progress",
    "En curso",
    "en progreso",
    "Em andamento",
    "em curso",
    "Cursando",
  ])("treats %s as ongoing (null, no unparsed flag)", (input) => {
    expect(normalizeDate(input)).toEqual({ value: null, current: true, unparsed: false });
  });

  it("splits a range ending in 'in progress'", () => {
    expect(splitDateRange("2024 - in progress")).toEqual({
      start: "2024",
      end: null,
      current: true,
    });
  });
});
