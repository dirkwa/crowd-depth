# crowd-depth-tiles

Builds regional vector MBTiles of crowd-sourced soundings from the
[IHO DCDB archive hosted by NOAA NCEI](https://noaa-dcdb-bathymetry-pds.s3.amazonaws.com/docs/readme.html),
which is where the Signal K plugin's reports end up.

> [!WARNING]
> **Not for navigation.** These are crowd-sourced soundings binned by cell: the
> tide they are reduced by is predicted, not measured, sensor offsets vary by
> vessel and are not known, and nothing is quality-checked beyond dropping
> impossible values.

## How it works

1. NOAA's [CSB track index](https://gis.ngdc.noaa.gov/arcgis/rest/services/csb/MapServer/1)
   lists every submitted file whose track crosses the region. The index carries
   no depths, but each entry's name maps to its CSV in the public S3 bucket.
2. Each CSV is streamed from the bucket and never stored. A sounding within
   50 km of a tide station is reduced to Lowest Astronomical Tide (LAT) by the
   tide predicted for its time and place, so a depth reads like a charted one;
   farther out it stays as sounded. Predictions come from
   [Slackwater](https://github.com/openwatersio/slackwater), offline, from the
   station's harmonic constants: the engine the
   [signalk-tides](https://github.com/openwatersio/signalk-tides) plugin runs,
   so a boat showing that plugin's tide sees the water level the tiles were
   reduced with. Ground that would dry at LAT reads as zero.
3. Soundings inside the region are binned into cells (30 m by default), keeping per cell the median,
   minimum and maximum depth, the number of soundings, the number of distinct
   vessels, and when it was last sounded.
4. The cell medians become a raster. An empty cell is filled only where
   soundings bracket it on opposite sides, along a row, column or diagonal,
   across at most `--fill` cells (one by default), and GDAL traces depth areas
   and contours from it. Nothing grows past the edge of a track or is shaded
   between tracks: an unsounded gap can hide a reef, so it must stay blank
   rather than look like open water.
5. [tippecanoe](https://github.com/felt/tippecanoe) tiles three layers named
   after their S-57 object classes, and the MBTiles is marked `type=S-57`, so a
   plotter that styles ENCs draws it like one, with the user's safety depth:

   | Layer    | Geometry | Attributes                                                               |
   | -------- | -------- | ------------------------------------------------------------------------ |
   | `SOUNDG` | point    | `DEPTH` (cell median), `min`, `max`, `count`, `tided`, `vessels`, `last` |
   | `DEPARE` | polygon  | `DRVAL1`, `DRVAL2`                                                       |
   | `DEPCNT` | line     | `VALDCO`                                                                 |

`tided` counts the cell's soundings reduced by a predicted tide; the rest are
as sounded. The MBTiles metadata carries `vertical_datum` (`LAT`, or `none`
with `--tide-km 0`) and `normalized=false`: CSB does not record whether a
depth is below the surface or the transducer, so these tiles can never claim
corrected depths, and a plotter can tell them apart from data that does.

A whole submission file is downloaded even when only part of its track is in
the region, so a small region still reads every voyage that touched it.

## Usage

Requires `tippecanoe` and GDAL (`gdal_calc.py`, `gdal_polygonize.py`, `gdal_contour`) on the `PATH`.

```sh
npm run build
packages/tiles/bin/csb-tiles --bbox 176,-20,-178,-15 --out fiji.mbtiles
```

A box whose west edge is greater than its east edge crosses the antimeridian.
Write a box that starts with a negative longitude as `--bbox=-77.5,36.8,-75.5,39.7`,
or it reads as an option.
Each run also writes `<out>.json` with the counts behind the tiles.

## Publishing

`.github/workflows/csb-tiles.yml` rebuilds every region in
[`regions.json`](regions.json) weekly and uploads the MBTiles plus a
`catalog.json` to the rolling `csb-tiles` release, so each file keeps a stable
URL.
