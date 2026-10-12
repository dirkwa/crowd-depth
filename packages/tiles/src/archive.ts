import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { type BBox, splitAntimeridian } from "./bbox.js";

/** NOAA's index of CSB submissions: one simplified track line per file, without depths. */
export const CSB_LINES_URL =
  "https://gis.ngdc.noaa.gov/arcgis/rest/services/csb/MapServer/1/query";

export const CSB_BUCKET_URL =
  "https://noaa-dcdb-bathymetry-pds.s3.amazonaws.com";

export interface CsbFile {
  name: string;
  /** Size of the submitted archive; the CSV in the bucket is roughly three times larger. */
  size: number;
  provider: string;
  platform: string;
  /** Epoch milliseconds the file reached the archive. */
  arrival: number;
}

export interface Sounding {
  lon: number;
  lat: number;
  depth: number;
  time: string;
  platform: string;
  provider: string;
}

/**
 * Maps a submission name from the index to its CSV in the bucket. The bucket is
 * organised by the date the file was contributed, which is the first eight
 * digits of the name, not the date the soundings were collected.
 */
export function csvKey(name: string): string {
  const match = /^((\d{4})(\d{2})(\d{2})\d*_[\w-]+)\.tar\.gz$/.exec(name);
  if (!match) throw new Error(`Unrecognised CSB file name "${name}"`);
  const [, stem, year, month, day] = match;
  return `csb/csv/${year}/${month}/${day}/${stem}_pointData.csv`;
}

export interface ListOptions {
  /** Only files that arrived after this epoch millisecond, for incremental runs. */
  arrivedAfter?: number;
  fetch?: typeof fetch;
  pageSize?: number;
}

/** Lists every CSB file whose track intersects the box. */
export async function listFiles(
  bbox: BBox,
  { arrivedAfter, fetch: doFetch = fetch, pageSize = 2000 }: ListOptions = {},
): Promise<CsbFile[]> {
  const where =
    arrivedAfter === undefined
      ? "1=1"
      : `ARRIVAL_DATE > TIMESTAMP '${new Date(arrivedAfter).toISOString().slice(0, 19).replace("T", " ")}'`;
  const files = new Map<string, CsbFile>();

  for (const [west, south, east, north] of splitAntimeridian(bbox)) {
    for (let offset = 0; ; offset += pageSize) {
      const params = new URLSearchParams({
        where,
        geometry: [west, south, east, north].join(","),
        geometryType: "esriGeometryEnvelope",
        inSR: "4326",
        spatialRel: "esriSpatialRelIntersects",
        outFields: "NAME,FILE_SIZE,PROVIDER,PLATFORM,ARRIVAL_DATE",
        returnGeometry: "false",
        orderByFields: "NAME",
        resultOffset: String(offset),
        resultRecordCount: String(pageSize),
        f: "json",
      });
      const res = await doFetch(CSB_LINES_URL, {
        method: "POST",
        body: params,
      });
      if (!res.ok) throw new Error(`CSB index query failed: ${res.status}`);
      const body = (await res.json()) as {
        error?: { message: string };
        features?: { attributes: Record<string, unknown> }[];
        exceededTransferLimit?: boolean;
      };
      if (body.error) throw new Error(`CSB index: ${body.error.message}`);
      for (const { attributes: a } of body.features ?? []) {
        const name = String(a.NAME);
        files.set(name, {
          name,
          size: Number(a.FILE_SIZE ?? 0),
          provider: String(a.PROVIDER ?? ""),
          platform: String(a.PLATFORM ?? ""),
          arrival: Number(a.ARRIVAL_DATE ?? 0),
        });
      }
      if (!body.exceededTransferLimit) break;
    }
  }
  return [...files.values()];
}

/** Parses one CSV row: UNIQUE_ID,FILE_UUID,LON,LAT,DEPTH,TIME,PLATFORM_NAME,PROVIDER. */
export function parseRow(line: string): Sounding | undefined {
  const fields = line.split(",");
  if (fields.length < 8) return undefined;
  // Number("") is 0, which would put a blank position at 0°N 0°E.
  const [lon, lat, depth] = fields
    .slice(2, 5)
    .map((f) => (f.trim() ? Number(f) : NaN)) as [number, number, number];
  if (![lon, lat, depth].every(Number.isFinite)) return undefined;
  return {
    lon,
    lat,
    depth,
    time: fields[5] ?? "",
    platform: fields[6] ?? "",
    provider: fields.slice(7).join(","),
  };
}

/** Streams a file's soundings straight from the bucket without keeping the CSV. */
export async function* readSoundings(
  file: CsbFile,
  doFetch: typeof fetch = fetch,
): AsyncGenerator<Sounding> {
  const res = await doFetch(`${CSB_BUCKET_URL}/${csvKey(file.name)}`);
  if (!res.ok || !res.body) {
    throw new Error(`Fetching ${file.name} failed: ${res.status}`);
  }
  const lines = createInterface({
    input: Readable.fromWeb(
      res.body as import("node:stream/web").ReadableStream,
    ),
    crlfDelay: Infinity,
  });
  let header = true;
  for await (const line of lines) {
    if (header) {
      header = false;
      if (line.startsWith("UNIQUE_ID")) continue;
    }
    const sounding = parseRow(line);
    if (sounding) yield sounding;
  }
}
