# Candidate feature list — initial baseline

This is a conservative research baseline for `data/model_table_geo.csv`. It is intentionally separate from `backend/model/` and does not use or replace the existing ONNX/joblib artifacts.

## Included by default

The script `train_baseline.py` selects these columns explicitly and in a fixed order:

1. `elev_m`
2. `rel_elev_250m`
3. `rel_elev_500m`
4. `rel_elev_1000m`
5. `depression_depth_250m`
6. `height_above_local_min_250m`
7. `slope_deg`
8. `dist_river_m`
9. `dist_canal_m`
10. `dist_drain_m`
11. `dist_waterbody_m`
12. `dist_any_water_m`
13. `dist_tunnel_m`
14. `tunnel_flag_50m`
15. `dist_underpass_m`
16. `underpass_flag_50m`
17. `event_month_sin` (derived only from `event_date`)
18. `event_month_cos` (derived only from `event_date`)

The terrain and mapped-distance columns are plausible static/site characteristics, but their source, vintage, and exact derivation are not documented in this workspace. The CSV contains precomputed values, but this workspace does not contain the elevation rasters or a verified GIS feature-generation process needed to reproduce them for a new live location. Their availability at prediction time is therefore **not confirmed**; verify and implement those lookups before using the model for live predictions. Month is known in advance; it is derived from the event date, not the target.

## Excluded columns

- `waterlogging`: prediction target, never a predictor.
- `low_rain_positive`: target-derived flag (the existing model script itself marks it leaky).
- `hist_reports_150m`, `hist_distinct_dates_150m`: exclude because their source record timestamps and cutoff are undocumented. Do not restore them until they can be rebuilt from timestamped reports available strictly before each prediction and without using validation/test labels.
- `row_id`, `loc_id`, `block_id`: identifiers, not generalizable measurements.
- `latitude`, `longitude`: retained only as sample metadata/grouping context, not model inputs, to reduce memorization of locations.
- `split`, `spatial_fold`: validation/split metadata, never model inputs. `spatial_fold` is used only to group training examples during cross-validation.
- `event_date`, `year`, `month`, `is_monsoon`: do not enter as raw columns. Only cyclical month features are derived from the date; this avoids an arbitrary year trend and redundant calendar fields.
- `elev_missing`: constant in the observed CSV (all values are zero), so it carries no signal in this dataset.
- `rainfall_mm`: omitted initially. Its observation interval and availability relative to the prediction time have not been established. Consider it only after verifying that it is an input available at the intended prediction time (for example, a forecast issued before the prediction, not a later event total).

## Evaluation design

The CSV marks `train` and `test` periods. The baseline verifies that all training dates precede all test dates, then uses only the marked training rows for model selection with 5-fold `GroupKFold` grouped by `spatial_fold`. The marked test rows are evaluated once after selecting a model by mean spatial-fold average precision. The test set is not used for model selection or threshold tuning. The CSV uses the same five `spatial_fold` labels in both periods, so this is a later-time test at a spatial-fold mix that may overlap training geography—not a test of generalization to wholly unseen areas.

Outputs report ranking metrics and fixed-0.5 classification metrics for transparency; 0.5 is not claimed to be an appropriate operational threshold. The resulting scores are not calibrated probabilities and are not safety guarantees.

## Limitations

- This is evaluation/training code, not a validated live prediction service.
- A CSV split label is not proof that data-generation or feature engineering was leakage-free. The script checks dates, not the provenance of the data.
- Spatial fold IDs are supplied by the dataset; their construction needs independent validation.
- The origin and date of the terrain and mapped-distance source layers are unknown. The model can only be scored on new samples after a separately verified feature-generation path supplies values in the same units and meaning as the training columns.
- The held-out rows cover only 2024-06-27 through 2024-09-17. Results may not generalize to other seasons, years, locations, rainfall conditions, or future drainage/infrastructure changes.
- The available code does not establish how the existing ONNX model was trained. This baseline does not integrate it and does not export ONNX.
- Running the script requires the separately listed Python dependencies in `ml/requirements.txt`. Its version ranges are not a lockfile; the evaluation output records the installed versions, but exact reproduction requires saving/freezing those resolved versions and retaining this dataset version.
