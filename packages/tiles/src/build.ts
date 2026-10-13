import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { type BBox, contains, splitAntimeridian } from "./bbox.js";
import { type CsbFile, listFiles, readSoundings } from "./archive.js";
import { NO_DATA, SoundingGrid, toSounding } from "./grid.js";
import { TIDE_DATUM, type TideReducer, createTideReducer } from "./tide.js";

export const ATTRIBUTION =
  "Crowdsourced bathymetry: IHO Data Centre for Digital Bathymetry, hosted by NOAA NCEI (CC0). Not for navigation.";

export const DISCLAIMER =
  "Raw crowd-sourced soundings binned by cell. Depths are not reduced to a chart datum or corrected for tide, sensor offsets vary by vessel, and soundings are not quality-checked. Not for navigation.";

export const TIDE_DISCLAIMER = `Crowd-sourced soundings binned by cell. Where a tide station is near, depths are reduced to ${TIDE_DATUM} by a predicted tide, not a measured one; elsewhere they are as sounded. Sensor offsets vary by vessel and are not known, and soundings are not quality-checked. Not for navigation.`;

/**
 * Depth area and contour boundaries in metres: fine where small boats work,
 * coarse offshore where a crowd-sourced line says little about the area.
 */
export const DEPTH_LEVELS = [
  0, 2, 3, 5, 7.5, 10, 15, 20, 30, 50, 100, 200, 500, 1000, 2000, 5000, 11000,
];

export interface BuildOptions {
  bbox: BBox;
  out: string;
  name: string;
  cellMeters: number;
  /**
   * How many empty cells a gap may span and still be filled. Keep it small:
   * shading between tracks hides reefs nobody sounded.
   */
  fillCells: number;
  concurrency: number;
  /**
   * Reduce soundings to the chart datum with a predicted tide from stations
   * within this many kilometres. Omit to keep depths as sounded.
   */
  tideStationKm?: number;
  maxFiles?: number;
  log?: (message: string) => void;
  fetch?: typeof fetch;
}

export interface BuildReport {
  bbox: BBox;
  files: number;
  /** Files that could not be read at all: usually index entries without a CSV in the bucket. */
  failedFiles: number;
  failedBytes: number;
  /**
   * Files whose download broke off. The soundings read before the break are
   * kept: each one stands alone, and a retry would read them again anyway.
   */
  partialFiles: number;
  submittedBytes: number;
  soundings: number;
  rejected: number;
  /** Soundings reduced to `verticalDatum`; the rest are as sounded. */
  tided: number;
  verticalDatum: string | undefined;
  /**
   * Whether every sounding is referenced to the water surface with the
   * vessel's sensor offsets applied. Never for CSB: the archive does not say.
   */
  normalized: boolean;
  tideStations: {
    id: string;
    name: string;
    source: string;
    attribution: string;
  }[];
  cells: number;
  newestArrival: string | undefined;
  seconds: number;
}

async function eachLimited<T>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
) {
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const index = next++;
        await fn(items[index]!, index);
      }
    },
  );
  await Promise.all(workers);
}

export async function build(options: BuildOptions): Promise<BuildReport> {
  const started = Date.now();
  const log = options.log ?? (() => {});
  const doFetch = options.fetch ?? fetch;

  let files: CsbFile[] = await listFiles(options.bbox, { fetch: doFetch });
  files.sort((a, b) => a.name.localeCompare(b.name));
  if (options.maxFiles !== undefined) files = files.slice(-options.maxFiles);
  const submittedBytes = files.reduce((sum, f) => sum + f.size, 0);
  log(
    `${files.length} files intersect the box (${(submittedBytes / 1e6).toFixed(0)} MB submitted)`,
  );

  // A raster cannot wrap round the globe, so each side of the antimeridian gets its own grid.
  const sides = splitAntimeridian(options.bbox);
  const grids = sides.map(
    (bbox) => new SoundingGrid({ bbox, cellMeters: options.cellMeters }),
  );
  const tide =
    options.tideStationKm === undefined
      ? undefined
      : createTideReducer({ maxStationKm: options.tideStationKm });
  let tided = 0;
  let failedFiles = 0;
  let failedBytes = 0;
  let partialFiles = 0;
  let done = 0;
  await eachLimited(files, options.concurrency, async (file) => {
    let read = 0;
    try {
      for await (const s of readSoundings(file, doFetch)) {
        read++;
        // A file's voyage often runs far outside the box; predicting its
        // tide there would only be thrown away.
        if (!sides.some((side) => contains(side, s.lon, s.lat))) continue;
        const correction = tide?.at(s.lon, s.lat, s.time);
        if (correction) tided++;
        for (const grid of grids) {
          grid.add(
            s.lon,
            s.lat,
            s.depth,
            `${s.provider}/${s.platform}`,
            s.time,
            correction?.height,
          );
        }
      }
    } catch (err) {
      if (read > 0) {
        partialFiles++;
        log(
          `kept ${read} soundings of ${file.name} before it failed: ${(err as Error).message}`,
        );
      } else {
        failedFiles++;
        failedBytes += file.size;
        log(`skipped ${file.name}: ${(err as Error).message}`);
      }
    }
    if (++done % 250 === 0) log(`${done}/${files.length} files`);
  });

  const totals = grids.reduce(
    (sum, g) => ({
      seen: sum.seen + g.stats.seen,
      rejected: sum.rejected + g.stats.rejected,
      cells: sum.cells + g.stats.cells,
    }),
    { seen: 0, rejected: 0, cells: 0 },
  );
  log(
    `${totals.seen} soundings in the box, ${totals.rejected} rejected, ${totals.cells} cells`,
  );
  // Tiles with no layers would replace a region's last good build with an empty chart.
  if (totals.cells === 0) {
    throw new Error(
      `No usable soundings in ${options.bbox.join(",")} (${files.length} files, ${failedFiles} unreadable)`,
    );
  }

  const work = await mkdtemp(join(tmpdir(), "csb-tiles-"));
  try {
    const soundings = join(work, "SOUNDG.geojsonseq");
    const areas = join(work, "DEPARE.geojsonseq");
    const contours = join(work, "DEPCNT.geojsonseq");
    await writeLines(soundings, cellSoundings(grids));
    for (const [i, grid] of grids.entries()) {
      if (grid.stats.cells === 0) continue;
      log(`tracing depth areas (${grid.width}x${grid.height} cells)`);
      await traceDepths(
        grid,
        join(work, `side${i}`),
        options.fillCells,
        areas,
        contours,
      );
    }

    await run("tippecanoe", [
      "--force",
      "--output",
      options.out,
      "--name",
      options.name,
      "--description",
      tide ? TIDE_DISCLAIMER : DISCLAIMER,
      "--attribution",
      tide ? tideAttribution(tide.stations) : ATTRIBUTION,
      "--minimum-zoom",
      "6",
      "--maximum-zoom",
      "14",
      "-L",
      `SOUNDG:${soundings}`,
      "-L",
      `DEPARE:${areas}`,
      "-L",
      `DEPCNT:${contours}`,
      "--drop-densest-as-needed",
      "--coalesce-densest-as-needed",
      "--read-parallel",
      "--quiet",
    ]);
    markAsS57(options.out);
    writeMetadata(options.out, {
      normalized: "false",
      vertical_datum: tide ? TIDE_DATUM : "none",
    });
  } finally {
    await rm(work, { recursive: true, force: true });
  }

  const newest = files.reduce((max, f) => Math.max(max, f.arrival), 0);
  const report: BuildReport = {
    bbox: options.bbox,
    files: files.length,
    failedFiles,
    failedBytes,
    partialFiles,
    submittedBytes,
    soundings: totals.seen,
    rejected: totals.rejected,
    tided,
    verticalDatum: tide ? TIDE_DATUM : undefined,
    normalized: false,
    tideStations: [...(tide?.stations ?? [])].map(([id, s]) => ({ id, ...s })),
    cells: totals.cells,
    newestArrival: newest ? new Date(newest).toISOString() : undefined,
    seconds: Math.round((Date.now() - started) / 1000),
  };
  await writeFile(
    `${options.out}.json`,
    JSON.stringify(report, null, 2) + "\n",
  );
  return report;
}

/**
 * Turns a grid into S-57 depth areas (DEPARE, DRVAL1/DRVAL2) and depth
 * contours (DEPCNT, VALDCO), appending them to the given files. Holes up to
 * `fillCells` wide along a track are interpolated so it traces as one area;
 * nothing grows beyond the soundings, so water nobody measured stays empty.
 */
async function traceDepths(
  grid: SoundingGrid,
  base: string,
  fillCells: number,
  areas: string,
  contours: string,
) {
  const filled = `${base}.bin`;
  await grid.writeRaster(filled, fillCells);
  const levels = DEPTH_LEVELS.flatMap((l) => ["-fl", String(l)]);
  const classes = `${base}-classes.tif`;
  const areaOut = `${base}-areas.geojsonseq`;
  const contourOut = `${base}-contours.geojsonseq`;
  // Areas come from polygonizing depth classes rather than gdal_contour's
  // polygon mode, which took over half an hour on Chesapeake Bay against
  // seconds for this. Class 0 is no data; class n lies between level n-1 and n.
  await run("gdal_calc.py", [
    "--quiet",
    "-A",
    filled,
    `--outfile=${classes}`,
    "--type=Byte",
    "--NoDataValue=0",
    "--co",
    "COMPRESS=DEFLATE",
    `--calc=(A>=0)*(1${DEPTH_LEVELS.slice(1, -1)
      .map((level) => `+(A>=${level})`)
      .join("")})`,
  ]);
  await run("gdal_polygonize.py", [
    "-q",
    classes,
    "-f",
    "GeoJSONSeq",
    areaOut,
    "areas",
    "class",
  ]);
  await run("gdal_contour", [
    "-q",
    "-snodata",
    String(NO_DATA),
    "-a",
    "VALDCO",
    ...levels,
    "-f",
    "GeoJSONSeq",
    filled,
    contourOut,
  ]);
  await appendLines(areaOut, areas, depthArea);
  await append(contourOut, contours);
}

/**
 * Chart providers decide how to style vector tiles from the `type` metadata;
 * S-57 tells them to apply ENC symbology to these S-57 layer names.
 */
function markAsS57(mbtiles: string) {
  const db = new DatabaseSync(mbtiles);
  try {
    db.prepare(
      "INSERT OR REPLACE INTO metadata (name, value) VALUES ('type', 'S-57')",
    ).run();
  } finally {
    db.close();
  }
}

/** One line per cell, produced as written: a busy region's lines would not fit in the heap at once. */
function* cellSoundings(grids: SoundingGrid[]): Generator<string> {
  for (const grid of grids) {
    for (const cell of grid.summaries()) yield toSounding(cell);
  }
}

/** Station data is mostly CC BY, so the sources behind the predictions are credited. */
function tideAttribution(stations: TideReducer["stations"]): string {
  const sources = [...new Set([...stations.values()].map((s) => s.source))];
  return sources.length
    ? `${ATTRIBUTION} Tide predictions: Slackwater, from ${sources.join(", ")} station data.`
    : ATTRIBUTION;
}

/**
 * Quality flags a chart provider or plotter can filter on, so tiles from
 * boats that record corrected depths can later be told apart from these.
 */
function writeMetadata(mbtiles: string, values: Record<string, string>) {
  const db = new DatabaseSync(mbtiles);
  try {
    const insert = db.prepare(
      "INSERT OR REPLACE INTO metadata (name, value) VALUES (?, ?)",
    );
    for (const [name, value] of Object.entries(values)) insert.run(name, value);
  } finally {
    db.close();
  }
}

async function writeLines(path: string, lines: Iterable<string>) {
  const stream = createWriteStream(path);
  for (const line of lines) {
    if (!stream.write(line + "\n")) await once(stream, "drain");
  }
  stream.end();
  await once(stream, "finish");
}

/** Gives a polygonized depth class the S-57 depth range it stands for. */
export function depthArea(line: string): string | undefined {
  const feature = JSON.parse(line) as {
    properties: { class?: number; DRVAL1?: number; DRVAL2?: number };
  };
  const index = feature.properties.class;
  if (!index) return undefined;
  feature.properties = {
    DRVAL1: DEPTH_LEVELS[index - 1]!,
    DRVAL2: DEPTH_LEVELS[index]!,
  };
  return JSON.stringify(feature);
}

async function appendLines(
  from: string,
  to: string,
  transform: (line: string) => string | undefined,
) {
  const out = createWriteStream(to, { flags: "a" });
  const lines = createInterface({
    input: createReadStream(from),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const next = transform(line);
    if (next !== undefined && !out.write(next + "\n")) await once(out, "drain");
  }
  out.end();
  await once(out, "finish");
}

async function append(from: string, to: string) {
  const out = createWriteStream(to, { flags: "a" });
  createReadStream(from).pipe(out);
  await once(out, "finish");
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} exited with ${code}`)),
    );
  });
}
