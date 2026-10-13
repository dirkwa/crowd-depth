import { describe, expect, test } from "vitest";
import { Temporal } from "@js-temporal/polyfill";
import { createTideReducer, reduceToDatum } from "../src/tide.js";
import { BathymetryData } from "../src/types.js";

const at = (latitude: number, longitude: number, depth: number, time: string) =>
  ({
    latitude,
    longitude,
    depth,
    timestamp: Temporal.Instant.from(time),
  }) satisfies BathymetryData;

describe("createTideReducer", () => {
  test("predicts the tide above LAT from a nearby station", () => {
    const tide = createTideReducer();
    // Lautoka, Fiji: a TICON-4 station whose chart datum is LAT.
    const correction = tide.at(177.43, -17.6, "2026-10-13T00:00:00Z");
    expect(correction?.station).toContain("lautoka");
    expect(correction!.height).toBeGreaterThanOrEqual(0);
    expect(correction!.height).toBeLessThan(2.4);
    expect([...tide.stations.values()][0]!.attribution).toMatch(/CC BY 4\.0/);
  });

  test("follows the tide through the day", () => {
    const tide = createTideReducer();
    const heights = Array.from(
      { length: 13 },
      (_, h) => tide.at(177.43, -17.6, Date.UTC(2026, 9, 13, h))!.height,
    );
    expect(Math.max(...heights) - Math.min(...heights)).toBeGreaterThan(0.8);
  });

  test("finds no station in the open ocean", () => {
    expect(
      createTideReducer().at(-130, -40, "2026-10-13T00:00:00Z"),
    ).toBeUndefined();
  });
});

describe("reduceToDatum", () => {
  test("reduces a sounding near a station and flags it", () => {
    const reduce = reduceToDatum();
    const sounding = at(-17.6, 177.43, 5, "2026-10-13T00:00:00Z");
    const reduced = reduce(sounding);
    expect(reduced.datum).toBe("LAT");
    expect(reduced.tide).toBeGreaterThan(0);
    expect(reduced.depth).toBeCloseTo(5 - reduced.tide!, 6);
  });

  test("passes a sounding with no station nearby through unflagged", () => {
    const sounding = at(-40, -130, 5, "2026-10-13T00:00:00Z");
    expect(reduceToDatum()(sounding)).toEqual(sounding);
  });

  test("does not reduce a sounding twice", () => {
    const reduce = reduceToDatum();
    const once = reduce(at(-17.6, 177.43, 5, "2026-10-13T00:00:00Z"));
    expect(reduce(once)).toBe(once);
  });

  test("reads ground that dries at the datum as zero", () => {
    const reduced = reduceToDatum()(
      at(-17.6, 177.43, 0.01, "2026-10-13T00:00:00Z"),
    );
    expect(reduced.depth).toBe(0);
    expect(reduced.datum).toBe("LAT");
  });
});
