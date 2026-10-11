"""Train a conservative, time-aware baseline for Delhi JalAlert.

This script is independent of the legacy model artifacts. It evaluates on the
CSV's later, held-out period and uses spatial GroupKFold within the training
period for model selection. It does not export ONNX or write to backend/model.

Example (from the project root):
    python -m pip install -r ml/requirements.txt
    python ml/train_baseline.py

Outputs go to ml/outputs/ unless --out is provided. Existing files in the
output directory are replaced only when the script is explicitly run.
"""

from __future__ import annotations

import argparse
import json
import platform
from pathlib import Path
from typing import Any

import joblib
import numpy as np
import pandas as pd
import sklearn
from sklearn.base import clone
from sklearn.ensemble import ExtraTreesClassifier, RandomForestClassifier
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    accuracy_score,
    average_precision_score,
    confusion_matrix,
    f1_score,
    precision_score,
    recall_score,
    roc_auc_score,
)
from sklearn.model_selection import GroupKFold
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

SEED = 42
TARGET = "waterlogging"
TRAIN_SPLIT = "train"
TEST_SPLIT = "test"
GROUP_COLUMN = "spatial_fold"

STATIC_FEATURES = [
    "elev_m",
    "rel_elev_250m",
    "rel_elev_500m",
    "rel_elev_1000m",
    "depression_depth_250m",
    "height_above_local_min_250m",
    "slope_deg",
    "dist_river_m",
    "dist_canal_m",
    "dist_drain_m",
    "dist_waterbody_m",
    "dist_any_water_m",
    "dist_tunnel_m",
    "tunnel_flag_50m",
    "dist_underpass_m",
    "underpass_flag_50m",
]
FEATURES = STATIC_FEATURES + ["event_month_sin", "event_month_cos"]
REQUIRED_COLUMNS = {
    TARGET,
    "event_date",
    "split",
    GROUP_COLUMN,
    *STATIC_FEATURES,
}


def parse_args() -> argparse.Namespace:
    project_root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--data",
        type=Path,
        default=project_root / "data" / "model_table_geo.csv",
        help="CSV dataset (default: data/model_table_geo.csv)",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=Path(__file__).resolve().parent / "outputs",
        help="Output directory (default: ml/outputs)",
    )
    return parser.parse_args()


def load_and_validate(path: Path) -> pd.DataFrame:
    if not path.is_file():
        raise FileNotFoundError(f"Dataset does not exist: {path}")

    df = pd.read_csv(path)
    missing_columns = sorted(REQUIRED_COLUMNS - set(df.columns))
    if missing_columns:
        raise ValueError(f"Dataset is missing required columns: {missing_columns}")
    if df.empty:
        raise ValueError("Dataset has no rows.")
    if df[TARGET].isna().any():
        raise ValueError(f"{TARGET} contains missing values.")
    observed_labels = set(pd.to_numeric(df[TARGET], errors="raise").unique())
    if not observed_labels <= {0, 1}:
        raise ValueError(f"Expected binary {TARGET} values 0/1; found {observed_labels}.")

    df = df.copy()
    df[TARGET] = pd.to_numeric(df[TARGET], errors="raise").astype("int8")
    df["event_date"] = pd.to_datetime(df["event_date"], errors="raise").dt.normalize()
    if df["event_date"].isna().any():
        raise ValueError("event_date contains missing values.")

    split_values = set(df["split"].dropna().astype(str))
    if split_values != {TRAIN_SPLIT, TEST_SPLIT} or df["split"].isna().any():
        raise ValueError(
            f"Expected exactly split labels {TRAIN_SPLIT!r} and {TEST_SPLIT!r}; "
            f"found {sorted(split_values)}."
        )
    train_dates = df.loc[df["split"] == TRAIN_SPLIT, "event_date"]
    test_dates = df.loc[df["split"] == TEST_SPLIT, "event_date"]
    if train_dates.empty or test_dates.empty:
        raise ValueError("Both temporal train and test splits must contain rows.")
    if train_dates.max() >= test_dates.min():
        raise ValueError(
            "The supplied split is not strictly time-ordered: the latest train "
            "date must precede the earliest test date."
        )
    if df[GROUP_COLUMN].isna().any():
        raise ValueError(f"{GROUP_COLUMN} contains missing group labels.")

    for column in STATIC_FEATURES:
        df[column] = pd.to_numeric(df[column], errors="raise")
        if not np.isfinite(df[column].dropna().to_numpy(dtype=float)).all():
            raise ValueError(f"{column} contains infinite values.")

    df["event_month_sin"] = np.sin(2 * np.pi * df["event_date"].dt.month / 12.0)
    df["event_month_cos"] = np.cos(2 * np.pi * df["event_date"].dt.month / 12.0)
    return df


def make_candidates() -> dict[str, Pipeline]:
    return {
        "logistic_regression": Pipeline(
            [
                ("imputer", SimpleImputer(strategy="median")),
                ("scaler", StandardScaler()),
                (
                    "classifier",
                    LogisticRegression(
                        class_weight="balanced",
                        max_iter=3000,
                        random_state=SEED,
                    ),
                ),
            ]
        ),
        "random_forest": Pipeline(
            [
                ("imputer", SimpleImputer(strategy="median")),
                (
                    "classifier",
                    RandomForestClassifier(
                        n_estimators=300,
                        min_samples_leaf=3,
                        max_features="sqrt",
                        class_weight="balanced_subsample",
                        n_jobs=-1,
                        random_state=SEED,
                    ),
                ),
            ]
        ),
        "extra_trees": Pipeline(
            [
                ("imputer", SimpleImputer(strategy="median")),
                (
                    "classifier",
                    ExtraTreesClassifier(
                        n_estimators=300,
                        min_samples_leaf=3,
                        max_features="sqrt",
                        class_weight="balanced",
                        n_jobs=-1,
                        random_state=SEED,
                    ),
                ),
            ]
        ),
    }


def spatial_cv_scores(
    estimator: Pipeline,
    x: pd.DataFrame,
    y: np.ndarray,
    groups: np.ndarray,
    n_splits: int,
) -> list[float]:
    splitter = GroupKFold(n_splits=n_splits)
    fold_scores: list[float] = []
    for train_indices, validation_indices in splitter.split(x, y, groups):
        if np.unique(y[train_indices]).size != 2:
            raise ValueError(
                "A spatial training fold contains only one target class; "
                "model fitting is not valid."
            )
        y_validation = y[validation_indices]
        if np.unique(y_validation).size != 2:
            raise ValueError(
                "A spatial validation fold contains only one target class; "
                "average precision cannot be compared reliably."
            )
        fold_model = clone(estimator)
        fold_model.fit(x.iloc[train_indices], y[train_indices])
        probability = fold_model.predict_proba(x.iloc[validation_indices])[:, 1]
        fold_scores.append(float(average_precision_score(y_validation, probability)))
    return fold_scores


def evaluate_test(y_true: np.ndarray, probability: np.ndarray) -> dict[str, Any]:
    predicted = (probability >= 0.5).astype("int8")
    tn, fp, fn, tp = confusion_matrix(y_true, predicted, labels=[0, 1]).ravel()
    return {
        "rows": int(len(y_true)),
        "positive_rate": float(y_true.mean()),
        "average_precision": float(average_precision_score(y_true, probability)),
        "roc_auc": float(roc_auc_score(y_true, probability)),
        "fixed_0_5_threshold": {
            "not_tuned_or_recommended": True,
            "accuracy": float(accuracy_score(y_true, predicted)),
            "precision": float(precision_score(y_true, predicted, zero_division=0)),
            "recall": float(recall_score(y_true, predicted, zero_division=0)),
            "f1": float(f1_score(y_true, predicted, zero_division=0)),
            "confusion_matrix_tn_fp_fn_tp": [int(tn), int(fp), int(fn), int(tp)],
        },
    }


def train(args: argparse.Namespace) -> dict[str, Any]:
    df = load_and_validate(args.data)
    train_rows = df.loc[df["split"] == TRAIN_SPLIT].copy()
    test_rows = df.loc[df["split"] == TEST_SPLIT].copy()

    x_train = train_rows[FEATURES]
    y_train = train_rows[TARGET].to_numpy(dtype="int8")
    x_test = test_rows[FEATURES]
    y_test = test_rows[TARGET].to_numpy(dtype="int8")
    groups = train_rows[GROUP_COLUMN].to_numpy()
    group_count = pd.Series(groups).nunique()
    n_splits = min(5, int(group_count))
    if n_splits < 2:
        raise ValueError("At least two distinct training spatial folds are required.")

    candidates = make_candidates()
    cv_results: dict[str, dict[str, Any]] = {}
    for name, estimator in candidates.items():
        scores = spatial_cv_scores(estimator, x_train, y_train, groups, n_splits)
        cv_results[name] = {
            "fold_average_precision": scores,
            "mean_average_precision": float(np.mean(scores)),
            "std_average_precision": float(np.std(scores, ddof=0)),
        }
        print(
            f"{name}: spatial CV average precision "
            f"{np.mean(scores):.4f} +/- {np.std(scores, ddof=0):.4f}"
        )

    best_name = max(
        cv_results,
        key=lambda name: cv_results[name]["mean_average_precision"],
    )
    best_model = clone(candidates[best_name]).fit(x_train, y_train)
    test_probability = best_model.predict_proba(x_test)[:, 1]
    test_metrics = evaluate_test(y_test, test_probability)

    # Output is deliberately separate from backend/model. The manifest captures
    # the exact ordered predictors used to fit this baseline.
    args.out.mkdir(parents=True, exist_ok=True)
    bundle_path = args.out / "baseline_model.joblib"
    manifest_path = args.out / "feature_manifest.json"
    metrics_path = args.out / "evaluation.json"
    bundle = {
        "model": best_model,
        "model_name": best_name,
        "features": FEATURES,
        "target": TARGET,
        "positive_class": 1,
        "probability_calibrated": False,
        "training_csv": str(args.data.resolve()),
        "training_script_version": 1,
    }
    manifest = {
        "model_name": best_name,
        "target": TARGET,
        "positive_class": 1,
        "ordered_features": FEATURES,
        "excluded_history_features": [
            "hist_reports_150m",
            "hist_distinct_dates_150m",
        ],
        "excluded_target_derived_features": ["low_rain_positive"],
        "excluded_metadata": [
            "row_id",
            "loc_id",
            "block_id",
            "latitude",
            "longitude",
            "split",
            "spatial_fold",
            "event_date",
            "year",
            "month",
            "is_monsoon",
            "elev_missing",
            "rainfall_mm",
        ],
        "probability_calibrated": False,
    }
    metrics = {
        "python_version": platform.python_version(),
        "python_packages": {
            "numpy": np.__version__,
            "pandas": pd.__version__,
            "scikit_learn": sklearn.__version__,
            "joblib": joblib.__version__,
        },
        "seed": SEED,
        "training_rows": int(len(train_rows)),
        "test_rows": int(len(test_rows)),
        "training_date_range": [
            str(train_rows["event_date"].min().date()),
            str(train_rows["event_date"].max().date()),
        ],
        "test_date_range": [
            str(test_rows["event_date"].min().date()),
            str(test_rows["event_date"].max().date()),
        ],
        "cross_validation": {
            "method": "GroupKFold on training rows, grouped by spatial_fold",
            "n_splits": n_splits,
            "model_selection_metric": "mean fold average precision",
            "geographic_independence_note": (
                "Spatial grouping applies only to training-period CV. The later "
                "test period contains the same spatial_fold labels as training."
            ),
            "candidates": cv_results,
        },
        "selected_model": best_name,
        "temporal_test": test_metrics,
        "interpretation_note": (
            "Scores are not calibrated probabilities, an operational threshold "
            "was not selected, and risk is not a safety guarantee."
        ),
    }

    joblib.dump(bundle, bundle_path)
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    metrics_path.write_text(json.dumps(metrics, indent=2) + "\n", encoding="utf-8")
    print(f"Selected by training-only spatial CV: {best_name}")
    print(f"Temporal test average precision: {test_metrics['average_precision']:.4f}")
    print(f"Saved new baseline outputs under: {args.out.resolve()}")
    return metrics


def main() -> None:
    args = parse_args()
    train(args)


if __name__ == "__main__":
    main()
