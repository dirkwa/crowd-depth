import { parseArgs } from "node:util";
import { parseBBox } from "./bbox.js";
import { build } from "./build.js";

const USAGE = `Usage: csb-tiles --bbox west,south,east,north --out region.mbtiles [options]

  --name <text>         Tileset name (default: "Crowdsourced depth")
  --cell <metres>       Cell size (default: 30)
  --fill <cells>        Widest gap filled between soundings (default: 1)
  --concurrency <n>     Parallel downloads (default: 8)
  --max-files <n>       Only the newest n files, for trial runs
`;

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
      "max-files": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help || !values.bbox || !values.out) {
    console.log(USAGE);
    process.exitCode = values.help ? 0 : 1;
    return;
  }
  const report = await build({
    bbox: parseBBox(values.bbox),
    out: values.out,
    name: values.name,
    cellMeters: Number(values.cell),
    fillCells: Number(values.fill),
    concurrency: Number(values.concurrency),
    ...(values["max-files"] ? { maxFiles: Number(values["max-files"]) } : {}),
    log: (message) => console.error(message),
  });
  console.log(JSON.stringify(report, null, 2));
}
