# ThermalGuard AI — Working Prototype (Live Data)

Real, runnable implementation of the CFSA (Context-Based Fire Source
Assessment) pipeline, wired to your actual FIRMS key, Overpass API, and
Supabase Postgres instance.

⚠️ **Before you deploy this anywhere public:** the `.env` file in `backend/`
contains a live database password and a NASA Earthdata token. Rotate the
Supabase DB password and Earthdata token if this repo will be pushed to
GitHub or shared beyond your team.

## 1. One-time setup

```bash
cd backend
pip install -r requirements.txt
```

Create the database table (run once):

```bash
python db.py
```

This executes `sql/schema.sql` against your Supabase Postgres instance via
`DATABASE_URL`. You can also just paste `sql/schema.sql` into the Supabase
SQL editor in the dashboard if you prefer.

## 2. Run the pipeline once (manual test)

```bash
python pipeline.py
```

This will:
1. Pull live VIIRS NOAA-20/21 hotspots from NASA FIRMS for the Kutch bbox
   (`LIVE_BBOX` in `.env`) over the last `LIVE_FIRMS_DAYS` days.
2. Enrich each hotspot with nearest-industrial-facility distance and a
   land-cover proxy from OpenStreetMap Overpass.
3. Compute the temporal signature (regularity, periodicity, day/night ratio,
   spread rate) from stored history.
4. Compute the CFSA composite score and FRP Z-score anomaly.
5. Classify into one of 7 classes and store the fully-scored record in
   Supabase.

Expect this to take a few minutes on first run — the Overpass API is rate
limited and the pipeline pauses ~2 seconds per hotspot to stay polite to the
free public instance.

## 3. Start the API

```bash
uvicorn api:app --reload --port 8000
```

Check it's alive: open `http://localhost:8000/api/health`

## 4. Open the dashboard

Open `frontend/index.html` directly in a browser (or serve it with any
static file server). It fetches from `http://localhost:8000/api/hotspots`
and plots classified, color-coded hotspots on a MapLibre map. Click any
point to see the evidence panel (nearest facility, FRP, Z-score, composite
score).

Click "Refresh live data" to trigger a new pipeline run from the browser.

## 5. Keep it running in real time

For continuous monitoring, schedule `pipeline.py` on a cron job matching
VIIRS revisit frequency:

```bash
# crontab -e
0 */3 * * * cd /path/to/thermalguard/backend && /usr/bin/python3 pipeline.py >> pipeline.log 2>&1
```

## Known MVP simplifications (be upfront about these in Q&A)

- **Land cover** uses OSM landuse/natural tags as a lightweight proxy
  instead of downloading the full ESA WorldCover raster — swap in
  `rasterio` sampling in `osm_enrichment.landcover_proxy()` for production.
- **Spread-rate** (`temporal_signature.spread_rate`) currently compares
  same-day hotspot density; once a few days of live history accumulate in
  Supabase, wire it to compare consecutive days' cluster radius directly.
- **No supervised ML model** — this is intentional. See the solution report
  for the zero-label rationale. Unsupervised clustering (k-means/DBSCAN) can
  be added as a validation layer once enough rows exist in `hotspots`.

## File structure

```
thermalguard/
├── backend/
│   ├── .env                  # your live credentials (keep private)
│   ├── config.py             # loads .env, all thresholds/weights
│   ├── firms_client.py       # Stage 0: NASA FIRMS ingestion
│   ├── osm_enrichment.py     # Stage 1: OSM proximity + land-cover proxy
│   ├── temporal_signature.py # Stage 2: regularity/periodicity/spread
│   ├── cfsa_scoring.py       # Stage 3+4: composite score + Z-score anomaly
│   ├── classifier.py         # Stage 5: 7-class classification
│   ├── db.py                 # Supabase Postgres read/write
│   ├── pipeline.py           # orchestrates all stages end-to-end
│   └── api.py                # FastAPI serving GeoJSON to the dashboard
├── frontend/
│   └── index.html            # Stage 6: MapLibre GIS dashboard
└── sql/
    └── schema.sql            # hotspots table definition
```
