import { describe, test, expect } from "vitest";
import { createTideReducer } from "../src/tide.js";

describe("createTideReducer", () => {
  test("predicts the tide above LAT from a nearby station", () => {
    const tide = createTideReducer();
    // Lautoka, Fiji: a TICON-4 station whose chart datum is LAT.
    const low = tide.at(177.43, -17.6, "2026-10-13T00:00:00Z");
    expect(low?.station).toContain("lautoka");
    // Lautoka's LAT sits 1.17 m below mean sea level, so the predicted level
    // is never negative and never above Highest Astronomical Tide.
    expect(low!.height).toBeGreaterThanOrEqual(0);
    expect(low!.height).toBeLessThan(2.4);
    expect([...tide.stations.values()][0]!.attribution).toMatch(/CC BY 4\.0/);
  });

  test("follows the tide through the day", () => {
    const tide = createTideReducer();
    const heights = Array.from(
      { length: 13 },
      (_, h) =>
        tide.at(
          177.43,
          -17.6,
          `2026-10-13T${String(h).padStart(2, "0")}:00:00Z`,
        )!.height,
    );
    // Semi-diurnal: high and low water a little over six hours apart.
    expect(Math.max(...heights) - Math.min(...heights)).toBeGreaterThan(0.8);
  });

  test("leaves soundings far from any station unreduced", () => {
    const tide = createTideReducer({ maxStationKm: 50 });
    // Mid South Pacific, thousands of kilometres from a tide gauge.
    expect(tide.at(-130, -40, "2026-10-13T00:00:00Z")).toBeUndefined();
    expect(tide.stations.size).toBe(0);
  });

  test("ignores a sounding without a readable time", () => {
    expect(createTideReducer().at(177.43, -17.6, "")).toBeUndefined();
  });
});
