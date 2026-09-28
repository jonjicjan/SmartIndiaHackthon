"""
ThermalGuard AI - end-to-end pipeline runner.

Run this to execute one full cycle: fetch live FIRMS data -> enrich with
OSM context -> compute temporal signature -> score with CFSA -> classify ->
store in Supabase. Schedule this on a ~3 hour cron to match VIIRS revisit
frequency for continuous real-time monitoring.

Usage:
    cd backend
    python pipeline.py
"""
from datetime import date, datetime, timedelta
import pandas as pd

import config
import firms_client
import osm_enrichment
import db
import temporal_signature as ts
import cfsa_scoring as cfsa
import classifier


def _to_date(val):
    if not val:
        return None
    if isinstance(val, datetime):
        return val.date()
    if isinstance(val, date):
        return val
    try:
        return pd.to_datetime(val).date()
    except Exception:
        return None


def run_pipeline(state: str = None, days: int = None):
    bbox = config.get_state_bbox(state)
    print(f"[{datetime.utcnow().isoformat()}] Starting ThermalGuard AI pipeline run for AOI/State: {state or 'default'} (bbox: {bbox})...", flush=True)

    hotspots = firms_client.fetch_all_sources(days=days, bbox=bbox)
    if hotspots.empty:
        print(f"No live hotspots returned for state/AOI '{state or 'default'}'. Exiting.", flush=True)
        return

    print(f"Fetched {len(hotspots)} raw FIRMS detections.", flush=True)

    processed = 0
    for _, row in hotspots.iterrows():
        lat, lon = float(row["latitude"]), float(row["longitude"])
        loc_key = db.location_key(lat, lon)

        # ---- Stage 1: context enrichment ----
        enrichment = osm_enrichment.enrich_hotspot(lat, lon)

        # ---- Historical lookups for recurrence + anomaly baseline ----
        history = db.fetch_history(loc_key, days=90)
        history_frps = [h["frp"] for h in history if h.get("frp") is not None]
        unique_days = len({_to_date(h["acq_datetime"]) for h in history if h.get("acq_datetime") and _to_date(h["acq_datetime"])})

        acq_date = _to_date(row["acq_date"]) or datetime.utcnow().date()
        recurrence_7d = sum(1 for h in history if _to_date(h.get("acq_datetime")) and
                             (acq_date - _to_date(h["acq_datetime"])).days <= 7)
        recurrence_30d = sum(1 for h in history if _to_date(h.get("acq_datetime")) and
                              (acq_date - _to_date(h["acq_datetime"])).days <= 30)
        recurrence_90d = len(history)

        # ---- Stage 2: temporal signature ----
        current_record = {"latitude": lat, "longitude": lon,
                           "bright_ti4": row.get("bright_ti4"), "bright_ti5": row.get("bright_ti5")}
        nearby_today = int((hotspots["acq_date"] == row["acq_date"]).sum())
        nearby_yesterday = max(1, nearby_today - 1)  # placeholder until 2+ day history accrues
        signature = ts.compute_temporal_signature(history, current_record, nearby_today, nearby_yesterday)

        # ---- Stage 3: CFSA composite scoring ----
        prox = cfsa.proximity_score(enrichment.get("facility_distance_m"))
        land = cfsa.landcover_score(enrichment["built_pct"], enrichment["crop_pct"], enrichment["tree_pct"])
        rec = cfsa.recurrence_score(recurrence_30d)
        z = cfsa.frp_zscore(row.get("frp"), history_frps)
        anom = cfsa.anomaly_score(z)
        composite = cfsa.composite_score(prox, land, rec, anom, signature["temporal_signature_score"])
        persistence = cfsa.persistence_ratio(unique_days, config.LIVE_FIRMS_DAYS)

        # ---- Stage 5: classification ----
        result = classifier.classify(
            proximity=prox, landcover=land, recurrence=rec, anomaly=anom,
            temporal_signature=signature["temporal_signature_score"], composite=composite,
            frp_z=z, persistence=persistence, history_days=len(history),
            is_mining=enrichment.get("is_mining", False),
            crop_pct=enrichment["crop_pct"], tree_pct=enrichment["tree_pct"],
            spread_rate=signature["spread_rate"], daynight_ratio=signature["daynight_ratio"],
        )

        record = {
            "latitude": lat, "longitude": lon, "location_key": loc_key,
            "acq_date": acq_date, "acq_time": str(row["acq_time"]),
            "acq_datetime": row.get("acq_datetime"),
            "satellite": row.get("satellite"), "instrument": row.get("instrument"),
            "confidence": str(row.get("confidence")), "frp": row.get("frp"),
            "bright_ti4": row.get("bright_ti4"), "bright_ti5": row.get("bright_ti5"),
            "brightness_delta": (row.get("bright_ti4") or 0) - (row.get("bright_ti5") or 0),
            "daynight": row.get("daynight"),
            "confirmation_score": int(row.get("confirmation_score", 1)),
            "facility_name": enrichment.get("facility_name"),
            "facility_distance_m": enrichment.get("facility_distance_m"),
            "is_mining": enrichment.get("is_mining", False),
            "built_pct": enrichment["built_pct"], "crop_pct": enrichment["crop_pct"],
            "tree_pct": enrichment["tree_pct"],
            "recurrence_7d": recurrence_7d, "recurrence_30d": recurrence_30d,
            "recurrence_90d": recurrence_90d,
            "regularity_score": signature["regularity_score"],
            "daynight_ratio": signature["daynight_ratio"],
            "periodicity_score": signature["periodicity_score"],
            "spread_rate": signature["spread_rate"],
            "temporal_signature_score": signature["temporal_signature_score"],
            "proximity_score": prox, "landcover_score": land,
            "recurrence_score": rec, "anomaly_score": anom,
            "composite_score": composite, "frp_zscore": z,
            "persistence_ratio": persistence,
            "classification": result["classification"],
            "confidence_pct": result["confidence_pct"],
            "feature_attribution": result["feature_attribution"],
        }

        db.upsert_hotspot(record)
        processed += 1
        print(f"  [{processed}/{len(hotspots)}] ({lat:.3f},{lon:.3f}) -> "
              f"{result['classification']} ({result['confidence_pct']}%)")

    print(f"Pipeline run complete. {processed} hotspots processed and stored.")


if __name__ == "__main__":
    run_pipeline()
