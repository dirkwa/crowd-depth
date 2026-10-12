/** [west, south, east, north] in degrees. `west > east` means the box crosses the antimeridian. */
export type BBox = [number, number, number, number];

export function parseBBox(value: string): BBox {
  const parts = value.split(",").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`Invalid bbox "${value}", expected west,south,east,north`);
  }
  const [west, south, east, north] = parts as BBox;
  if (south >= north || south < -90 || north > 90) {
    throw new Error(`Invalid bbox "${value}": south must be below north`);
  }
  if (Math.abs(west) > 180 || Math.abs(east) > 180) {
    throw new Error(`Invalid bbox "${value}": longitudes must be within ±180`);
  }
  return [west, south, east, north];
}

/**
 * Splits a box that crosses the antimeridian into two that don't, since
 * neither the ArcGIS envelope query nor a plain range test handles the wrap.
 */
export function splitAntimeridian(bbox: BBox): BBox[] {
  const [west, south, east, north] = bbox;
  if (west <= east) return [bbox];
  return [
    [west, south, 180, north],
    [-180, south, east, north],
  ];
}

export function contains(bbox: BBox, lon: number, lat: number): boolean {
  const [west, south, east, north] = bbox;
  if (lat < south || lat > north) return false;
  return west <= east ? lon >= west && lon <= east : lon >= west || lon <= east;
}
