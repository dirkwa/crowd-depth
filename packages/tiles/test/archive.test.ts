import { describe, test, expect } from "vitest";
import { csvKey, listFiles, parseRow, readSoundings } from "../src/archive.js";

describe("csvKey", () => {
  test("files the CSV under the contribution date in the name", () => {
    expect(
      csvKey(
        "20261011000209229546_e0281f59-0b1c-4bd7-9a43-3b7f1c1f2a10.tar.gz",
      ),
    ).toBe(
      "csb/csv/2026/10/11/20261011000209229546_e0281f59-0b1c-4bd7-9a43-3b7f1c1f2a10_pointData.csv",
    );
  });

  test("accepts submissions named after a vessel rather than a UUID", () => {
    expect(csvKey("20261011120004396299_sostratus.tar.gz")).toBe(
      "csb/csv/2026/10/11/20261011120004396299_sostratus_pointData.csv",
    );
  });

  test("rejects names it does not recognise", () => {
    expect(() => csvKey("pointData.csv")).toThrow();
  });
});

describe("parseRow", () => {
  test("reads a published row", () => {
    expect(
      parseRow(
        "SIGNALK-e0281f59,f1,177.38245,-17.77041,3.5,2026-10-10T18:05:29.285Z,Phoenix,Signal K",
      ),
    ).toEqual({
      lon: 177.38245,
      lat: -17.77041,
      depth: 3.5,
      time: "2026-10-10T18:05:29.285Z",
      platform: "Phoenix",
      provider: "Signal K",
    });
  });

  test("skips rows without numeric coordinates", () => {
    expect(parseRow("a,b,,-17,3,t,p,q")).toBeUndefined();
    expect(parseRow("too,short")).toBeUndefined();
  });
});

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

describe("listFiles", () => {
  test("pages through results and queries each side of the antimeridian", async () => {
    const queries: URLSearchParams[] = [];
    const fakeFetch = (async (
      _url: string,
      init: { body: URLSearchParams },
    ) => {
      queries.push(init.body);
      const offset = Number(init.body.get("resultOffset"));
      const east = init.body.get("geometry")!.startsWith("-180");
      const name = `2026101100020922954${east ? 9 : offset}_e0281f59-0b1c.tar.gz`;
      return jsonResponse({
        features: [
          {
            attributes: {
              NAME: name,
              FILE_SIZE: 10,
              PROVIDER: "Signal K",
              PLATFORM: "Phoenix",
              ARRIVAL_DATE: 1,
            },
          },
        ],
        exceededTransferLimit: !east && offset === 0,
      });
    }) as unknown as typeof fetch;

    const files = await listFiles([177, -20, -178, -15], {
      fetch: fakeFetch,
      pageSize: 1,
    });

    expect(queries.map((q) => q.get("geometry"))).toEqual([
      "177,-20,180,-15",
      "177,-20,180,-15",
      "-180,-20,-178,-15",
    ]);
    expect(files).toHaveLength(3);
  });

  test("limits an incremental run to newer arrivals", async () => {
    let where = "";
    const fakeFetch = (async (
      _url: string,
      init: { body: URLSearchParams },
    ) => {
      where = init.body.get("where")!;
      return jsonResponse({ features: [] });
    }) as unknown as typeof fetch;

    await listFiles([176, -20, 180, -15], {
      fetch: fakeFetch,
      arrivedAfter: Date.UTC(2026, 9, 1),
    });
    expect(where).toBe("ARRIVAL_DATE > TIMESTAMP '2026-10-01 00:00:00'");
  });
});

describe("readSoundings", () => {
  test("streams rows and skips the header", async () => {
    const csv =
      "UNIQUE_ID,FILE_UUID,LON,LAT,DEPTH,TIME,PLATFORM_NAME,PROVIDER\n" +
      "u,f,177.1,-17.1,4.2,2026-10-10T00:00:00Z,Phoenix,Signal K\n" +
      "u,f,177.2,-17.2,5.1,2026-10-10T00:00:01Z,Phoenix,Signal K\n";
    const fakeFetch = (async () =>
      new Response(csv)) as unknown as typeof fetch;
    const rows = [];
    for await (const s of readSoundings(
      {
        name: "20261011000209229546_e0281f59.tar.gz",
        size: 1,
        provider: "",
        platform: "",
        arrival: 0,
      },
      fakeFetch,
    )) {
      rows.push(s.depth);
    }
    expect(rows).toEqual([4.2, 5.1]);
  });
});
