# Terrain Feature Reconstruction Report

**Status:** Read-only comparison of existing CSV terrain columns with the two Copernicus DSM tiles. This report records candidate reconstructions, not a recovered or approved production preprocessing pipeline.

## Inputs and comparison approach

- Dataset: `data/model_table_geo.csv` (3,544 rows).
- DSM tiles: `data/dem/Copernicus_DSM_COG_10_N28_00_E076_00_DEM.tif` and `data/dem/Copernicus_DSM_COG_10_N28_00_E077_00_DEM.tif`.
- Diagnostic: `ml/compare_terrain_features.py`; additional focused comparisons were executed in memory using the same CSV and DSM files.
- All 3,544 CSV coordinates had valid DSM samples: 142 in E076 and 3,402 in E077. Coordinates were handled as longitude/latitude for raster sampling.
- The rasters use EPSG:4326 and approximately 1-arc-second pixels. Since pixel ground width varies with latitude, neighborhood experiments included an in-memory UTM-zone-43N grid in metres and original-grid tests using locally scaled geographic pixel dimensions. No dataset location or tested neighborhood was out of raster coverage.
- Strict numeric agreement is reported as absolute error at or below 0.001 m (or 0.001 degrees for slope). MAE is mean absolute error. A close numerical match is not proof that the original source code used that exact method.

## Results

| Feature                       | Tested candidate / observed relationship                                                      | Comparison                                                                                 | Evidence status                                                                                                                                                                                       |
| ----------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `elev_m`                      | Nearest-pixel sample from the DSM tiles                                                       | 3,544/3,544 within 0.001 m; MAE 0.0000027 m; maximum absolute error 0.0000151 m            | **Strong, effectively exact for these rows.** Strong evidence these tiles, or a raster with identical sampled values, supplied this column. It does not establish the complete preprocessing history. |
| `rel_elev_250m`               | DSM sample minus the mean of pixel centers in a circular neighborhood with 250 m radius       | MAE 0.0806 m; 40/3,544 within 0.001 m                                                      | **Approximate candidate, not exact.**                                                                                                                                                                 |
| `rel_elev_500m`               | DSM sample minus the mean in a circular neighborhood with 500 m radius                        | MAE 0.0456 m; 70/3,544 within 0.001 m                                                      | **Approximate candidate, not exact.**                                                                                                                                                                 |
| `rel_elev_1000m`              | DSM sample minus the mean in a circular neighborhood with 1,000 m radius                      | MAE 0.0307 m; 135/3,544 within 0.001 m                                                     | **Approximate candidate, not exact.** The disk mean was the strongest tested relative-elevation family, particularly at the larger radius.                                                            |
| `depression_depth_250m`       | CSV identity: `max(0, -rel_elev_250m)`                                                        | Exact equality for 3,544/3,544 rows; MAE 0                                                 | **Exact algebraic relationship in this dataset.** This does not prove a hydrologic depression or sink-fill calculation.                                                                               |
| `height_above_local_min_250m` | DSM sample minus the minimum of original-grid pixels whose centers lie in a 250 m radius disk | MAE 0.0813 m; 3,143/3,544 within 0.001 m; maximum absolute error 6.93 m                    | **Strong approximate candidate, not exact.** 401 rows exceed the strict tolerance, including unexplained multi-metre differences.                                                                     |
| `slope_deg`                   | 3×3 central-difference slope using local metre-per-degree pixel spacing                       | MAE 0.00393°; maximum absolute error 0.0265°; 3,384/3,544 within 0.01° and all within 0.1° | **Strongest tested slope candidate, not exact.** The original derivative and pixel-spacing method remain unconfirmed. Horn slope was substantially worse.                                             |

## Additional checks and discrepancy analysis

### Relative elevation

The disk-mean candidates were compared with median, minimum, square-window, and projected-grid variants. Median and minimum statistics performed worse; square candidates also performed worse than the circular means. Further limited sensitivity tests used radii shifted by about one source pixel (approximately ±30 m), excluded the sample's center pixel, expanded or eroded the circle by approximately half a pixel diagonal, and weighted cells approximately by latitude-dependent area.

Those variations did not explain the residual discrepancies: changing radius or the circle boundary generally worsened MAE; excluding the center pixel changed results only slightly; latitude-area weighting was practically indistinguishable from an ordinary mean. Thus, “sample minus circular mean” is a supported hypothesis, not a verified original formula.

### Height above local minimum

The candidate matches 88.69% of rows within 0.001 m, but the largest mismatch is 6.93 m. The 20 largest errors were not concentrated near a DSM outer edge or the seam between the two tiles. Only four dataset points lie within 250 m of the tile seam, with no greater-than-0.1 m height-feature errors among those points. Only eight points are within 250 m of the dataset's coordinate bounding-box edge, and two have errors above 0.1 m.

Absolute error had only a weak rank association with the 250 m local elevation range (Spearman correlation 0.204). The largest-error rows did not, as a group, have unusually large local ranges. Raster-edge effects or especially rugged neighborhoods therefore do not explain the remaining mismatches by themselves. Different neighborhood geometry, grid alignment, preprocessing, or another unrecorded rule remain possible.

### Slope

Central-difference candidate minus stored slope is positive for 3,543 of 3,544 rows. Its mean residual is +0.00393°, median +0.00316°, and standard deviation 0.00306°. The mean absolute residual is similar on both tiles (0.00228° for E076's 142 samples and 0.00400° for E077's 3,402 samples).

Alternative common spacing conventions did not remove this offset: omitting the longitude cosine correction or assuming 30 m in both axes made the fit worse; an ellipsoid-based local spacing also performed worse than the tested spherical local spacing. Central differences remain the best tested family, but the small systematic difference could reflect a different derivative, preprocessing, or raster-spacing convention that these tests did not recover.

## Exact relationships versus candidate formulas

- The exact `depression_depth_250m = max(0, -rel_elev_250m)` relationship is established from the stored CSV values. It is an algebraic relationship only; do not describe it as proof of hydrologic depression modeling.
- `elev_m` is reproduced to within the chosen 0.001 m tolerance at every sample by nearest-pixel DSM sampling. This is effectively exact for the available rows, though the raster's provenance and vertical reference are not thereby certified.
- Circular means for relative elevation, a 250 m local minimum for height above local minimum, and central-difference slope are **approximate reconstruction candidates**. None exactly reproduces the corresponding stored feature for every row.
- Do not silently replace the model's training feature generation with these candidates or assume their close fit transfers to new locations.

## Assumptions and limitations

1. The 250 m, 500 m, and 1,000 m tests interpret the numbers as **radii** for circular neighborhoods. Other original neighborhood conventions are possible.
2. The original-grid neighborhood tests include pixel centers inside the tested boundary and use local geographic pixel-to-metre scaling. A UTM in-memory comparison was also used; resampling can smooth terrain minima and was not treated as the original recipe.
3. DSM point sampling used the raster's nearest pixel. The exact original sampling method is unknown, although the resulting `elev_m` agreement is exceptionally close.
4. The TIFF metadata identifies EPSG:4326 for horizontal coordinates, but does not document a vertical unit or nodata value. **DSM vertical units and original preprocessing provenance remain unconfirmed.**
5. These comparisons use only 3,544 sample locations and the supplied two tiles. They do not establish behavior outside this coverage.
6. No original terrain-generation script, notebook, or authoritative preprocessing recipe has been recovered. The experiments cannot establish the original neighborhood shape, boundary rule, filtering, slope implementation, or nodata treatment.
7. No dataset, TIFF, trained model, manifest, or backend code was modified; no model was retrained and no endpoint was created.

## Conclusion

The data strongly support nearest-pixel DSM sampling for `elev_m`, an exact algebraic dependency for `depression_depth_250m`, and plausible approximate candidates for the other five terrain features. Remaining differences are material for some rows and are not resolved by the limited radius, inclusion, and spacing checks. The original formulas should remain marked **unconfirmed** until the source-generation recipe is recovered or separately validated; this report does not claim the candidates reproduce the original pipeline exactly.
