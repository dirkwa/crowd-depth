import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import type { BBox } from "./bbox.js";
import { contains } from "./bbox.js";

/**
 * Soundings sampled per cell for the median. Nine keep the median robust
 * against a few bad readings while a dense region's millions of cells still
 * fit in memory.
 */
const SAMPLE_SIZE = 9;

/** Distinct vessels counted per cell; beyond this a cell is simply well sounded. */
export const MAX_VESSELS = 4;

/**
 * Deeper than any ocean, so anything beyond is a sounder or encoding fault.
 * Depth is positive down; some providers mark missing soundings with -1e9.
 */
export const MAX_DEPTH = 11_000;

/** Marks a raster cell nobody sounded. */
export const NO_DATA = -9999;

export interface CellSummary {
  lon: number;
  lat: number;
  /** Median of the sampled soundings: robust against a single bad reading. */
  depth: number;
  min: number;
  max: number;
  mean: number;
  count: number;
  /** Distinct vessels that sounded the cell, up to MAX_VESSELS; one alone is weaker evidence. */
  vessels: number;
  /** When the cell was last sounded, as an ISO date. */
  last: string;
}

export interface GridOptions {
  /** Must not cross the antimeridian; split it first. */
  bbox: BBox;
  /** Cell edge in metres, measured north-south. */
  cellMeters: number;
}

/** FNV-1a, enough to tell a handful of vessel names apart within one cell. */
function hash(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // Zero marks an empty vessel slot.
  return h >>> 0 || 1;
}

/**
 * Bins soundings into a regular lat/lon grid over the box, so each cell is
 * also one pixel of the raster the depth areas are traced from. Longitude
 * steps are set at the box's middle latitude to keep cells roughly square.
 *
 * Cells live in parallel typed arrays rather than one object each: a busy
 * region has millions of them, and per-cell objects exhausted the heap.
 */
export class SoundingGrid {
  readonly latStep: number;
  readonly lonStep: number;
  readonly width: number;
  readonly height: number;
  private readonly index = new Map<number, number>();
  private keys = new Float64Array(0);
  private count = new Uint32Array(0);
  private min = new Float32Array(0);
  private max = new Float32Array(0);
  private sum = new Float64Array(0);
  private last = new Float64Array(0);
  private samples = new Float32Array(0);
  private vessels = new Uint32Array(0);
  private readonly hashes = new Map<string, number>();
  private size = 0;
  private rejected = 0;
  private seen = 0;

  constructor(private readonly options: GridOptions) {
    const [west, south, east, north] = options.bbox;
    if (west > east)
      throw new Error("Split a box across the antimeridian before gridding it");
    const nominalLat = options.cellMeters / 111_320;
    const midLat = (south + north) / 2;
    const nominalLon =
      nominalLat / Math.max(Math.cos((midLat * Math.PI) / 180), 0.01);
    // Steps are stretched slightly so whole cells tile the box exactly; a
    // last cell overhanging 180° would put depths on the other side of the globe.
    this.width = Math.max(1, Math.round((east - west) / nominalLon));
    this.height = Math.max(1, Math.round((north - south) / nominalLat));
    this.lonStep = (east - west) / this.width;
    this.latStep = (north - south) / this.height;
  }

  private grow() {
    const capacity = Math.max(1024, this.keys.length * 2);
    const resize = <T extends Float64Array | Float32Array | Uint32Array>(
      old: T,
      make: (n: number) => T,
      per = 1,
    ): T => {
      const next = make(capacity * per);
      next.set(old);
      return next;
    };
    this.keys = resize(this.keys, (n) => new Float64Array(n));
    this.count = resize(this.count, (n) => new Uint32Array(n));
    this.min = resize(this.min, (n) => new Float32Array(n));
    this.max = resize(this.max, (n) => new Float32Array(n));
    this.sum = resize(this.sum, (n) => new Float64Array(n));
    this.last = resize(this.last, (n) => new Float64Array(n));
    this.samples = resize(
      this.samples,
      (n) => new Float32Array(n),
      SAMPLE_SIZE,
    );
    this.vessels = resize(this.vessels, (n) => new Uint32Array(n), MAX_VESSELS);
  }

  private vesselHash(platform: string): number {
    let h = this.hashes.get(platform);
    if (h === undefined) {
      h = hash(platform);
      this.hashes.set(platform, h);
    }
    return h;
  }

  add(lon: number, lat: number, depth: number, platform: string, time: string) {
    if (!contains(this.options.bbox, lon, lat)) return;
    this.seen++;
    if (!(depth > 0) || depth > MAX_DEPTH) {
      this.rejected++;
      return;
    }
    const [west, , , north] = this.options.bbox;
    // Row 0 is the northern edge, as rasters are laid out.
    const row = Math.min(
      Math.floor((north - lat) / this.latStep),
      this.height - 1,
    );
    const col = Math.min(
      Math.floor((lon - west) / this.lonStep),
      this.width - 1,
    );
    const key = row * this.width + col;

    let i = this.index.get(key);
    if (i === undefined) {
      if (this.size === this.keys.length) this.grow();
      i = this.size++;
      this.index.set(key, i);
      this.keys[i] = key;
      this.min[i] = depth;
      this.max[i] = depth;
    }
    const n = ++this.count[i]!;
    this.sum[i]! += depth;
    if (depth < this.min[i]!) this.min[i] = depth;
    if (depth > this.max[i]!) this.max[i] = depth;
    const at = Date.parse(time);
    if (at > this.last[i]!) this.last[i] = at;

    const v = this.vesselHash(platform);
    for (let slot = i * MAX_VESSELS; slot < (i + 1) * MAX_VESSELS; slot++) {
      if (this.vessels[slot] === v) break;
      if (this.vessels[slot] === 0) {
        this.vessels[slot] = v;
        break;
      }
    }

    // Reservoir sampling keeps the median estimate unbiased without storing every sounding.
    if (n <= SAMPLE_SIZE) {
      this.samples[i * SAMPLE_SIZE + n - 1] = depth;
    } else {
      const slot = Math.floor(Math.random() * n);
      if (slot < SAMPLE_SIZE) this.samples[i * SAMPLE_SIZE + slot] = depth;
    }
  }

  get stats() {
    return { seen: this.seen, rejected: this.rejected, cells: this.size };
  }

  private median(i: number): number {
    const n = Math.min(this.count[i]!, SAMPLE_SIZE);
    return median(
      Array.from(this.samples.subarray(i * SAMPLE_SIZE, i * SAMPLE_SIZE + n)),
    );
  }

  *summaries(): Generator<CellSummary> {
    const [west, , , north] = this.options.bbox;
    for (let i = 0; i < this.size; i++) {
      const key = this.keys[i]!;
      const row = Math.floor(key / this.width);
      const col = key % this.width;
      let vessels = 0;
      for (let slot = i * MAX_VESSELS; slot < (i + 1) * MAX_VESSELS; slot++) {
        if (this.vessels[slot] !== 0) vessels++;
      }
      yield {
        lon: west + (col + 0.5) * this.lonStep,
        lat: north - (row + 0.5) * this.latStep,
        depth: this.median(i),
        min: this.min[i]!,
        max: this.max[i]!,
        mean: this.sum[i]! / this.count[i]!,
        count: this.count[i]!,
        vessels,
        last: this.last[i]
          ? new Date(this.last[i]!).toISOString().slice(0, 10)
          : "",
      };
    }
  }

  /**
   * Writes the cell medians as a float32 ENVI raster, a raw format GDAL reads
   * without a GDAL binding here. Rows stream out one at a time so a large
   * region never needs the whole raster in memory.
   */
  async writeRaster(path: string): Promise<void> {
    const order = Array.from({ length: this.size }, (_, i) => i).sort(
      (a, b) => this.keys[a]! - this.keys[b]!,
    );

    const stream = createWriteStream(path);
    const line = new Float32Array(this.width);
    let next = 0;
    for (let row = 0; row < this.height; row++) {
      line.fill(NO_DATA);
      while (next < order.length) {
        const i = order[next]!;
        const key = this.keys[i]!;
        if (Math.floor(key / this.width) !== row) break;
        line[key % this.width] = this.median(i);
        next++;
      }
      if (!stream.write(Buffer.from(line.buffer.slice(0))))
        await once(stream, "drain");
    }
    stream.end();
    await once(stream, "finish");

    const [west, , , north] = this.options.bbox;
    await writeFile(
      path.replace(/\.[^.]+$/, "") + ".hdr",
      [
        "ENVI",
        `samples = ${this.width}`,
        `lines = ${this.height}`,
        "bands = 1",
        "header offset = 0",
        "file type = ENVI Standard",
        "data type = 4",
        "interleave = bsq",
        "byte order = 0",
        `map info = {Geographic Lat/Lon, 1, 1, ${west}, ${north}, ${this.lonStep}, ${this.latStep}, WGS-84}`,
        `data ignore value = ${NO_DATA}`,
        "",
      ].join("\n"),
    );
  }
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** One decimetre is finer than any single-beam sounder resolves. */
function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * A cell as an S-57 sounding. The layer and attribute names follow S-57 so a
 * chart plotter that styles ENCs (Freeboard-SK does) draws it as depth figures.
 */
export function toSounding(cell: CellSummary): string {
  return JSON.stringify({
    type: "Feature",
    geometry: {
      type: "Point",
      coordinates: [
        Math.round(cell.lon * 1e6) / 1e6,
        Math.round(cell.lat * 1e6) / 1e6,
      ],
    },
    properties: {
      DEPTH: round(cell.depth),
      min: round(cell.min),
      max: round(cell.max),
      count: cell.count,
      vessels: cell.vessels,
      last: cell.last,
    },
  });
}
