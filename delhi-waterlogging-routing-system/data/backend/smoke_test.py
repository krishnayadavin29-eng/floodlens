"""Local integration smoke test for Delhi JalAlert.

Run from the project root with the backend environment:
    backend/.venv/bin/python backend/smoke_test.py

Starts a temporary server on 127.0.0.1:8019 and shuts it down afterward.
"""
from __future__ import annotations

import json
import math
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
BASE = "http://127.0.0.1:8019"
FEATURES = [
    "elev_m", "rel_elev_250m", "rel_elev_500m", "rel_elev_1000m",
    "depression_depth_250m", "height_above_local_min_250m", "slope_deg",
    "dist_river_m", "dist_canal_m", "dist_drain_m", "dist_waterbody_m",
    "dist_any_water_m", "dist_tunnel_m", "tunnel_flag_50m",
    "dist_underpass_m", "underpass_flag_50m",
]


def request(path: str, payload: dict | None = None) -> tuple[int, dict]:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": "application/json"} if data is not None else {}
    req = urllib.request.Request(BASE + path, data=data, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=3) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8")
        try:
            parsed = json.loads(body)
        except json.JSONDecodeError:
            parsed = {"raw": body}
        return exc.code, parsed


def main() -> int:
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "main:app", "--app-dir", str(ROOT / "backend"),
         "--host", "127.0.0.1", "--port", "8019"],
        cwd=ROOT,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        for _ in range(60):
            if proc.poll() is not None:
                raise RuntimeError("Uvicorn exited before the smoke test could connect.")
            try:
                status, health = request("/health")
                if status == 200:
                    break
            except Exception:
                time.sleep(0.25)
        else:
            raise RuntimeError("Backend did not become ready on port 8019.")

        assert health.get("status") == "ok", health
        assert health.get("model_ready") is True, health
        assert health.get("live_coordinate_prediction_ready") is False, health
        print("PASS GET /health: API reachable; saved model loaded; live prediction correctly marked unavailable")

        status, caps = request("/capabilities")
        assert status == 200 and caps.get("test_prediction_from_features") is True, caps
        assert caps.get("live_route_risk") is False, caps
        print("PASS GET /capabilities: available and unavailable capabilities are explicit")

        df = pd.read_csv(ROOT / "data" / "model_table_geo.csv", nrows=1)
        row = df.iloc[0]
        month = pd.to_datetime(row["event_date"]).month
        payload = {name: float(row[name]) for name in FEATURES}
        payload["event_month_sin"] = math.sin(2 * math.pi * month / 12.0)
        payload["event_month_cos"] = math.cos(2 * math.pi * month / 12.0)
        status, result = request("/predict", payload)
        assert status == 200, (status, result)
        assert result.get("score_calibrated") is False, result
        assert result.get("data_status") == "test_only", result
        print(f"PASS POST /predict: existing dataset row scored; class={result['predicted_class']}; raw class-1 score={result['raw_class_1_score']:.6f}; uncalibrated")

        status, invalid = request("/predict", {})
        assert status == 422, (status, invalid)
        print("PASS POST /predict with missing features: HTTP 422")

        status, route = request("/route-risk", {"origin": {}, "destination": {}, "routes": []})
        assert status == 501 and "not available" in route.get("detail", "").lower(), (status, route)
        print("PASS POST /route-risk: HTTP 501 with explicit explanation; no fabricated route scores")

        status, _ = request("/hotspots")
        assert status == 501, status
        status, _ = request("/reports")
        assert status == 501, status
        print("PASS GET /hotspots and /reports: explicitly unavailable, not fake live data")
        print("All smoke tests passed.")
        return 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)


if __name__ == "__main__":
    raise SystemExit(main())
