"""
Stage 2 - Temporal Signature Analysis

Computes the behavioural "heartbeat" of a location from its real detection
history in the database: regularity, day/night ratio, periodicity, and
spatial spread rate. All of this is unsupervised - no labels required.
"""
import numpy as np
import pandas as pd


def regularity_score(history: list[dict]) -> float:
    """Low variance between consecutive detection gaps -> higher regularity
    (process-driven heat). High variance -> event-driven (incident/wildfire)."""
    if len(history) < 3:
        return 50.0  # neutral - not enough history to judge
    times = sorted(h["acq_datetime"] for h in history if h["acq_datetime"])
    gaps_hours = np.diff([t.timestamp() for t in times]) / 3600.0
    if len(gaps_hours) == 0 or gaps_hours.mean() == 0:
        return 50.0
    cv = gaps_hours.std() / gaps_hours.mean()  # coefficient of variation
    return float(max(0.0, min(100.0, 100 / (1 + cv))))


def daynight_ratio(history: list[dict]) -> float:
    """% of detections that occurred at night - continuous day+night presence
    suggests process heat (flare/furnace); day-dominant suggests agricultural
    burning or daytime-only industrial operations."""
    if not history:
        return 50.0
    night = sum(1 for h in history if str(h.get("daynight", "")).upper() == "N")
    return round(100 * night / len(history), 1)


def periodicity_score(history: list[dict]) -> float:
    """Autocorrelation of the daily detection-count series at lag 1 day.
    A strong positive peak indicates a regular (industrial) cycle."""
    if len(history) < 5:
        return 0.0
    dates = pd.to_datetime([h["acq_datetime"] for h in history if h["acq_datetime"]])
    if dates.empty:
        return 0.0
    daily_counts = dates.to_series().dt.date.value_counts().sort_index()
    full_range = pd.date_range(daily_counts.index.min(), daily_counts.index.max())
    series = daily_counts.reindex(full_range.date, fill_value=0)
    if len(series) < 3 or series.std() == 0:
        return 0.0
    autocorr = series.autocorr(lag=1)
    if pd.isna(autocorr):
        return 0.0
    return round(max(0.0, autocorr) * 100, 1)


def spread_rate(history: list[dict], current_lat: float, current_lon: float,
                 nearby_today: int, nearby_yesterday: int) -> float:
    """Growth in the number of nearby hotspots day-over-day. Static count ->
    industrial source. Increasing count -> spreading fire (wildfire signature)."""
    if nearby_yesterday == 0:
        return 0.0 if nearby_today <= 1 else 100.0
    rate = (nearby_today - nearby_yesterday) / nearby_yesterday
    return round(max(-100.0, min(100.0, rate * 100)), 1)


def brightness_delta_score(bright_ti4: float, bright_ti5: float) -> float:
    """Dual-band brightness gap - a recognised gas-flare/small-hot-source
    signature (large gap = sub-pixel intense source, e.g. a flare stack)."""
    if bright_ti4 is None or bright_ti5 is None:
        return 50.0
    delta = bright_ti4 - bright_ti5
    return round(max(0.0, min(100.0, delta * 2)), 1)  # scaled heuristic, tunable


def compute_temporal_signature(history: list[dict], current_record: dict,
                                nearby_today: int, nearby_yesterday: int) -> dict:
    reg = regularity_score(history)
    dn = daynight_ratio(history)
    per = periodicity_score(history)
    spr = spread_rate(history, current_record["latitude"], current_record["longitude"],
                       nearby_today, nearby_yesterday)
    bd = brightness_delta_score(current_record.get("bright_ti4"), current_record.get("bright_ti5"))

    # Combined sub-score: regularity + periodicity + brightness-delta push
    # toward "industrial/process" behaviour; high spread pulls toward "spreading fire".
    combined = (0.30 * reg) + (0.25 * per) + (0.20 * bd) + (0.15 * dn) - (0.10 * max(0, spr))
    combined = max(0.0, min(100.0, combined))

    return {
        "regularity_score": reg,
        "daynight_ratio": dn,
        "periodicity_score": per,
        "spread_rate": spr,
        "brightness_delta_score": bd,
        "temporal_signature_score": round(combined, 1),
    }
