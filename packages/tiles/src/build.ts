import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { type BBox, splitAntimeridian } from "./bbox.js";
import { type CsbFile, listFiles, readSoundings } from "./archive.js";
import { NO_DATA, SoundingGrid, toSounding } from "./grid.js";

export const ATTRIBUTION =
  "Crowdsourced bathymetry: IHO Data Centre for Digital Bathymetry, hosted by NOAA NCEI (CC0). Not for navigation.";

export const DISCLAIMER =
  "Raw crowd-sourced soundings binned by cell. Depths are not reduced to a chart datum or corrected for tide, sensor offsets vary by vessel, and soundings are not quality-checked. Not for navigation.";

/**
 * Depth area and contour boundaries in metres: fine where small boats work,
 * coarse offshore where a crowd-sourced line says little about the area.
 */
export const DEPTH_LEVELS = [
  0, 2, 3, 5, 7.5, 10, 15, 20, 30, 50, 100, 200, 500, 1000, 2000, 5000, 11000,
];

/** Smoothing passes over filled gaps, so single noisy cells don't ring with contours. */
const SMOOTHING_PASSES = 3;

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
  maxFiles?: number;
  log?: (message: string) => void;
  fetch?: typeof fetch;
}

export interface BuildReport {
  bbox: BBox;
  files: number;
  failedFiles: number;
  /** Index entries without a CSV in the bucket, usually tiny fragments. */
  failedBytes: number;
  submittedBytes: number;
  soundings: number;
  rejected: number;
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
  const grids = splitAntimeridian(options.bbox).map(
    (bbox) => new SoundingGrid({ bbox, cellMeters: options.cellMeters }),
  );
  let failedFiles = 0;
  let failedBytes = 0;
  let done = 0;
  await eachLimited(files, options.concurrency, async (file) => {
    try {
      for await (const s of readSoundings(file, doFetch)) {
        for (const grid of grids) {
          grid.add(
            s.lon,
            s.lat,
            s.depth,
            `${s.provider}/${s.platform}`,
            s.time,
          );
        }
      }
    } catch (err) {
      failedFiles++;
      failedBytes += file.size;
      log(`skipped ${file.name}: ${(err as Error).message}`);
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

  const work = await mkdtemp(join(tmpdir(), "csb-tiles-"));
  try {
    const soundings = join(work, "SOUNDG.geojsonseq");
    const areas = join(work, "DEPARE.geojsonseq");
    const contours = join(work, "DEPCNT.geojsonseq");
    await writeLines(
      soundings,
      grids.flatMap((g) => [...g.summaries()].map(toSounding)),
    );
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
      DISCLAIMER,
      "--attribution",
      ATTRIBUTION,
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
  } finally {
    await rm(work, { recursive: true, force: true });
  }

  const newest = files.reduce((max, f) => Math.max(max, f.arrival), 0);
  const report: BuildReport = {
    bbox: options.bbox,
    files: files.length,
    failedFiles,
    failedBytes,
    submittedBytes,
    soundings: totals.seen,
    rejected: totals.rejected,
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
 * contours (DEPCNT, VALDCO), appending them to the given files. Gaps up to
 * `fillCells` wide are interpolated so neighbouring tracks join into an area;
 * anything wider stays empty rather than inventing depths nobody measured.
 */
async function traceDepths(
  grid: SoundingGrid,
  base: string,
  fillCells: number,
  areas: string,
  contours: string,
) {
  const raw = `${base}.bin`;
  const filled = `${base}.tif`;
  await grid.writeRaster(raw);
  await run("gdal_fillnodata.py", [
    "-q",
    "-md",
    String(fillCells),
    "-si",
    String(SMOOTHING_PASSES),
    "-co",
    "COMPRESS=DEFLATE",
    raw,
    filled,
  ]);
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
