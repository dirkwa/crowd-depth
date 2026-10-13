import { describe, test, expect } from "vitest";
import { numberOption } from "../src/cli.js";

describe("numberOption", () => {
  test("reads a valid number", () => {
    expect(numberOption("cell", "30", { min: 1 })).toBe(30);
    expect(numberOption("fill", "0", { min: 0, integer: true })).toBe(0);
  });

  test("refuses what Number() would quietly accept", () => {
    expect(() => numberOption("cell", "abc", { min: 1 })).toThrow(/--cell/);
    expect(() => numberOption("cell", "", { min: 1 })).toThrow();
    expect(() => numberOption("cell", "0", { min: 1 })).toThrow();
    expect(() =>
      numberOption("concurrency", "2.5", { min: 1, integer: true }),
    ).toThrow();
    expect(() => numberOption("fill", "-1", { min: 0 })).toThrow();
  });
});
