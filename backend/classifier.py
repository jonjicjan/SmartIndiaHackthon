"""
Stage 5 - Classification & Confidence Output

Maps CFSA scores into the 7-class operational taxonomy, using the
INDUSTRIAL_THRESHOLD / PERSISTENCE_THRESHOLD / ANOMALY_THRESHOLD
values from config (.env), and returns full feature attribution so
every decision is explainable, not a black box.
"""
import config


def classify(
    proximity: float, landcover: float, recurrence: float, anomaly: float,
    temporal_signature: float, composite: float, frp_z: float,
    persistence: float, history_days: int, is_mining: bool,
    crop_pct: float, tree_pct: float, spread_rate: float, daynight_ratio: float,
) -> dict:

    industrial_context = ((proximity / 100) * 0.6) + ((landcover / 100) * 0.4)

    attribution = {
        "proximity": proximity,
        "landcover": landcover,
        "recurrence": recurrence,
        "anomaly": anomaly,
        "temporal_signature": temporal_signature,
    }

    if industrial_context >= config.INDUSTRIAL_THRESHOLD:
        if history_days < 7:
            return _result("Industrial - History Insufficient", composite, attribution)
        if abs(frp_z) >= config.ANOMALY_THRESHOLD:
            return _result("Potential Abnormal Industrial Event", composite, attribution)
        if persistence >= config.PERSISTENCE_THRESHOLD:
            return _result("Persistent Industrial Thermal Source", composite, attribution)
        return _result("Industrial - History Insufficient", composite, attribution)

    # Non-industrial branch - sub-classify natural/other source types
    if is_mining:
        return _result("Mining Activity", max(composite, 40), attribution)

    if tree_pct > 50 and spread_rate > 20:
        return _result("Wildfire", max(composite, 45), attribution)

    if crop_pct > 60 and daynight_ratio < 30:
        return _result("Agricultural Burning", max(composite, 40), attribution)

    if tree_pct > 30 or crop_pct > 30:
        return _result("Natural / Non-Industrial Thermal Event", max(composite, 30), attribution)

    return _result("Uncertain", composite, attribution)


def _result(label: str, confidence_pct: float, attribution: dict) -> dict:
    return {
        "classification": label,
        "confidence_pct": round(min(99.0, max(1.0, confidence_pct)), 1),
        "feature_attribution": attribution,
    }
