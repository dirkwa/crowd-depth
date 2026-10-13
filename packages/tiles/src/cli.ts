import { parseArgs } from "node:util";
import { parseBBox } from "./bbox.js";
import { build } from "./build.js";
import { DEFAULT_MAX_STATION_KM } from "./tide.js";

const USAGE = `Usage: csb-tiles --bbox west,south,east,north --out region.mbtiles [options]

  --name <text>         Tileset name (default: "Crowdsourced depth")
  --cell <metres>       Cell size (default: 30)
  --fill <cells>        Widest gap filled between soundings (default: 1)
  --concurrency <n>     Parallel downloads (default: 8)
  --tide-km <km>        Reduce depths to LAT with a predicted tide from stations
                        this close (default: 50, 0 keeps depths as sounded)
  --max-files <n>       Only the newest n files, for trial runs
`;

/**
 * Reads a numeric option, refusing anything else: Number() turns "abc" into
 * NaN and "" into 0, which would build silently with no cells or no workers.
 */
export function numberOption(
  name: string,
  value: string,
  { min, integer = false }: { min: number; integer?: boolean },
): number {
  const n = value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(n) || n < min || (integer && !Number.isInteger(n))) {
    throw new Error(
      `--${name} must be ${integer ? "a whole number" : "a number"} of at least ${min}, not "${value}"`,
    );
  }
  return n;
}

export async function main(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      bbox: { type: "string" },
      out: { type: "string" },
      name: { type: "string", default: "Crowdsourced depth" },
      cell: { type: "string", default: "30" },
      fill: { type: "string", default: "1" },
      concurrency: { type: "string", default: "8" },
      "tide-km": { type: "string", default: String(DEFAULT_MAX_STATION_KM) },
      "max-files": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help || !values.bbox || !values.out) {
    console.log(USAGE);
    process.exitCode = values.help ? 0 : 1;
    return;
  }
  const tideKm = numberOption("tide-km", values["tide-km"], { min: 0 });
  const report = await build({
    bbox: parseBBox(values.bbox),
    out: values.out,
    name: values.name,
    cellMeters: numberOption("cell", values.cell, { min: 1 }),
    fillCells: numberOption("fill", values.fill, { min: 0, integer: true }),
    concurrency: numberOption("concurrency", values.concurrency, {
      min: 1,
      integer: true,
    }),
    ...(tideKm > 0 ? { tideStationKm: tideKm } : {}),
    ...(values["max-files"] !== undefined
      ? {
          maxFiles: numberOption("max-files", values["max-files"], {
            min: 1,
            integer: true,
          }),
        }
      : {}),
    log: (message) => console.error(message),
  });
  console.log(JSON.stringify(report, null, 2));
}
