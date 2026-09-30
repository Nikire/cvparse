import { describe, expect, it } from "vitest";
import { normalizeDate } from "../src/index.js";

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
  ])("parses numeric dates day-first: %s -> %s", (input, expected) => {
    expect(normalizeDate(input).value).toBe(expected);
  });

  it("falls back to US order when day-first is impossible", () => {
    expect(normalizeDate("03/25/2020").value).toBe("2020-03-25");
  });

  it("extracts a bare year from short phrases", () => {
    expect(normalizeDate("Año 2019").value).toBe("2019");
    expect(normalizeDate("2019 (verano)").value).toBe("2019");
    expect(normalizeDate("desde 2015").value).toBe("2015");
  });

  it("flags unparseable input", () => {
    for (const input of ["hace dos años", "13/2020", "32/01/2020", "Q3 2020", "1800"]) {
      expect(normalizeDate(input), input).toEqual({ value: null, current: false, unparsed: true });
    }
  });
});
