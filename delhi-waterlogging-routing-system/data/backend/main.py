"""Minimal Delhi JalAlert API with a test-only saved-model endpoint."""
from route_engine import RouteEngine
import json
import math
from pathlib import Path
from typing import Any
import joblib
import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, field_validator

app = FastAPI(title="Delhi JalAlert API")

# Resolve artifacts from this file's location, not from the shell's working directory.
PROJECT_ROOT = Path(__file__).resolve().parents[1]
MODEL_PATH = PROJECT_ROOT / "ml" / "outputs" / "baseline_model.joblib"
MANIFEST_PATH = PROJECT_ROOT / "ml" / "outputs" / "feature_manifest.json"

model: Any | None = None
feature_names: list[str] = []
model_load_error: str | None = None

try:
	with MANIFEST_PATH.open(encoding="utf-8") as manifest_file:
		manifest = json.load(manifest_file)
	with MODEL_PATH.open("rb") as model_file:
		bundle = joblib.load(model_file)

	if not isinstance(bundle, dict):
		raise TypeError("Model bundle must be a dictionary")
	if not isinstance(bundle.get("features"), list):
		raise ValueError("Model bundle does not contain an ordered feature list")
	feature_names = bundle["features"]
	if feature_names != manifest.get("ordered_features"):
		raise ValueError("Model feature order does not match the feature manifest")
	model = bundle.get("model")
	if model is None or not hasattr(model, "predict_proba"):
		raise TypeError("Model bundle does not contain a predict_proba estimator")
	model_feature_names = list(getattr(model, "feature_names_in_", []))
	if model_feature_names and feature_names != model_feature_names:
		raise ValueError("Model feature order does not match the fitted estimator")
except Exception as exc:
	# Keep the API process and /health available if artifacts are unavailable.
	model = None
	feature_names = []
	model_load_error = type(exc).__name__


class PredictRequest(BaseModel):
	"""Verified model inputs for an offline/test prediction only."""

	model_config = ConfigDict(extra="forbid")

	elev_m: float
	rel_elev_250m: float
	rel_elev_500m: float
	rel_elev_1000m: float
	depression_depth_250m: float
	height_above_local_min_250m: float
	slope_deg: float
	dist_river_m: float
	dist_canal_m: float
	dist_drain_m: float
	dist_waterbody_m: float
	dist_any_water_m: float
	dist_tunnel_m: float
	tunnel_flag_50m: float
	dist_underpass_m: float
	underpass_flag_50m: float
	event_month_sin: float
	event_month_cos: float

	@field_validator("*", mode="before")
	@classmethod
	def require_finite_json_number(cls, value: Any) -> float:
		if type(value) not in (int, float):
			raise ValueError("Each feature must be supplied as a JSON number")
		if not math.isfinite(value):
			raise ValueError("Each feature must be finite")
		return float(value)
	
class RouteRequest(BaseModel):
    start_lat: float
    start_lon: float
    end_lat: float
    end_lon: float


route_engine = None
route_engine_error = None

try:
    route_engine = RouteEngine()
except Exception as exc:
    route_engine_error = str(exc)


@app.post("/route")
def calculate_route(request: RouteRequest) -> dict[str, Any]:
    if route_engine is None:
        raise HTTPException(
            status_code=503,
            detail=f"Route engine unavailable: {route_engine_error}",
        )

    coords = [
        request.start_lat,
        request.start_lon,
        request.end_lat,
        request.end_lon,
    ]

    if not all(math.isfinite(v) for v in coords):
        raise HTTPException(
            status_code=422,
            detail="Coordinates must be finite numbers.",
        )

    if (
        not -90 <= request.start_lat <= 90
        or not -90 <= request.end_lat <= 90
        or not -180 <= request.start_lon <= 180
        or not -180 <= request.end_lon <= 180
    ):
        raise HTTPException(
            status_code=422,
            detail="Coordinates are outside valid latitude/longitude ranges.",
        )

    try:
        return route_engine.find_route(
            request.start_lat,
            request.start_lon,
            request.end_lat,
            request.end_lon,
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc




# The frontend README documents Python's local static server at localhost:5500.
# Include both loopback hostnames because browsers treat them as distinct origins.
app.add_middleware(
	CORSMiddleware,
	allow_origins=[
		"http://localhost:5500",
		"http://127.0.0.1:5500",
	],
	allow_methods=["GET", "POST"],
	allow_headers=["*"],
)


@app.get("/health")
def health() -> dict[str, Any]:
	"""Report API availability separately from model and live-data readiness."""
	return {
		"status": "ok",
		"model_ready": model is not None,
		"model_load_error": model_load_error,
		"test_feature_prediction_ready": model is not None,
		"live_coordinate_prediction_ready": False,
		"route_risk_ready": False,
		"hotspots_ready": False,
		"reports_ready": False,
		"limitations": [
			"The model endpoint accepts verified feature values only.",
			"Feature generation for arbitrary coordinates is not implemented and validated.",
			"Live route risk, hotspot and report APIs are not implemented.",
		],
	}


@app.get("/capabilities")
def capabilities() -> dict[str, Any]:
	"""Machine-readable API capabilities; unavailable features are explicit."""
	return {
		"api": True,
		"saved_model_loaded": model is not None,
		"test_prediction_from_features": model is not None,
		"live_coordinate_prediction": False,
		"live_route_risk": False,
		"live_hotspots": False,
		"live_reports": False,
		"weather_proxy": False,
		"risk_score_calibrated": False,
	}


@app.post("/route-risk", status_code=501)
def route_risk_unavailable(payload: dict[str, Any]) -> None:
	"""Explicitly reject live route scoring until verified features exist."""
	raise HTTPException(
		status_code=501,
		detail=(
			"Live route-risk assessment is not available yet. The app cannot "
			"reliably generate all model features along route geometry. Routes "
			"may be displayed, but risk must remain unknown."
		),
	)


@app.get("/hotspots", status_code=501)
def hotspots_unavailable() -> None:
	"""Do not imply that sample hotspots are live reports."""
	raise HTTPException(
		status_code=501,
		detail="Live hotspot data is not connected. Demo hotspots are illustrative only.",
	)


@app.get("/reports", status_code=501)
def reports_unavailable() -> None:
	"""Do not imply that live incident reports are connected."""
	raise HTTPException(
		status_code=501,
		detail="Live incident reports are not connected. Demo reports are illustrative only.",
	)


@app.post(
	"/predict",
	summary="Test-only prediction from explicitly supplied model features",
	 description=(
		"Accepts all 18 verified feature values explicitly. This endpoint is for "
		"testing with trusted feature values only. It does not derive features from "
		"latitude/longitude and is not for live navigation or safety advice. The "
		"returned class-1 score is uncalibrated."
	),
)
def predict(request: PredictRequest) -> dict[str, Any]:
	"""Run the saved estimator on one complete, explicitly supplied feature row."""
	if model is None:
		raise HTTPException(status_code=503, detail="The saved model is not ready")

	values = request.model_dump()
	# Select by the loaded bundle's exact ordered feature list.
	row = pd.DataFrame([[values[name] for name in feature_names]], columns=feature_names)
	try:
		class_scores = model.predict_proba(row)[0]
		classes = list(model.classes_)
		if 1 not in classes:
			raise ValueError("The loaded classifier has no positive class 1")
		predicted_class = int(classes[int(np.argmax(class_scores))])
		positive_score = float(class_scores[classes.index(1)])
	except Exception as exc:
		raise HTTPException(status_code=500, detail="The model could not score these feature values") from exc

	return {
		"predicted_class": predicted_class,
		"raw_class_1_score": positive_score,
		"score_calibrated": False,
		"data_status": "test_only",
		"warning": "Uncalibrated model score; not a reliable real-world probability or safety advice.",
	}
