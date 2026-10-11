"""Read-only candidate comparison for terrain columns in the model CSV.

This diagnostic does NOT write to the CSV, rasters, model, or any outputs. It
reprojects a temporary in-memory copy of the DSM mosaic to UTM metres for
neighborhood experiments, and compares candidate values to the stored CSV.

Run from the project root:
    ./.venv/bin/python ml/compare_terrain_features.py

Candidate windows are reported explicitly: disk radius R, square side R, and
square half-width R. None is asserted to be the original recipe. Slope is a
standard 3x3 Horn estimate using the source-grid elevation neighborhood and
local geographic pixel dimensions converted approximately to metres.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import rasterio
from rasterio.enums import Resampling
from rasterio.merge import merge
from rasterio.warp import calculate_default_transform, reproject

ROOT = Path(__file__).resolve().parents[1]
CSV_PATH = ROOT / "data" / "model_table_geo.csv"
DEM_PATHS = [
    ROOT / "data" / "dem" / "Copernicus_DSM_COG_10_N28_00_E076_00_DEM.tif",
    ROOT / "data" / "dem" / "Copernicus_DSM_COG_10_N28_00_E077_00_DEM.tif",
]
METRIC_CRS = "EPSG:32643"  # UTM zone 43N, metre units, covering Delhi
RADII_M = (250, 500, 1000)
EXACT_TOL_M = 0.001
NEAR_TOLS_M = (0.01, 0.1, 1.0)
EARTH_RADIUS_M = 6_371_008.8


def compare(
    name: str,
    expected: np.ndarray,
    candidate: np.ndarray,
    unit: str = "m",
) -> dict[str, Any]:
    valid = np.isfinite(expected) & np.isfinite(candidate)
    n = int(valid.sum())
    if not n:
        print(f"{name}: n=0 (no comparable rows)")
        return {"n": 0}

    err = candidate[valid] - expected[valid]
    abs_err = np.abs(err)
    exact = int(np.count_nonzero(abs_err <= EXACT_TOL_M))
    stats: dict[str, Any] = {
        "n": n,
        "bias": float(np.mean(err)),
        "mae": float(np.mean(abs_err)),
        "rmse": float(np.sqrt(np.mean(err**2))),
        "max_abs_error": float(np.max(abs_err)),
        "exact_count_tol_0_001m": exact,
        "exact_fraction_tol_0_001m": exact / n,
    }
    for tol in NEAR_TOLS_M:
        stats[f"within_{tol:g}m"] = int(np.count_nonzero(abs_err <= tol))
    if n > 1 and np.std(expected[valid]) > 0 and np.std(candidate[valid]) > 0:
        stats["correlation"] = float(np.corrcoef(expected[valid], candidate[valid])[0, 1])
    print(
        f"{name}: n={n}, bias={stats['bias']:.6g} {unit}, "
        f"MAE={stats['mae']:.6g} {unit}, RMSE={stats['rmse']:.6g} {unit}, "
        f"max|err|={stats['max_abs_error']:.6g} {unit}, "
        f"exact(<=0.001{unit})={exact}/{n} ({100*exact/n:.2f}%), "
        + ", ".join(f"<= {tol:g}{unit}: {stats[f'within_{tol:g}m']}" for tol in NEAR_TOLS_M)
        + (f", corr={stats['correlation']:.5f}" if "correlation" in stats else "")
    )
    return stats


def load_mosaic() -> tuple[np.ndarray, rasterio.Affine, Any, np.ndarray, rasterio.Affine]:
    for path in [CSV_PATH, *DEM_PATHS]:
        if not path.is_file():
            raise FileNotFoundError(f"Required input is missing: {path}")

    with rasterio.open(DEM_PATHS[0], "r") as first, rasterio.open(DEM_PATHS[1], "r") as second:
        if first.crs != second.crs:
            raise ValueError(f"DSM CRS mismatch: {first.crs} vs {second.crs}")
        if first.crs is None:
            raise ValueError("DSM has no CRS")
        mosaic, transform = merge([first, second], indexes=1, masked=True)
        src_crs = first.crs
        src_nodata = first.nodata
        src_res = first.res

    # Preserve invalid/masked source pixels as NaN for all calculations.
    mosaic = np.ma.asarray(mosaic[0])
    source = np.asarray(mosaic.filled(np.nan), dtype=np.float32)
    source[~np.isfinite(source)] = np.nan
    if src_nodata is not None and np.isfinite(src_nodata):
        source[source == src_nodata] = np.nan

    left, bottom, right, top = rasterio.transform.array_bounds(
        source.shape[0], source.shape[1], transform
    )
    dst_transform, width, height = calculate_default_transform(
        src_crs,
        METRIC_CRS,
        source.shape[1],
        source.shape[0],
        left,
        bottom,
        right,
        top,
        resolution=30.0,
    )
    projected = np.full((height, width), np.nan, dtype=np.float32)
    reproject(
        source=source,
        destination=projected,
        src_transform=transform,
        src_crs=src_crs,
        src_nodata=np.nan,
        dst_transform=dst_transform,
        dst_crs=METRIC_CRS,
        dst_nodata=np.nan,
        resampling=Resampling.bilinear,
        init_dest_nodata=True,
    )
    valid_mask = np.isfinite(projected)
    print(f"Source CRS: {src_crs}; source pixel size in degrees: {src_res}")
    print(
        f"Temporary in-memory analysis grid: {METRIC_CRS}, {width} x {height}, "
        f"pixel size approximately 30 m"
    )
    print(
        "Neighborhood coordinate note: dataset coordinates are transformed to "
        "UTM metres; windows use pixel-center distance from the exact point."
    )
    return projected, dst_transform, src_crs, source, transform


def sample_source_elevation(
    frame: pd.DataFrame,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    lat = frame["latitude"].to_numpy(dtype=float)
    lon = frame["longitude"].to_numpy(dtype=float)
    direct_values = np.full(len(frame), np.nan, dtype=float)
    tile_names = np.full(len(frame), "", dtype=object)
    valid = np.zeros(len(frame), dtype=bool)

    # The tiles meet at the 77-degree meridian. Sample tile extents using their
    # actual transforms rather than hard-coded coordinate boundaries.
    for path in DEM_PATHS:
        with rasterio.open(path, "r") as src:
            inside_indices: list[int] = []
            coords: list[tuple[float, float]] = []
            for idx, (latitude, longitude) in enumerate(zip(lat, lon)):
                row, col = src.index(longitude, latitude)
                if 0 <= row < src.height and 0 <= col < src.width:
                    inside_indices.append(idx)
                    coords.append((longitude, latitude))
            for idx, sample in zip(inside_indices, src.sample(coords, indexes=1, masked=True)):
                value = sample[0]
                if np.ma.is_masked(value):
                    continue
                number = float(value)
                if not np.isfinite(number) or (src.nodata is not None and number == src.nodata):
                    continue
                direct_values[idx] = number
                tile_names[idx] = path.name
                valid[idx] = True
    return direct_values, tile_names, valid


def sample_projected_neighborhoods(
    latitudes: np.ndarray,
    longitudes: np.ndarray,
    dem: np.ndarray,
    transform: rasterio.Affine,
) -> tuple[np.ndarray, dict[str, np.ndarray], np.ndarray]:
    """Sample raster values and compute candidate local stats in physical units."""
    n = len(latitudes)
    sampled = np.full(n, np.nan, dtype=float)
    counts = {f"{shape}_{radius}": np.zeros(n, dtype=np.int32)
              for radius in RADII_M for shape in ("disk", "square_side", "square_radius")}
    neighborhood_stats = {
        f"{shape}_{radius}_{stat}": np.full(n, np.nan, dtype=float)
        for radius in RADII_M
        for shape in ("disk", "square_side", "square_radius")
        for stat in ("mean", "median", "min", "max")
    }

    # Project each point to the grid CRS using Rasterio's CRS transformation.
    from rasterio.warp import transform as transform_coords

    xs, ys = transform_coords("EPSG:4326", METRIC_CRS, longitudes.tolist(), latitudes.tolist())
    pixel_width = abs(transform.a)
    pixel_height = abs(transform.e)
    max_radius = max(RADII_M)
    half_cols = int(np.ceil(max_radius / pixel_width)) + 2
    half_rows = int(np.ceil(max_radius / pixel_height)) + 2

    # Precompute physical x/y offsets relative to a pixel center in projected CRS.
    dxs = np.arange(-half_cols, half_cols + 1, dtype=float) * pixel_width
    dys = -np.arange(-half_rows, half_rows + 1, dtype=float) * pixel_height
    dx_grid, dy_grid = np.meshgrid(dxs, dys)

    for idx, (x, y) in enumerate(zip(xs, ys)):
        row, col = rasterio.transform.rowcol(transform, x, y)
        r0, r1 = max(0, row - half_rows), min(dem.shape[0], row + half_rows + 1)
        c0, c1 = max(0, col - half_cols), min(dem.shape[1], col + half_cols + 1)
        window = dem[r0:r1, c0:c1]
        if row < 0 or col < 0 or row >= dem.shape[0] or col >= dem.shape[1] or not window.size:
            continue

        # Use the same nearest projected-grid cell as the neighborhood center.
        sampled[idx] = float(dem[row, col]) if np.isfinite(dem[row, col]) else np.nan
        center_x, center_y = rasterio.transform.xy(transform, row, col, offset="center")
        point_dx = center_x - x
        point_dy = center_y - y
        sub_dx = dx_grid[(r0 - (row - half_rows)):(r1 - (row - half_rows)),
                 (c0 - (col - half_cols)):(c1 - (col - half_cols))] + point_dx
        sub_dy = dy_grid[(r0 - (row - half_rows)):(r1 - (row - half_rows)),
                 (c0 - (col - half_cols)):(c1 - (col - half_cols))] + point_dy
        valid = np.isfinite(window)

        for radius in RADII_M:
            masks = {
                f"disk_{radius}": (sub_dx**2 + sub_dy**2) <= radius**2,
                f"square_side_{radius}": (np.abs(sub_dx) <= radius / 2)
                & (np.abs(sub_dy) <= radius / 2),
                f"square_radius_{radius}": (np.abs(sub_dx) <= radius)
                & (np.abs(sub_dy) <= radius),
            }
            for key, window_mask in masks.items():
                values = window[valid & window_mask]
                counts[key][idx] = len(values)
                if not len(values):
                    continue
                neighborhood_stats[f"{key}_mean"][idx] = float(np.mean(values))
                neighborhood_stats[f"{key}_median"][idx] = float(np.median(values))
                neighborhood_stats[f"{key}_min"][idx] = float(np.min(values))
                neighborhood_stats[f"{key}_max"][idx] = float(np.max(values))

    return sampled, neighborhood_stats, counts


def sample_source_grid_neighborhoods(
    latitudes: np.ndarray,
    longitudes: np.ndarray,
    dem: np.ndarray,
    transform: rasterio.Affine,
) -> tuple[dict[str, np.ndarray], dict[str, np.ndarray]]:
    """Compute neighborhood stats on original DSM pixels, without resampling."""
    counts = {
        f"{shape}_{radius}": np.zeros(len(latitudes), dtype=np.int32)
        for radius in RADII_M
        for shape in ("disk", "square_side", "square_radius")
    }
    stats = {
        f"{shape}_{radius}_{stat}": np.full(len(latitudes), np.nan, dtype=float)
        for radius in RADII_M
        for shape in ("disk", "square_side", "square_radius")
        for stat in ("mean", "median", "min", "max")
    }
    res_lon = abs(transform.a)
    res_lat = abs(transform.e)

    for idx, (lat, lon) in enumerate(zip(latitudes, longitudes)):
        row, col = rasterio.transform.rowcol(transform, lon, lat)
        meters_per_degree_lon = EARTH_RADIUS_M * np.cos(np.deg2rad(lat)) * np.pi / 180.0
        meters_per_degree_lat = EARTH_RADIUS_M * np.pi / 180.0
        half_cols = int(np.ceil(max(RADII_M) / (res_lon * meters_per_degree_lon))) + 2
        half_rows = int(np.ceil(max(RADII_M) / (res_lat * meters_per_degree_lat))) + 2
        r0, r1 = max(0, row - half_rows), min(dem.shape[0], row + half_rows + 1)
        c0, c1 = max(0, col - half_cols), min(dem.shape[1], col + half_cols + 1)
        window = dem[r0:r1, c0:c1]
        if not window.size:
            continue

        rows = np.arange(r0, r1)
        cols = np.arange(c0, c1)
        rr, cc = np.meshgrid(rows, cols, indexing="ij")
        pixel_lons, pixel_lats = rasterio.transform.xy(
            transform, rr.ravel().tolist(), cc.ravel().tolist(), offset="center"
        )
        pixel_lons = np.asarray(pixel_lons, dtype=float).reshape(window.shape)
        pixel_lats = np.asarray(pixel_lats, dtype=float).reshape(window.shape)
        east = (pixel_lons - lon) * meters_per_degree_lon
        north = (pixel_lats - lat) * meters_per_degree_lat
        valid = np.isfinite(window)

        for radius in RADII_M:
            masks = {
                f"disk_{radius}": (east**2 + north**2) <= radius**2,
                f"square_side_{radius}": (np.abs(east) <= radius / 2)
                & (np.abs(north) <= radius / 2),
                f"square_radius_{radius}": (np.abs(east) <= radius)
                & (np.abs(north) <= radius),
            }
            for key, mask in masks.items():
                values = window[valid & mask]
                counts[key][idx] = len(values)
                if not len(values):
                    continue
                stats[f"{key}_mean"][idx] = float(np.mean(values))
                stats[f"{key}_median"][idx] = float(np.median(values))
                stats[f"{key}_min"][idx] = float(np.min(values))
                stats[f"{key}_max"][idx] = float(np.max(values))

    return stats, counts


def horn_slope_samples(
    latitudes: np.ndarray,
    longitudes: np.ndarray,
    source_dem: np.ndarray,
    source_transform: rasterio.Affine,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Horn and central-difference slopes with local geographic metre spacing."""
    horn_result = np.full(len(latitudes), np.nan, dtype=float)
    central_result = np.full(len(latitudes), np.nan, dtype=float)
    valid_counts = np.zeros(len(latitudes), dtype=np.int8)
    cell_lon_deg = abs(source_transform.a)
    cell_lat_deg = abs(source_transform.e)

    for i, (lat, lon) in enumerate(zip(latitudes, longitudes)):
        row, col = rasterio.transform.rowcol(source_transform, lon, lat)
        if row < 1 or col < 1 or row + 1 >= source_dem.shape[0] or col + 1 >= source_dem.shape[1]:
            continue
        patch = source_dem[row - 1:row + 2, col - 1:col + 2].astype(np.float64)
        if not np.isfinite(patch).all():
            continue
        # Local east-west and north-south grid spacing in metres. This accounts
        # for longitude convergence at the sample latitude.
        lat_rad = np.deg2rad(lat)
        dx = EARTH_RADIUS_M * np.cos(lat_rad) * np.deg2rad(cell_lon_deg)
        dy = EARTH_RADIUS_M * np.deg2rad(cell_lat_deg)
        dzdx = ((patch[0, 2] + 2 * patch[1, 2] + patch[2, 2])
                - (patch[0, 0] + 2 * patch[1, 0] + patch[2, 0])) / (8 * dx)
        dzdy = ((patch[2, 0] + 2 * patch[2, 1] + patch[2, 2])
                - (patch[0, 0] + 2 * patch[0, 1] + patch[0, 2])) / (8 * dy)
        horn_result[i] = float(np.degrees(np.arctan(np.hypot(dzdx, dzdy))))
        central_dx = (patch[1, 2] - patch[1, 0]) / (2 * dx)
        central_dy = (patch[2, 1] - patch[0, 1]) / (2 * dy)
        central_result[i] = float(np.degrees(np.arctan(np.hypot(central_dx, central_dy))))
        valid_counts[i] = 9
    return horn_result, central_result, valid_counts


def main() -> None:
    frame = pd.read_csv(CSV_PATH)
    needed = ["latitude", "longitude", "elev_m", "rel_elev_250m", "rel_elev_500m",
              "rel_elev_1000m", "depression_depth_250m", "height_above_local_min_250m",
              "slope_deg"]
    missing = sorted(set(needed) - set(frame.columns))
    if missing:
        raise ValueError(f"CSV is missing required columns: {missing}")

    latitudes = pd.to_numeric(frame["latitude"], errors="raise").to_numpy(float)
    longitudes = pd.to_numeric(frame["longitude"], errors="raise").to_numpy(float)
    print(f"CSV: {CSV_PATH.relative_to(ROOT)} ({len(frame)} rows)")
    print("Read-only: all rasters and CSV are opened for reading; no output files are written.")
    print("Candidate comparisons use signed prediction minus stored value errors.")

    direct_elev, tile_names, direct_valid = sample_source_elevation(frame)
    print("\n=== elev_m: direct nearest-pixel samples from source tiles ===")
    compare("Direct DSM sample vs stored elev_m", frame["elev_m"].to_numpy(float), direct_elev)
    print("Direct source tile counts:", {name: int(np.count_nonzero(tile_names == name)) for name in set(tile_names) if name})
    print(f"Rows with valid direct DSM sample: {int(direct_valid.sum())}/{len(frame)}")

    projected_dem, projected_transform, _, source_dem, source_transform = load_mosaic()
    projected_sample, candidates, counts = sample_projected_neighborhoods(
        latitudes, longitudes, projected_dem, projected_transform
    )
    source_grid_candidates, source_grid_counts = sample_source_grid_neighborhoods(
        latitudes, longitudes, source_dem, source_transform
    )
    print("\n=== Elevation alignment after metric reprojection (diagnostic only) ===")
    compare("Projected-grid sample vs stored elev_m", frame["elev_m"].to_numpy(float), projected_sample)
    compare("Projected-grid sample vs direct DSM sample", direct_elev, projected_sample)

    print("\n=== height_above_local_min_250m candidate definitions ===")
    expected = frame["height_above_local_min_250m"].to_numpy(float)
    for shape in ("disk", "square_side", "square_radius"):
        key = f"{shape}_250"
        candidate = direct_elev - source_grid_candidates[f"{key}_min"]
        print(f"Neighborhood: {shape} 250m ({'radius' if shape != 'square_side' else 'side length'})")
        print(f"  Original-grid candidate valid neighborhoods: {int(np.isfinite(candidate).sum())}/{len(frame)}; "
              f"pixel-count range={int(source_grid_counts[key].min())}..{int(source_grid_counts[key].max())}")
        compare(f"sampled elevation - local minimum [{key}] vs height_above_local_min_250m", expected, candidate)
        projected_candidate = direct_elev - candidates[f"{key}_min"]
        compare(f"same candidate on projected/resampled DSM [{key}]", expected, projected_candidate)

    print("\n=== rel_elev_* candidate definitions ===")
    stored_by_radius = {
        250: frame["rel_elev_250m"].to_numpy(float),
        500: frame["rel_elev_500m"].to_numpy(float),
        1000: frame["rel_elev_1000m"].to_numpy(float),
    }
    for radius in RADII_M:
        print(f"Target rel_elev_{radius}m; candidate = direct DSM sample - original-grid neighborhood statistic")
        for shape in ("disk", "square_side", "square_radius"):
            key = f"{shape}_{radius}"
            print(f"  Window {key}; valid original-grid neighborhoods={int(np.isfinite(source_grid_candidates[f'{key}_mean']).sum())}/{len(frame)}; "
                f"pixel-count range={int(source_grid_counts[key].min())}..{int(source_grid_counts[key].max())}")
            for statistic in ("mean", "median", "min"):
                # Use the exact source-grid elevation that matched elev_m,
                # rather than the bilinearly reprojected grid-center value.
                candidate = direct_elev - source_grid_candidates[f"{key}_{statistic}"]
                compare(f"{shape} {radius}m {statistic}: sample - statistic vs rel_elev_{radius}m",
                        stored_by_radius[radius], candidate)

    print("\n=== depression_depth_250m exploratory comparisons ===")
    stored_depression = frame["depression_depth_250m"].to_numpy(float)
    stored_relative = frame["rel_elev_250m"].to_numpy(float)
    proxy = np.maximum(0.0, -stored_relative)
    compare("max(0, -stored rel_elev_250m) vs stored depression_depth_250m [CSV-only identity check]",
            stored_depression, proxy)
    for shape in ("disk", "square_side", "square_radius"):
        key = f"{shape}_250"
        # This is only a crude local-mean low-point proxy, not a hydrologic sink-fill.
        candidate = np.maximum(0.0, source_grid_candidates[f"{key}_mean"] - direct_elev)
        compare(f"max(0, local mean - sampled elevation) [{key}] vs depression_depth_250m",
                stored_depression, candidate)

    print("\n=== slope_deg: 3x3 Horn slope candidates ===")
    # The two tiles share the same 1-arcsecond grid; stitch their affine
    # transform to match the in-memory mosaic used for neighborhood samples.
    with rasterio.open(DEM_PATHS[0]) as first, rasterio.open(DEM_PATHS[1]) as second:
        _, source_transform = merge([first, second], indexes=1, masked=True)
    # merge returns (array, transform); use its transform for correct mosaic indices.
    horn, central, horn_counts = horn_slope_samples(
        latitudes, longitudes, source_dem, source_transform
    )
    print(f"Horn neighborhoods with all 9 valid DSM pixels: {int(np.count_nonzero(horn_counts == 9))}/{len(frame)}")
    compare("3x3 Horn slope on geographic DSM with local metre spacing vs stored slope_deg",
            frame["slope_deg"].to_numpy(float), horn, unit="deg")
    compare("3x3 central-difference slope on geographic DSM with local metre spacing vs stored slope_deg",
            frame["slope_deg"].to_numpy(float), central, unit="deg")

    print("\nInterpretation: exact means absolute error <= 0.001 m for elevation-valued fields; "
          "for slope the same numerical tolerance is in degrees. Candidate windows/formulas "
          "are hypotheses only. No original formula is inferred from plausibility alone.")


if __name__ == "__main__":
    main()
