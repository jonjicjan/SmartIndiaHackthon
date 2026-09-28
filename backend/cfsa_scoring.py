"""
Stage 3 - CFSA Composite Scoring
Stage 4 - Baseline Anomaly Detection

Composite_Score = 0.30*Proximity + 0.20*LandCover + 0.15*Recurrence
                 + 0.15*Anomaly   + 0.20*TemporalSignature

All five sub-scores are computed from real, live data - no trained model,
by design (see README for the zero-label rationale).
"""
import statistics
import config


def proximity_score(facility_distance_m: float | None) -> float:
    """Distance-decay: closer to a known industrial facility -> higher score.
    Beyond 10 km, treated as effectively non-industrial."""
    if facility_distance_m is None:
        return 0.0
    decay_km = facility_distance_m / 1000.0
    score = 100 * (2.718281828 ** (-decay_km / 3.0))  # ~37% score remaining at 3km
    return round(max(0.0, min(100.0, score)), 1)


def landcover_score(built_pct: float, crop_pct: float, tree_pct: float) -> float:
    """Higher built-up % pushes the score toward 'industrial context'."""
    return round(max(0.0, min(100.0, built_pct)), 1)


def recurrence_score(recurrence_30d: int) -> float:
    """More repeat detections at this site in the last 30 days -> higher score,
    saturating at 15+ detections (roughly daily activity)."""
    return round(max(0.0, min(100.0, (recurrence_30d / 15.0) * 100)), 1)


def frp_zscore(current_frp: float, history_frps: list[float]) -> float:
    """How many standard deviations today's FRP is from this location's own
    historical mean - the core, fully unsupervised anomaly signal."""
    if len(history_frps) < 3 or current_frp is None:
        return 0.0
    mean_frp = statistics.mean(history_frps)
    std_frp = statistics.pstdev(history_frps) or 1.0
    return round((current_frp - mean_frp) / std_frp, 2)


def anomaly_score(z: float) -> float:
    """Convert a Z-score magnitude into a 0-100 CFSA sub-score."""
    return round(max(0.0, min(100.0, abs(z) / config.ANOMALY_THRESHOLD * 100)), 1)


def persistence_ratio(unique_days: int, observable_days: int) -> float:
    if observable_days <= 0:
        return 0.0
    return round(min(1.0, unique_days / observable_days), 3)


def composite_score(proximity: float, landcover: float, recurrence: float,
                     anomaly: float, temporal_signature: float) -> float:
    w = config.CFSA_WEIGHTS
    total = (
        w["proximity"] * proximity
        + w["landcover"] * landcover
        + w["recurrence"] * recurrence
        + w["anomaly"] * anomaly
        + w["temporal_signature"] * temporal_signature
    )
    return round(total, 1)
