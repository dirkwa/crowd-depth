import { describe, test, expect } from "vitest";
import { depthArea } from "../src/build.js";

describe("depthArea", () => {
  const polygon = {
    type: "Polygon",
    coordinates: [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 0],
      ],
    ],
  };

  test("turns a depth class into its S-57 depth range", () => {
    const line = JSON.stringify({
      type: "Feature",
      geometry: polygon,
      properties: { class: 3 },
    });
    expect(JSON.parse(depthArea(line)!).properties).toEqual({
      DRVAL1: 3,
      DRVAL2: 5,
    });
  });

  test("drops cells without data", () => {
    const line = JSON.stringify({
      type: "Feature",
      geometry: polygon,
      properties: { class: 0 },
    });
    expect(depthArea(line)).toBeUndefined();
  });
});
