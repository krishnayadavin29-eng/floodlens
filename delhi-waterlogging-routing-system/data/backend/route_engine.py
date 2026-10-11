
import pickle
from pathlib import Path

import networkx as nx
import numpy as np
from scipy.spatial import cKDTree

PROJECT_ROOT = Path(__file__).resolve().parents[1]
GRAPH_PATH = (
    PROJECT_ROOT
    / "data"
    / "processed"
    / "delhi_road_graph_meters.pkl"
)


class RouteEngine:
    def __init__(self):
        if not GRAPH_PATH.exists():
            raise FileNotFoundError(
                f"Road graph not found: {GRAPH_PATH}"
            )

        with GRAPH_PATH.open("rb") as f:
            self.graph = pickle.load(f)

        self.nodes = list(self.graph.nodes)
        self.coordinates = np.asarray(self.nodes, dtype=float)
        self.tree = cKDTree(self.coordinates)

    def nearest_node(self, latitude: float, longitude: float):
        _, index = self.tree.query([longitude, latitude])
        return self.nodes[int(index)]

    def find_route(
        self,
        start_lat: float,
        start_lon: float,
        end_lat: float,
        end_lon: float,
    ):
        source = self.nearest_node(start_lat, start_lon)
        target = self.nearest_node(end_lat, end_lon)

        try:
            path = nx.shortest_path(
                self.graph,
                source=source,
                target=target,
                weight="weight",
            )

            distance_m = nx.shortest_path_length(
                self.graph,
                source=source,
                target=target,
                weight="weight",
            )

        except nx.NetworkXNoPath:
            raise ValueError(
                "No road route connects these locations."
            ) from None

        return {
            "coordinates": [
                [float(lon), float(lat)]
                for lon, lat in path
            ],
            "distance_m": round(float(distance_m), 1),
            "distance_km": round(float(distance_m) / 1000, 2),
            "nodes_in_route": len(path),
        }
