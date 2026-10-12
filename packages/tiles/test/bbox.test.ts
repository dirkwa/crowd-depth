import { describe, test, expect } from "vitest";
import { contains, parseBBox, splitAntimeridian } from "../src/bbox.js";

describe("parseBBox", () => {
  test("reads west,south,east,north", () => {
    expect(parseBBox("176,-20,180,-15")).toEqual([176, -20, 180, -15]);
  });

  test("rejects malformed boxes", () => {
    expect(() => parseBBox("176,-20,180")).toThrow();
    expect(() => parseBBox("176,-15,180,-20")).toThrow();
    expect(() => parseBBox("176,-20,181,-15")).toThrow();
  });
});

describe("splitAntimeridian", () => {
  test("leaves an ordinary box alone", () => {
    expect(splitAntimeridian([176, -20, 180, -15])).toEqual([
      [176, -20, 180, -15],
    ]);
  });

  test("splits a box across 180° into two", () => {
    expect(splitAntimeridian([177, -20, -178, -15])).toEqual([
      [177, -20, 180, -15],
      [-180, -20, -178, -15],
    ]);
  });
});

describe("contains", () => {
  test("honours a box across the antimeridian", () => {
    const box: [number, number, number, number] = [177, -20, -178, -15];
    expect(contains(box, 179.5, -17)).toBe(true);
    expect(contains(box, -179.5, -17)).toBe(true);
    expect(contains(box, 0, -17)).toBe(false);
    expect(contains(box, 179.5, -10)).toBe(false);
  });
});
