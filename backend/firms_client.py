"""
Stage 0 - Real-Time Ingestion
Pulls live VIIRS hotspot detections from the NASA FIRMS Area API for the
configured bounding box and merges multiple satellite sources.

FIRMS Area API reference:
https://firms.modaps.eosdis.nasa.gov/api/area/csv/[MAP_KEY]/[SOURCE]/[AREA]/[DAY_RANGE]
"""
import io
import requests
import pandas as pd
import config

FIRMS_BASE_URL = "https://firms.modaps.eosdis.nasa.gov/api/area/csv"


def _area_string(bbox: dict = None) -> str:
    b = bbox or config.LIVE_BBOX
    return f"{b['west']},{b['south']},{b['east']},{b['north']}"


def fetch_source(source: str, days: int = None, bbox: dict = None) -> pd.DataFrame:
    """Fetch one FIRMS satellite source for the configured bbox and day range."""
    days = days or config.LIVE_FIRMS_DAYS
    url = f"{FIRMS_BASE_URL}/{config.FIRMS_MAP_KEY}/{source}/{_area_string(bbox)}/{days}"
    resp = requests.get(url, timeout=30)
    resp.raise_for_status()

    text = resp.text.strip()
    if not text or text.lower().startswith("invalid") or "Error" in text[:50]:
        raise RuntimeError(f"FIRMS API error for source {source}: {text[:200]}")

    df = pd.read_csv(io.StringIO(text))
    if df.empty:
        return df

    df["source_satellite"] = source
    return df


def fetch_all_sources(days: int = None, bbox: dict = None) -> pd.DataFrame:
    """Fetch and merge all configured FIRMS sources, deduplicated."""
    frames = []
    for source in config.FIRMS_SOURCES:
        try:
            df = fetch_source(source, days, bbox=bbox)
            if not df.empty:
                frames.append(df)
        except Exception as exc:
            print(f"[firms_client] WARNING: could not fetch {source}: {exc}")

    if not frames:
        return pd.DataFrame()

    merged = pd.concat(frames, ignore_index=True)

    # Normalise column names across VIIRS/MODIS variants
    merged = merged.rename(columns={"bright_t31": "bright_ti5"})
    required_cols = [
        "latitude", "longitude", "bright_ti4", "bright_ti5", "frp",
        "confidence", "acq_date", "acq_time", "satellite", "instrument",
        "daynight", "scan", "track",
    ]
    for col in required_cols:
        if col not in merged.columns:
            merged[col] = None

    merged["acq_datetime"] = pd.to_datetime(
        merged["acq_date"].astype(str) + " " +
        merged["acq_time"].astype(str).str.zfill(4),
        format="%Y-%m-%d %H%M",
        errors="coerce",
    )

    # Multi-satellite confirmation count: how many distinct satellites saw
    # a near-identical location on the same acquisition date.
    merged["confirmation_score"] = merged.groupby(
        [merged["latitude"].round(3), merged["longitude"].round(3), "acq_date"]
    )["satellite"].transform("nunique")

    return merged.drop_duplicates(
        subset=["latitude", "longitude", "acq_date", "acq_time", "satellite"]
    ).reset_index(drop=True)


if __name__ == "__main__":
    data = fetch_all_sources()
    print(f"Fetched {len(data)} live hotspot detections for bbox {_area_string()}")
    if not data.empty:
        print(data[["latitude", "longitude", "frp", "confidence", "acq_date", "satellite"]].head())
