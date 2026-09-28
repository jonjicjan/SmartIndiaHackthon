"""
ThermalGuard AI - Configuration loader
Reads all runtime settings from .env so nothing is hardcoded.
"""
import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")


def _bbox_tuple(raw: str):
    west, south, east, north = [float(x) for x in raw.split(",")]
    return {"west": west, "south": south, "east": east, "north": north}


STATE_BBOXES = {
    "all_india": "68.0,6.5,97.5,37.5",
    "north_india": "73.0,26.0,81.0,37.5",
    "south_india": "74.0,8.0,84.5,19.5",
    "west_india": "68.1,15.5,77.5,25.0",
    "east_central": "79.0,17.5,89.0,27.5",
    "northeast": "89.5,21.5,97.5,29.5",
    "kutch": "69.55,22.15,70.15,22.65",
    "gujarat": "68.1,20.1,74.5,24.7",
    "maharashtra": "72.6,15.6,80.9,22.1",
    "odisha": "81.3,17.8,87.5,22.6",
    "punjab": "73.9,29.5,76.9,32.5",
}


def get_state_bbox(state: str = None) -> dict:
    if not state or state.lower().strip() in ("all_india", "india"):
        return _bbox_tuple(STATE_BBOXES["all_india"])
    state_key = state.lower().strip()
    if state_key in STATE_BBOXES:
        return _bbox_tuple(STATE_BBOXES[state_key])
    if "," in state:
        return _bbox_tuple(state)
    return _bbox_tuple(STATE_BBOXES["all_india"])


DATA_MODE = os.getenv("DATA_MODE", "live")
FIRMS_MAP_KEY = os.getenv("FIRMS_MAP_KEY")
LIVE_BBOX_RAW = os.getenv("LIVE_BBOX", STATE_BBOXES["all_india"])
LIVE_BBOX = _bbox_tuple(LIVE_BBOX_RAW)
LIVE_FIRMS_DAYS = int(os.getenv("LIVE_FIRMS_DAYS", 2))

HOTSPOT_CLUSTER_RADIUS_METERS = float(os.getenv("HOTSPOT_CLUSTER_RADIUS_METERS", 500))
INDUSTRIAL_THRESHOLD = float(os.getenv("INDUSTRIAL_THRESHOLD", 0.60))
PERSISTENCE_THRESHOLD = float(os.getenv("PERSISTENCE_THRESHOLD", 0.15))
ANOMALY_THRESHOLD = float(os.getenv("ANOMALY_THRESHOLD", 3.0))

FRONTEND_URL = os.getenv("FRONTEND_URL", "http://localhost:5173")

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")
DATABASE_URL = os.getenv("DATABASE_URL")

EARTHDATA_TOKEN = os.getenv("EARTHDATA_TOKEN")

# FIRMS satellite sources to merge - covers the "NOAA-20/21 VIIRS" requirement
# from the problem statement. MODIS_NRT can be added for wider historical coverage.
FIRMS_SOURCES = ["VIIRS_NOAA20_NRT", "VIIRS_NOAA21_NRT"]

# CFSA composite scoring weights (must sum to 1.0)
CFSA_WEIGHTS = {
    "proximity": 0.30,
    "landcover": 0.20,
    "recurrence": 0.15,
    "anomaly": 0.15,
    "temporal_signature": 0.20,
}

# Degrees-per-meter approximation for building the location grid used to group
# repeat detections into the same "site" for baseline/history calculations.
METERS_PER_DEGREE = 111_320
GRID_CELL_DEGREES = HOTSPOT_CLUSTER_RADIUS_METERS / METERS_PER_DEGREE
