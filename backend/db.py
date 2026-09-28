"""
Database access layer - Supabase Postgres (via SQLAlchemy) with resilient local SQLite fallback.
Handles upserting enriched/classified hotspots with PostGIS geometry,
spatial bounding box queries, and alert deduplication.
"""
from datetime import date, datetime
import json
import os
from pathlib import Path
from sqlalchemy import create_engine, text
import config

DB_PATH = Path(__file__).resolve().parent / "thermalguard.db"


def _init_engine():
    """Attempt Postgres connection with quick timeout; fallback to local SQLite."""
    if config.DATABASE_URL:
        try:
            eng = create_engine(
                config.DATABASE_URL,
                pool_pre_ping=True,
                connect_args={"connect_timeout": 3} if "postgres" in config.DATABASE_URL else {}
            )
            with eng.connect() as conn:
                conn.execute(text("SELECT 1"))
            return eng, "postgresql"
        except Exception as exc:
            print(f"[db] Supabase Postgres unreachable ({exc}). Using local resilient SQLite engine.")

    eng = create_engine(f"sqlite:///{DB_PATH}")
    return eng, "sqlite"


engine, DB_DIALECT = _init_engine()


def location_key(lat: float, lon: float) -> str:
    """Snap a lat/lon to a grid cell so repeat detections at (roughly) the
    same physical site are grouped together for history/baseline lookups."""
    cell = config.GRID_CELL_DEGREES
    grid_lat = round(lat / cell) * cell
    grid_lon = round(lon / cell) * cell
    return f"{grid_lat:.5f}_{grid_lon:.5f}"


def fetch_history(loc_key: str, days: int = 90):
    """Return this location's past detections (for recurrence + baseline calcs)."""
    if DB_DIALECT == "postgresql":
        query = text("""
            SELECT acq_datetime, frp, daynight
            FROM hotspots
            WHERE location_key = :loc_key
              AND acq_datetime >= now() - (:days || ' days')::interval
            ORDER BY acq_datetime ASC
        """)
        params = {"loc_key": loc_key, "days": days}
    else:
        query = text("""
            SELECT acq_datetime, frp, daynight
            FROM hotspots
            WHERE location_key = :loc_key
            ORDER BY acq_datetime ASC
        """)
        params = {"loc_key": loc_key}

    with engine.connect() as conn:
        rows = conn.execute(query, params).mappings().all()
    return [dict(r) for r in rows]


def upsert_hotspot(record: dict):
    """Insert a fully scored hotspot record, skipping exact duplicates."""
    record = dict(record)
    if isinstance(record.get("acq_date"), (datetime, date)):
        record["acq_date"] = str(record["acq_date"])
    if isinstance(record.get("acq_datetime"), (datetime, date)):
        record["acq_datetime"] = str(record["acq_datetime"])
    record["feature_attribution"] = json.dumps(record.get("feature_attribution", {}))

    if DB_DIALECT == "postgresql":
        columns = ", ".join(record.keys()) + ", geom"
        placeholders = ", ".join(f":{k}" for k in record.keys()) + ", ST_SetSRID(ST_MakePoint(:longitude, :latitude), 4326)"
        query = text(f"""
            INSERT INTO hotspots ({columns})
            VALUES ({placeholders})
            ON CONFLICT (latitude, longitude, acq_date, acq_time, satellite)
            DO UPDATE SET
                classification = EXCLUDED.classification,
                confidence_pct = EXCLUDED.confidence_pct,
                composite_score = EXCLUDED.composite_score,
                feature_attribution = EXCLUDED.feature_attribution,
                geom = EXCLUDED.geom
        """)
    else:
        columns = ", ".join(record.keys())
        placeholders = ", ".join(f":{k}" for k in record.keys())
        query = text(f"""
            INSERT INTO hotspots ({columns})
            VALUES ({placeholders})
            ON CONFLICT (latitude, longitude, acq_date, acq_time, satellite)
            DO UPDATE SET
                classification = excluded.classification,
                confidence_pct = excluded.confidence_pct,
                composite_score = excluded.composite_score,
                feature_attribution = excluded.feature_attribution
        """)

    with engine.begin() as conn:
        conn.execute(query, record)


def fetch_all_classified(limit: int = 500, bbox: dict = None):
    """Return the most recent classified hotspots, optionally filtered by bounding box."""
    if bbox:
        query = text("""
            SELECT * FROM hotspots
            WHERE longitude >= :west AND longitude <= :east
              AND latitude >= :south AND latitude <= :north
            ORDER BY acq_datetime DESC
            LIMIT :limit
        """)
        params = {"limit": limit, "west": bbox["west"], "east": bbox["east"], "south": bbox["south"], "north": bbox["north"]}
    else:
        query = text("""
            SELECT * FROM hotspots
            ORDER BY acq_datetime DESC
            LIMIT :limit
        """)
        params = {"limit": limit}

    with engine.connect() as conn:
        rows = conn.execute(query, params).mappings().all()
    return [dict(r) for r in rows]


def fetch_active_alerts(cooldown_hours: int = 12):
    """
    Fetch potential abnormal alerts deduplicated by location_key within the cooldown window.
    Prevents alert flooding at national scale.
    """
    if DB_DIALECT == "postgresql":
        query = text("""
            SELECT DISTINCT ON (location_key)
                id, latitude, longitude, location_key, acq_date, acq_time, acq_datetime,
                classification, confidence_pct, facility_name, facility_distance_m,
                frp, frp_zscore, composite_score
            FROM hotspots
            WHERE classification LIKE '%Abnormal%'
              AND acq_datetime >= now() - (:hours || ' hours')::interval
            ORDER BY location_key, acq_datetime DESC
        """)
        params = {"hours": cooldown_hours}
    else:
        query = text("""
            SELECT
                id, latitude, longitude, location_key, acq_date, acq_time, acq_datetime,
                classification, confidence_pct, facility_name, facility_distance_m,
                frp, frp_zscore, composite_score
            FROM hotspots
            WHERE classification LIKE '%Abnormal%'
            GROUP BY location_key
            ORDER BY acq_datetime DESC
        """)
        params = {}

    with engine.connect() as conn:
        rows = conn.execute(query, params).mappings().all()
    return [dict(r) for r in rows]


def init_schema():
    """Create the hotspots table if it doesn't already exist (idempotent)."""
    global engine, DB_DIALECT
    if DB_DIALECT == "postgresql":
        try:
            schema_file = Path(__file__).resolve().parent.parent / "sql" / "schema.sql"
            with open(schema_file, encoding="utf-8") as f:
                ddl = f.read()
            with engine.begin() as conn:
                conn.execute(text(ddl))
            print("Schema ensured on Supabase Postgres with PostGIS.")
            return
        except Exception as e:
            print(f"[db] Postgres DDL error ({e}), switching to local SQLite database.")
            engine = create_engine(f"sqlite:///{DB_PATH}")
            DB_DIALECT = "sqlite"

    sqlite_ddl = """
    CREATE TABLE IF NOT EXISTS hotspots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        location_key TEXT NOT NULL,
        acq_date TEXT NOT NULL,
        acq_time TEXT NOT NULL,
        acq_datetime TEXT,
        satellite TEXT,
        instrument TEXT,
        confidence TEXT,
        frp REAL,
        bright_ti4 REAL,
        bright_ti5 REAL,
        brightness_delta REAL,
        daynight TEXT,
        confirmation_score INTEGER DEFAULT 1,
        facility_name TEXT,
        facility_distance_m REAL,
        is_mining INTEGER DEFAULT 0,
        built_pct REAL,
        crop_pct REAL,
        tree_pct REAL,
        recurrence_7d INTEGER DEFAULT 0,
        recurrence_30d INTEGER DEFAULT 0,
        recurrence_90d INTEGER DEFAULT 0,
        regularity_score REAL,
        daynight_ratio REAL,
        periodicity_score REAL,
        spread_rate REAL,
        temporal_signature_score REAL,
        proximity_score REAL,
        landcover_score REAL,
        recurrence_score REAL,
        anomaly_score REAL,
        composite_score REAL,
        frp_zscore REAL,
        persistence_ratio REAL,
        classification TEXT,
        confidence_pct REAL,
        feature_attribution TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (latitude, longitude, acq_date, acq_time, satellite)
    );
    CREATE INDEX IF NOT EXISTS idx_hotspots_loc on hotspots (location_key);
    CREATE INDEX IF NOT EXISTS idx_hotspots_cls on hotspots (classification);
    CREATE INDEX IF NOT EXISTS idx_hotspots_dt on hotspots (acq_datetime);
    """
    with engine.begin() as conn:
        for stmt in sqlite_ddl.strip().split(";"):
            if stmt.strip():
                conn.execute(text(stmt))
    print("Schema ensured on local SQLite database.")


if __name__ == "__main__":
    init_schema()
