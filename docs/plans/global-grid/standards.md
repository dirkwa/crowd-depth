# Standards

What the IHO standards say about data quality, survey accuracy, and deriving depth areas, contours and soundings, as they apply to the [global grid](README.md). Section numbers refer to the editions listed in [references](references.md#standards). Crowdsourced bathymetry doesn't meet any IHO survey order, but these standards set the vocabulary charts and plotters already use, so the grid describes itself in their terms.

## Zones of confidence

Charts describe bathymetric quality with CATZOC (S-57 `M_QUAL`), which S-101 carries forward as Quality of Bathymetric Data. Every area with depth data must be covered by quality polygons that don't overlap (S-57 Use of the Object Catalogue §2.2.3.1).

| ZOC | S-57 / S-101 value | Position accuracy | Depth accuracy | Seafloor coverage                                                             |
| --- | ------------------ | ----------------- | -------------- | ----------------------------------------------------------------------------- |
| A1  | 1                  | ±5 m + 5% d       | 0.5 m + 1% d   | Full search, all significant features detected                                |
| A2  | 2                  | ±20 m             | 1.0 m + 2% d   | Full search, significant features detected                                    |
| B   | 3                  | ±50 m             | 1.0 m + 2% d   | Not full; uncharted features hazardous to surface navigation are not expected |
| C   | 4                  | ±500 m            | 2.0 m + 5% d   | Not full; depth anomalies may be expected                                     |
| D   | 5                  | Worse than C      | Worse than C   | Not full; large depth anomalies may be expected                               |
| U   | 6                  | Unassessed        | Unassessed     | Quality yet to be assessed                                                    |

A zone's category is the worst of its components. S-66 tells mariners to treat ZOC U with the same caution as ZOC D.

For crowdsourced data:

- Positions of about ±10 m alone would rate A2.
- Uncalibrated offsets and uncorrected tide put depth accuracy at C or D.
- Coverage is never a systematic search, so it rates D.

The IHO Data Quality Working Group proposed in 2024 that crowdsourced bathymetry default to CATZOC D, with upgrades when GNSS accuracy is better than 15 m and offsets and corrections are applied. The grid uses D until validation supports more. A crowdsourced trial with ARGUS met A2 accuracy but was rated B because coverage was incomplete, which shows coverage, not accuracy, is the limit.

S-101 Quality of Bathymetric Data adds attributes the coverage layer mirrors: zone of confidence, category of temporal variation, data assessment (assessed, oceanic, unassessed), whether features were detected, whether full coverage was achieved, the survey date range, horizontal uncertainty (fixed plus depth-dependent), vertical uncertainty, and the depth range (DCEG §3.8). For an inadequately surveyed area, the DCEG sets temporal variation unassessed, features detected false and full coverage false, with a caution area (§11.9.1).

## Survey orders

IHO S-44 (Edition 6.2.0, Table 1) sets the maximum allowable vertical uncertainty at 95% confidence as

```
TVU(d) = sqrt(a² + (b × d)²)
```

| Order     | a (m) | b      | Horizontal uncertainty | Use                                                       |
| --------- | ----- | ------ | ---------------------- | --------------------------------------------------------- |
| Exclusive | 0.15  | 0.0075 | 1 m                    | Critical, shallow areas with minimal under-keel clearance |
| Special   | 0.25  | 0.0075 | 2 m                    | Areas where under-keel clearance is critical              |
| 1a        | 0.5   | 0.013  | 5 m + 5% d             | Shallow areas where features may be a concern             |
| 1b        | 0.5   | 0.013  | 5 m + 5% d             | As 1a, without full coverage                              |
| 2         | 1.0   | 0.023  | 20 m + 10% d           | Deeper than 200 m, 5% coverage                            |

CATZOC tolerances are written as a + b·d, while S-44 adds the terms in quadrature, so the two aren't interchangeable.

S-44 Annex A works through a crowdsourced single-beam example. It classifies the dataset on vertical and horizontal uncertainty in the S-44 matrix and leaves coverage unclassified, because coverage "is of no use if it is not a systematically performed survey". The grid's validation uses the S-44 TVU formula to test agreement with surveys by depth band.

S-68 §3 notes that crowdsourced and satellite-derived bathymetry don't conform to survey orders but can still be suitable for updating charts, and that survey order is only one input to CATZOC. Gridding and generalization also count, and hydrographic offices downgrade for age, generalization and seabed instability.

## Deriving depth areas, contours and soundings

From IHO S-4 (Edition 4.10.0) and the cartographic literature in [references](references.md#gridding-and-compilation-methods):

- **Safety.** No source depth may be shoaler than a mariner would expect by interpolating the charted soundings (S-4 B-410a). Displayed depth may never be deeper than measured, and contours may only move toward deeper water. Smoothing includes deeper water inside shoaler contours, never the reverse (B-411.5).
- **Triangle and edge tests.** No sounding inside a triangle of charted soundings may be shoaler than the least of the three, and none between two adjacent soundings shoaler than the lesser of the two (B-410a).
- **Per-cell minimum is not enough.** Contours traced by interpolating between cell centers can miss shoals the per-cell minimum caught (Peters, Ledoux and Meijers 2014). Classifying cells into bands and polygonizing keeps edges exact.
- **Shoals are never removed.** Generalization may drop pits but must keep or enlarge peaks (Guilbert and Zhang 2012).
- **Rounding.** Soundings round down and drying heights round up. Depths to 21 m round to decimetres, 21 to 31 m to half metres, and deeper to whole metres (B-412). Displayed precision must never suggest more accuracy than the data has, which argues for coarser display at CATZOC D.
- **Unsurveyed and inadequately surveyed water.** Areas with only passage soundings are unsurveyed, not interpolated (B-418). Reconnaissance surveys that can't find shoals between lines are inadequately surveyed (B-417). S-4 warns that overusing the "unsurveyed" legend can suggest that other areas are fully surveyed. Approximate contours are dashed (B-411.2).
- **Sounding selection.** Where only passage soundings exist, keep the line pattern rather than a regular grid (B-418.2), and select so that gaps are not concealed (B-417.4). Deeper soundings are dropped first as scale decreases (B-403.1a).

## ENC encoding

From the S-57 Use of the Object Catalogue (Edition 4.4.0) and S-101 DCEG:

- **Bathymetric voids** are `UNSARE` areas within coverage, carrying only informational text and exempt from quality polygons (UOC §5.8.1).
- **Incompletely surveyed water** is either an `UNSARE` holding soundings and contours but no depth areas, or depth areas with explicit `DRVAL1`/`DRVAL2`, both under a quality polygon and a caution note (UOC §5.8.2, DCEG §11.9.1).
- **Survey discontinuities** are a narrow `UNSARE` with a downgraded CATZOC (UOC §5.8.4).
- **Soundings** sit at their true position, encoded to one decimal (UOC §5.3). `QUASOU`, `TECSOU` and `QUAPOS` mark lower reliability, and S-52 draws a low-accuracy marker for `QUASOU` values 3, 4, 5, 8 and 9 or `QUAPOS` other than 1, 10 and 11.
- **Satellite-derived bathymetry** is the closest precedent for crowd data: allowed only where no systematic survey exists, with CATZOC 4 or 5 and `TECSOU` 11 (UOC §5.8.1.1).
- **Depth areas** can't carry `SCAMIN` (UOC §2.2.7), so their generalization is per zoom level. Soundings thin by `SCAMIN`, shoalest kept longest.
- **Portrayal.** S-52 shows depth areas with unknown depth range in a partly-surveyed pattern and `UNSARE` in a no-data pattern. A depth area missing `DRVAL1` draws as intertidal, so every depth area the grid emits has both values.
