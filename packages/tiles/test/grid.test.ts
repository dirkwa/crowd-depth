import { describe, test, expect } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fillHoles,
  median,
  NO_DATA,
  SoundingGrid,
  toSounding,
} from "../src/grid.js";

describe("SoundingGrid", () => {
  test("bins nearby soundings into one cell", () => {
    const grid = new SoundingGrid({
      bbox: [177, -18, 178, -17],
      cellMeters: 100,
    });
    grid.add(177.4567, -17.4567, 4, "a", "2026-01-01T00:00:00Z");
    grid.add(177.45671, -17.45671, 6, "b", "2026-03-01T00:00:00Z");
    grid.add(177.45672, -17.45672, 5, "a", "2026-02-01T00:00:00Z");

    const [cell, ...rest] = [...grid.summaries()];
    expect(rest).toHaveLength(0);
    expect(cell).toMatchObject({
      depth: 5,
      min: 4,
      max: 6,
      count: 3,
      vessels: 2,
      last: "2026-03-01",
    });
    expect(cell!.lon).toBeCloseTo(177.4567, 3);
    expect(cell!.lat).toBeCloseTo(-17.4567, 3);
  });

  test("drops soundings outside the box", () => {
    const grid = new SoundingGrid({
      bbox: [177, -18, 178, -17],
      cellMeters: 100,
    });
    grid.add(176.9, -17.5, 4, "a", "t");
    expect(grid.stats).toEqual({ seen: 0, rejected: 0, cells: 0 });
  });

  test("rejects the missing-value sentinel and impossible depths", () => {
    const grid = new SoundingGrid({
      bbox: [177, -18, 178, -17],
      cellMeters: 100,
    });
    grid.add(177.5, -17.5, -1_000_000_000, "a", "t");
    grid.add(177.5, -17.5, 0, "a", "t");
    grid.add(177.5, -17.5, 12_000, "a", "t");
    expect(grid.stats).toEqual({ seen: 3, rejected: 3, cells: 0 });
  });

  test("keeps a sounding on the box's eastern edge inside the grid", () => {
    const grid = new SoundingGrid({
      bbox: [179, -18, 180, -17],
      cellMeters: 1000,
    });
    grid.add(180, -18, 10, "a", "t");
    const [cell] = [...grid.summaries()];
    expect(cell!.lon).toBeLessThan(180);
    expect(cell!.lat).toBeGreaterThan(-18);
  });

  test("refuses a box across the antimeridian", () => {
    expect(
      () => new SoundingGrid({ bbox: [179, -18, -179, -17], cellMeters: 100 }),
    ).toThrow();
  });

  test("writes cell medians as a north-up raster with an ENVI header", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grid-"));
    try {
      const grid = new SoundingGrid({
        bbox: [0, 0, 0.003, 0.002],
        cellMeters: 111.32,
      });
      expect([grid.width, grid.height]).toEqual([3, 2]);
      grid.add(0.0005, 0.0015, 7, "a", "t");
      grid.add(0.0025, 0.0005, 3, "a", "t");

      await grid.writeRaster(join(dir, "depth.bin"));
      const raw = await readFile(join(dir, "depth.bin"));
      const values = [
        ...new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4),
      ];
      expect(values).toEqual([7, NO_DATA, NO_DATA, NO_DATA, NO_DATA, 3]);

      const header = await readFile(join(dir, "depth.hdr"), "utf8");
      expect(header).toContain("samples = 3");
      expect(header).toContain("lines = 2");
      expect(header).toContain(`data ignore value = ${NO_DATA}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test("caps the vessel count and keeps the median from a sample", () => {
  const grid = new SoundingGrid({
    bbox: [177, -18, 178, -17],
    cellMeters: 100,
  });
  for (let i = 0; i < 100; i++) {
    grid.add(
      177.4567,
      -17.4567,
      i < 95 ? 5 : 50,
      `vessel-${i}`,
      "2026-01-01T00:00:00Z",
    );
  }
  const [cell] = [...grid.summaries()];
  expect(cell).toMatchObject({ count: 100, vessels: 4, min: 5, max: 50 });
  expect(cell!.depth).toBeLessThan(50);
});

test("grows past its initial capacity", () => {
  const grid = new SoundingGrid({ bbox: [0, 0, 1, 1], cellMeters: 100 });
  for (let i = 0; i < 3000; i++) grid.add((i + 0.5) / 3000, 0.5, 10, "a", "t");
  expect(grid.stats.cells).toBeGreaterThan(1024);
  expect([...grid.summaries()].every((c) => c.depth === 10)).toBe(true);
});

describe("fillHoles", () => {
  const _ = NO_DATA;
  const fill = (rows: number[][], maxGap: number) =>
    [
      ...fillHoles(
        rows.map((r) => Float32Array.from(r)),
        rows[0]!.length,
        maxGap,
      ),
    ].map((r) => [...r]);

  test("fills a one-cell hole along a track", () => {
    expect(fill([[4, _, 6]], 1)).toEqual([[4, 5, 6]]);
    expect(fill([[4], [_], [8]], 1)).toEqual([[4], [6], [8]]);
  });

  test("never grows a track past its edges", () => {
    const rows = [
      [_, _, _, _],
      [_, 3, 3, _],
      [_, _, _, _],
    ];
    expect(fill(rows, 1)).toEqual(rows);
    expect(fill(rows, 3)).toEqual(rows);
  });

  test("leaves the water between two parallel tracks empty when wider than the limit", () => {
    const rows = [[2], [_], [_], [9]];
    expect(fill(rows, 1)).toEqual(rows);
    expect(fill(rows, 2)).toEqual(
      [[2], [2 + 7 / 3], [2 + 14 / 3], [9]].map((r) =>
        r.map((v) => Math.fround(v)),
      ),
    );
  });

  test("bridges a diagonal track", () => {
    expect(
      fill(
        [
          [5, _, _],
          [_, _, _],
          [_, _, 7],
        ],
        1,
      ),
    ).toEqual([
      [5, _, _],
      [_, 6, _],
      [_, _, 7],
    ]);
  });

  test("takes the shallowest where axes disagree", () => {
    expect(
      fill(
        [
          [_, 2, _],
          [10, _, 20],
          [_, 4, _],
        ],
        1,
      )[1],
    ).toEqual([10, 3, 20]);
  });

  test("passes rows through untouched with no gap allowed", () => {
    expect(fill([[4, _, 6]], 0)).toEqual([[4, _, 6]]);
  });
});

describe("median", () => {
  test("handles odd and even counts", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });
});

describe("toSounding", () => {
  test("writes an S-57 sounding with rounded depths", () => {
    const feature = JSON.parse(
      toSounding({
        lon: 177.123456789,
        lat: -17.5,
        depth: 4.26,
        min: 3.91,
        max: 5,
        mean: 4.3,
        count: 7,
        vessels: 2,
        last: "2026-10-10",
      }),
    );
    expect(feature.geometry.coordinates).toEqual([177.123457, -17.5]);
    expect(feature.properties).toEqual({
      DEPTH: 4.3,
      min: 3.9,
      max: 5,
      count: 7,
      vessels: 2,
      last: "2026-10-10",
    });
  });
});
