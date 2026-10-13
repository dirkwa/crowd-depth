import { nearestStation } from "slackwater";

/**
 * The chart datum soundings are reduced to. Lowest Astronomical Tide is the
 * datum IHO recommends for charts, so a reduced depth reads like a charted one.
 */
export const TIDE_DATUM = "LAT";

/**
 * Tide phase and range drift with distance along a coast, so a station far
 * away predicts the wrong tide. Beyond this a sounding stays unreduced.
 */
export const DEFAULT_MAX_STATION_KM = 50;

/** Tide moves a few centimetres a minute at most; one prediction serves the whole minute. */
const TIME_STEP_MS = 60_000;

/** ~1 km: a vessel's consecutive soundings share one nearest-station lookup. */
const POSITION_STEP = 0.01;

/**
 * Files stream one voyage at a time, so recent minutes are the ones reused;
 * dropping the cache now and then keeps a decade of voyages out of memory.
 */
const MAX_CACHED_LEVELS = 200_000;

export interface TideCorrection {
  /** Predicted water level above the datum, in metres. */
  height: number;
  station: string;
}

export interface TideReducer {
  /** Water level above the datum at a sounding, or undefined when no station is close enough. */
  at(lon: number, lat: number, time: string): TideCorrection | undefined;
  /** Stations used so far, for attribution. */
  readonly stations: ReadonlyMap<
    string,
    { name: string; source: string; attribution: string }
  >;
}

type Station = ReturnType<typeof nearestStation>;

/**
 * Predicts the tide at each sounding from the nearest station's harmonic
 * constituents, offline, with Slackwater: the engine the signalk-tides plugin
 * runs, so a boat showing that plugin's tide sees the same water level the
 * tiles were reduced with.
 */
export function createTideReducer({
  maxStationKm = DEFAULT_MAX_STATION_KM,
  datum = TIDE_DATUM,
}: { maxStationKm?: number; datum?: string } = {}): TideReducer {
  const nearest = new Map<string, Station | null>();
  const levels = new Map<string, number | null>();
  const stations = new Map<
    string,
    { name: string; source: string; attribution: string }
  >();

  const stationFor = (lon: number, lat: number): Station | null => {
    const key = `${Math.round(lon / POSITION_STEP)},${Math.round(lat / POSITION_STEP)}`;
    let station = nearest.get(key);
    if (station === undefined) {
      try {
        const found = nearestStation({ lon, lat });
        station =
          found.distance !== undefined && found.distance <= maxStationKm
            ? found
            : null;
      } catch {
        station = null;
      }
      nearest.set(key, station);
    }
    return station;
  };

  return {
    stations,
    at(lon, lat, time) {
      const at = Date.parse(time);
      if (!Number.isFinite(at)) return undefined;
      const station = stationFor(lon, lat);
      if (!station) return undefined;

      const minute = Math.round(at / TIME_STEP_MS);
      const key = `${station.id}@${minute}`;
      let height = levels.get(key);
      if (height === undefined) {
        try {
          height = station.getWaterLevelAtTime({
            time: new Date(minute * TIME_STEP_MS),
            datum,
          }).level;
        } catch {
          // The station publishes no offset for this datum.
          height = null;
        }
        if (levels.size >= MAX_CACHED_LEVELS) levels.clear();
        levels.set(key, height);
      }
      if (height === null || !Number.isFinite(height)) return undefined;

      if (!stations.has(station.id)) {
        stations.set(station.id, {
          name: station.name,
          source: station.source.name,
          // Present at runtime but missing from the published types.
          attribution:
            (station as { attribution?: string }).attribution ??
            station.source.name,
        });
      }
      return { height, station: station.id };
    },
  };
}
