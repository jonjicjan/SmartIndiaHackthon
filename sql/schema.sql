-- ThermalGuard AI — Supabase / PostGIS schema
-- Run this once in the Supabase SQL editor (or via psql against DATABASE_URL)
-- before running pipeline.py for the first time.

create table if not exists hotspots (
    id                      bigserial primary key,
    latitude                double precision not null,
    longitude               double precision not null,
    location_key            text not null,          -- grid cell id used for history/baseline grouping
    acq_date                date not null,
    acq_time                text not null,
    acq_datetime            timestamp,
    satellite               text,
    instrument              text,
    confidence              text,
    frp                     double precision,
    bright_ti4              double precision,
    bright_ti5              double precision,
    brightness_delta        double precision,
    daynight                text,
    confirmation_score      integer default 1,

    -- Stage 1: context enrichment
    facility_name           text,
    facility_distance_m     double precision,
    is_mining               boolean default false,
    built_pct               double precision,
    crop_pct                double precision,
    tree_pct                double precision,
    recurrence_7d           integer default 0,
    recurrence_30d          integer default 0,
    recurrence_90d          integer default 0,

    -- Stage 2: temporal signature
    regularity_score        double precision,
    daynight_ratio          double precision,
    periodicity_score       double precision,
    spread_rate             double precision,
    temporal_signature_score double precision,

    -- Stage 3: CFSA composite scoring
    proximity_score         double precision,
    landcover_score         double precision,
    recurrence_score        double precision,
    anomaly_score            double precision,
    composite_score          double precision,

    -- Stage 4: anomaly + baseline
    frp_zscore               double precision,
    persistence_ratio        double precision,

    -- Stage 5: classification
    classification            text,
    confidence_pct             double precision,
    feature_attribution        jsonb,

    created_at                 timestamp default now(),
    unique (latitude, longitude, acq_date, acq_time, satellite)
);

create index if not exists idx_hotspots_location_key on hotspots (location_key);
create index if not exists idx_hotspots_classification on hotspots (classification);
create index if not exists idx_hotspots_acq_date on hotspots (acq_date);

-- PostGIS Spatial Indexing
create extension if not exists postgis;
alter table hotspots add column if not exists geom geometry(Point, 4326);
create index if not exists idx_hotspots_geom on hotspots using gist(geom);
