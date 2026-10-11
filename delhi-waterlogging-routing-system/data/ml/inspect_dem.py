"""Read-only inspection and CSV point-sampling for the project DSM tiles.

Run from the project root with the project environment:
    ./.venv/bin/python ml/inspect_dem.py

The script opens raster/CSV inputs only for reading. It does not write or
replace any project data or model files. CSV coordinates are explicitly read
as latitude/longitude, then passed to rasterio in (longitude, latitude) order.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import rasterio
from rasterio.warp import transform


PROJECT_ROOT = Path(__file__).resolve().parents[1]
CSV_PATH = PROJECT_ROOT / "data" / "model_table_geo.csv"
RASTER_PATHS = [
    PROJECT_ROOT / "data" / "dem" / "Copernicus_DSM_COG_10_N28_00_E076_00_DEM.tif",
    PROJECT_ROOT / "data" / "dem" / "Copernicus_DSM_COG_10_N28_00_E077_00_DEM.tif",
]
LATITUDE_COLUMN = "latitude"
LONGITUDE_COLUMN = "longitude"


def format_number(value: float | None) -> str:
    return "unavailable" if value is None else f"{value:.6g}"


def print_statistics(label: str, values: list[float]) -> None:
    if not values:
        print(f"  {label}: no valid elevation samples")
        return

    data = np.asarray(values, dtype=np.float64)
    print(f"  {label} (n={data.size}):")
    print(f"    min={np.min(data):.6g}, max={np.max(data):.6g}")
    print(
        f"    mean={np.mean(data):.6g}, median={np.median(data):.6g}, "
        f"std={np.std(data):.6g}"
    )
    print(
        f"    p05={np.percentile(data, 5):.6g}, "
        f"p95={np.percentile(data, 95):.6g}"
    )
    print(
        f"    zero-valued={int(np.count_nonzero(data == 0))}, "
        f"negative-valued={int(np.count_nonzero(data < 0))} "
        "(flagged for review, not assumed invalid)"
    )


def raster_statistics(src: rasterio.io.DatasetReader) -> dict[str, Any] | None:
    """Read GDAL band statistics; this does not write statistics into the TIFF."""
    try:
        stats = src.stats(indexes=1, approx=False)[0]
    except Exception as exc:  # metadata may be missing or unsupported
        print(f"  Stored/computed band statistics unavailable: {type(exc).__name__}: {exc}")
        return None

    if stats is None:
        print("  Stored/computed band statistics unavailable.")
        return None

    result = {
        "minimum": stats.min,
        "maximum": stats.max,
        "mean": stats.mean,
        "std": stats.std,
    }
    print(
        "  Band statistics (GDAL; calculated from raster if not already stored): "
        f"min={format_number(stats.min)}, max={format_number(stats.max)}, "
        f"mean={format_number(stats.mean)}, std={format_number(stats.std)}"
    )
    return result


def invalid_category_counts() -> dict[str, int]:
    return {
        "valid": 0,
        "nodata_or_masked": 0,
        "nonfinite": 0,
        "out_of_bounds": 0,
        "invalid_coordinate": 0,
    }


def inspect_one_raster(
    path: Path,
    latitudes: np.ndarray,
    longitudes: np.ndarray,
    coordinate_valid: np.ndarray,
) -> dict[str, Any]:
    """Inspect metadata and sample every valid CSV coordinate in one raster."""
    with rasterio.open(path, "r") as src:
        if src.crs is None:
            raise ValueError(f"Raster has no CRS; cannot transform CSV points: {path}")

        print(f"\nFILE: {path.relative_to(PROJECT_ROOT)}")
        print(f"  CRS: {src.crs}")
        print(f"  Bounds: {src.bounds}")
        print(f"  Dimensions (width x height): {src.width} x {src.height}")
        print(
            "  Pixel size (native CRS units): "
            f"x={abs(src.transform.a):.12g}, y={abs(src.transform.e):.12g}"
        )
        print(f"  Band 1 data type: {src.dtypes[0]}")
        print(f"  Nodata value: {src.nodata!r}")
        print(f"  Band 1 units: {src.units[0] if src.units else 'not specified'}")
        band_stats = raster_statistics(src)

        n_rows = len(latitudes)
        statuses = ["invalid_coordinate"] * n_rows
        sampled_values: list[float | None] = [None] * n_rows
        counts = invalid_category_counts()
        counts["invalid_coordinate"] = int((~coordinate_valid).sum())

        valid_rows = np.flatnonzero(coordinate_valid)
        if valid_rows.size:
            # CSV fields are latitude/longitude, but raster coordinate APIs
            # require x/y, which here means longitude/latitude.
            xs, ys = transform(
                "EPSG:4326",
                src.crs,
                longitudes[valid_rows].tolist(),
                latitudes[valid_rows].tolist(),
            )
            bounds = src.bounds
            inside_rows: list[int] = []
            inside_coords: list[tuple[float, float]] = []

            for row_index, x, y in zip(valid_rows, xs, ys):
                # Raster bounds are treated as left/top inclusive and
                # right/bottom exclusive, matching pixel-grid indexing.
                if bounds.left <= x < bounds.right and bounds.bottom < y <= bounds.top:
                    inside_rows.append(int(row_index))
                    inside_coords.append((float(x), float(y)))
                else:
                    statuses[row_index] = "out_of_bounds"
                    counts["out_of_bounds"] += 1

            # Important order: sample (longitude, latitude) in raster CRS.
            for row_index, sample in zip(
                inside_rows,
                src.sample(inside_coords, indexes=1, masked=True),
            ):
                value = sample[0]
                if np.ma.is_masked(value):
                    statuses[row_index] = "nodata_or_masked"
                    counts["nodata_or_masked"] += 1
                    continue

                elevation = float(value)
                if not np.isfinite(elevation):
                    statuses[row_index] = "nonfinite"
                    counts["nonfinite"] += 1
                    continue

                if src.nodata is not None:
                    nodata = float(src.nodata)
                    if (np.isnan(nodata) and np.isnan(elevation)) or elevation == nodata:
                        statuses[row_index] = "nodata_or_masked"
                        counts["nodata_or_masked"] += 1
                        continue

                statuses[row_index] = "valid"
                sampled_values[row_index] = elevation
                counts["valid"] += 1

        print(
            "  CSV coordinate outcomes: "
            + ", ".join(f"{key}={value}" for key, value in counts.items())
        )
        valid_values = [value for value in sampled_values if value is not None]
        print_statistics("Valid sampled elevations", valid_values)

        return {
            "path": path,
            "bounds": src.bounds,
            "counts": counts,
            "statuses": statuses,
            "values": sampled_values,
            "valid_values": valid_values,
            "band_statistics": band_stats,
        }


def main() -> None:
    for path in [CSV_PATH, *RASTER_PATHS]:
        if not path.is_file():
            raise FileNotFoundError(f"Required input file not found: {path}")

    print(f"Python rasterio version: {rasterio.__version__}")
    print(f"CSV: {CSV_PATH.relative_to(PROJECT_ROOT)}")
    frame = pd.read_csv(CSV_PATH)
    required = {LATITUDE_COLUMN, LONGITUDE_COLUMN}
    missing = sorted(required - set(frame.columns))
    if missing:
        raise ValueError(f"CSV is missing coordinate columns: {missing}")

    latitudes = pd.to_numeric(frame[LATITUDE_COLUMN], errors="coerce").to_numpy(dtype=float)
    longitudes = pd.to_numeric(frame[LONGITUDE_COLUMN], errors="coerce").to_numpy(dtype=float)
    coordinate_valid = (
        np.isfinite(latitudes)
        & np.isfinite(longitudes)
        & (latitudes >= -90)
        & (latitudes <= 90)
        & (longitudes >= -180)
        & (longitudes <= 180)
    )
    print(f"CSV rows: {len(frame)}")
    print(f"Valid coordinate pairs: {int(coordinate_valid.sum())}")
    print(f"Invalid/missing coordinate pairs: {int((~coordinate_valid).sum())}")
    print("Coordinate mapping: CSV latitude/longitude -> raster x/y = longitude/latitude")

    tile_results = [
        inspect_one_raster(path, latitudes, longitudes, coordinate_valid)
        for path in RASTER_PATHS
    ]

    # Combined means sampling the union of the supplied rasters once per CSV
    # row. If rasters overlap, use a valid value from either tile; if every
    # covering tile reports nodata, classify the coordinate as nodata.
    combined = invalid_category_counts()
    combined["invalid_coordinate"] = int((~coordinate_valid).sum())
    combined_values: list[float] = []
    for row_index in np.flatnonzero(coordinate_valid):
        candidates = [
            result
            for result in tile_results
            if result["statuses"][row_index] != "out_of_bounds"
        ]
        if not candidates:
            combined["out_of_bounds"] += 1
            continue

        available = [
            result["values"][row_index]
            for result in candidates
            if result["statuses"][row_index] == "valid"
        ]
        if available:
            value = float(available[0])
            combined["valid"] += 1
            combined_values.append(value)
        elif any(result["statuses"][row_index] == "nonfinite" for result in candidates):
            combined["nonfinite"] += 1
        else:
            combined["nodata_or_masked"] += 1

    print("\nCOMBINED RASTER COVERAGE (union; each CSV row counted once)")
    print("  Outcomes: " + ", ".join(f"{key}={value}" for key, value in combined.items()))
    print_statistics("Valid combined elevations", combined_values)
    print(
        "  Note: negative and zero values are reported for review, not altered "
        "or automatically treated as invalid. No missing elevations are filled."
    )


if __name__ == "__main__":
    main()
