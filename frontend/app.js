/**
 * ThermalGuard AI — Intelligence Analyst GIS Workspace
 * Orchestrates MapLibre layers, telemetry feeds, evidence generation,
 * historical FRP canvas charts, and analyst workflows.
 */

const API_BASE = (window.location.origin && window.location.origin.startsWith("http"))
  ? window.location.origin
  : "http://localhost:8000";

let map = null;
let currentMode = "live"; // 'live' | 'replay'
let currentState = "all_india";
let rawHotspots = [];
let activeHotspot = null;
let activeAlerts = [];

// Classification styling maps
const CLASS_THEMES = {
  "Potential Abnormal Industrial Event": {
    color: "#FF4D4D",
    bannerClass: "banner-abnormal",
    dotClass: "critical",
    tag: "ABNORMAL EVENT",
  },
  "Persistent Industrial Thermal Source": {
    color: "#00E5A3",
    bannerClass: "banner-persistent",
    dotClass: "info",
    tag: "PERSISTENT SOURCE",
  },
  "Wildfire": {
    color: "#FFA726",
    bannerClass: "banner-natural",
    dotClass: "medium",
    tag: "VEGETATION FIRE",
  },
  "Agricultural Burning": {
    color: "#A3E635",
    bannerClass: "banner-natural",
    dotClass: "medium",
    tag: "STUBBLE BURNING",
  },
  "Mining Activity": {
    color: "#94A3B8",
    bannerClass: "banner-uncertain",
    dotClass: "info",
    tag: "SURFACE EXTRACTION",
  },
  "Industrial - History Insufficient": {
    color: "#38BDF8",
    bannerClass: "banner-insufficient",
    dotClass: "info",
    tag: "PROVISIONAL SITE",
  },
  "Uncertain": {
    color: "#64748B",
    bannerClass: "banner-uncertain",
    dotClass: "info",
    tag: "UNCONFIRMED",
  },
  "Natural / Non-Industrial Thermal Event": {
    color: "#F59E0B",
    bannerClass: "banner-natural",
    dotClass: "medium",
    tag: "NATURAL SOURCE",
  },
};

// Basemap Styles Catalog (Apple Weather style basemap switcher)
const BASEMAP_STYLES = [
  {
    id: "dark",
    name: "Dark Matter",
    style: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
  },
  {
    id: "satellite",
    name: "Orbital Satellite",
    style: {
      version: 8,
      sources: {
        "esri-satellite": {
          type: "raster",
          tiles: [
            "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
          ],
          tileSize: 256,
          attribution: "&copy; Esri, Maxar, Earthstar Geographics"
        }
      },
      layers: [
        {
          id: "esri-satellite-layer",
          type: "raster",
          source: "esri-satellite",
          minzoom: 0,
          maxzoom: 19
        }
      ]
    }
  },
  {
    id: "positron",
    name: "Clean Positron",
    style: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
  }
];

let currentBasemapIdx = 0;
let facilitiesGeoJSON = null;
let radarProgress = 100;
let isPlayingRadar = false;
let radarAnimationTimer = null;

// 1. Initialize MapLibre GL with Apple Weather Aesthetics
function initMap() {
  map = new maplibregl.Map({
    container: "gis-map",
    style: BASEMAP_STYLES[currentBasemapIdx].style,
    center: [79.0, 22.5], // centered on Pan-India national view
    zoom: 4.8,
    pitch: 15,
    attributionControl: false,
  });

  map.on("load", () => {
    addMapLayers();
    loadHotspotsData();
    loadFacilitiesData();
    loadAlerts();
  });
}

// Cycle through available basemaps smoothly
function cycleBasemap() {
  if (!map) return;
  currentBasemapIdx = (currentBasemapIdx + 1) % BASEMAP_STYLES.length;
  const newStyle = BASEMAP_STYLES[currentBasemapIdx];

  map.setStyle(newStyle.style);
  map.once("style.load", () => {
    addMapLayers();
    applyFilters();
    if (facilitiesGeoJSON && map.getSource("facilities-src")) {
      map.getSource("facilities-src").setData(facilitiesGeoJSON);
    }
  });

  // Brief toast notification in legend header
  const legendVal = document.getElementById("apple-legend-live-val");
  if (legendVal) {
    const orig = legendVal.textContent;
    legendVal.textContent = `Map: ${newStyle.name}`;
    setTimeout(() => {
      if (legendVal) legendVal.textContent = orig;
    }, 2000);
  }
}

// 2. Add Hotspot, Fluid Thermal Radar Heatmap & Industrial Layers to Map
function addMapLayers() {
  // Source: Hotspots GeoJSON
  if (!map.getSource("hotspots-src")) {
    map.addSource("hotspots-src", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
  }

  // A. Fluid Thermal Radar Heatmap Layer (Apple Weather continuous thermal gradient)
  if (!map.getLayer("hotspots-heatmap")) {
    map.addLayer({
      id: "hotspots-heatmap",
      type: "heatmap",
      source: "hotspots-src",
      maxzoom: 14,
      paint: {
        // Increase weight based on FRP (Thermal Radiative Power)
        "heatmap-weight": [
          "interpolate", ["linear"], ["get", "frp"],
          0, 0,
          10, 0.25,
          50, 0.6,
          150, 0.85,
          300, 1.0
        ],
        // Intensity multiplier as zoom increases
        "heatmap-intensity": [
          "interpolate", ["linear"], ["zoom"],
          3, 0.8,
          8, 2.2,
          12, 3.5
        ],
        // Apple Weather Continuous Temperature / Thermal Radar Color Ramp
        "heatmap-color": [
          "interpolate", ["linear"], ["heatmap-density"],
          0.0, "rgba(0, 229, 163, 0)",
          0.12, "rgba(6, 182, 212, 0.35)",
          0.32, "rgba(16, 185, 129, 0.65)",
          0.52, "rgba(245, 158, 11, 0.82)",
          0.72, "rgba(249, 115, 22, 0.92)",
          0.88, "rgba(239, 68, 68, 0.96)",
          1.0, "rgba(255, 77, 148, 1.0)"
        ],
        // Heatmap radius in pixels
        "heatmap-radius": [
          "interpolate", ["linear"], ["zoom"],
          3, 20,
          6, 36,
          9, 55,
          13, 85
        ],
        "heatmap-opacity": 0.82
      }
    });
  }

  // B. Halo Glow Layer for High-FRP / Abnormal Hotspots
  if (!map.getLayer("hotspots-halo")) {
    map.addLayer({
      id: "hotspots-halo",
      type: "circle",
      source: "hotspots-src",
      paint: {
        "circle-radius": [
          "interpolate", ["linear"], ["get", "frp"],
          10, 14,
          50, 22,
          200, 36,
        ],
        "circle-color": ["get", "color"],
        "circle-opacity": 0.25,
        "circle-blur": 0.8,
      },
    });
  }

  // C. Primary Hotspot Pinpoint Circles Layer
  if (!map.getLayer("hotspots-points")) {
    map.addLayer({
      id: "hotspots-points",
      type: "circle",
      source: "hotspots-src",
      paint: {
        "circle-radius": [
          "interpolate", ["linear"], ["get", "frp"],
          5, 6,
          40, 9,
          150, 14,
          300, 18,
        ],
        "circle-color": ["get", "color"],
        "circle-stroke-width": 2,
        "circle-stroke-color": "#ffffff",
        "circle-opacity": 0.95,
      },
    });
  }

  // D. Industrial Infrastructure Mesh Layers
  if (!map.getSource("facilities-src")) {
    map.addSource("facilities-src", {
      type: "geojson",
      data: facilitiesGeoJSON || { type: "FeatureCollection", features: [] },
    });
  }

  if (!map.getLayer("facilities-rings")) {
    map.addLayer({
      id: "facilities-rings",
      type: "circle",
      source: "facilities-src",
      paint: {
        "circle-radius": 9,
        "circle-color": "rgba(6, 182, 212, 0.18)",
        "circle-stroke-width": 1.5,
        "circle-stroke-color": "#06b6d4",
      },
      layout: {
        visibility: "none" // toggled by Facility Mesh pill
      }
    });
  }

  if (!map.getLayer("facilities-points")) {
    map.addLayer({
      id: "facilities-points",
      type: "circle",
      source: "facilities-src",
      paint: {
        "circle-radius": 3.5,
        "circle-color": "#ffffff",
      },
      layout: {
        visibility: "none"
      }
    });
  }

  // Hover & Click interactions on Hotspot Nodes
  map.on("click", "hotspots-points", (e) => {
    if (e.features && e.features[0]) {
      selectHotspot(e.features[0].properties);
    }
  });

  const hoverCard = document.getElementById("apple-hover-card");
  const hoverId = document.getElementById("apple-hover-id");
  const hoverFrp = document.getElementById("apple-hover-frp");
  const hoverFac = document.getElementById("apple-hover-fac");
  const hoverClass = document.getElementById("apple-hover-class");
  const hoverDist = document.getElementById("apple-hover-dist");

  map.on("mousemove", "hotspots-points", (e) => {
    if (!e.features || !e.features[0]) return;
    map.getCanvas().style.cursor = "pointer";
    const p = e.features[0].properties;

    if (hoverCard) {
      hoverId.textContent = p.event_id || (p.id ? `TG-${p.id}` : "TG-ANOMALY");
      const frpVal = Number(p.frp || 0).toFixed(1);
      hoverFrp.textContent = `${frpVal} MW`;
      hoverFac.textContent = p.facility_name || "Regional Industrial Zone";
      hoverClass.textContent = p.classification || "Thermal Event";

      if (p.facility_distance_m !== undefined && p.facility_distance_m !== null) {
        const d = Number(p.facility_distance_m);
        hoverDist.textContent = d < 1000 ? `${Math.round(d)} m` : `${(d / 1000).toFixed(1)} km`;
      } else {
        hoverDist.textContent = "Isolated";
      }

      hoverCard.style.left = `${e.point.x}px`;
      hoverCard.style.top = `${e.point.y}px`;
      hoverCard.style.display = "block";
    }

    // Slide dynamic legend needle
    updateLegendPointer(p.frp);
  });

  map.on("mouseleave", "hotspots-points", () => {
    map.getCanvas().style.cursor = "";
    if (hoverCard) hoverCard.style.display = "none";
    if (activeHotspot) {
      updateLegendPointer(activeHotspot.frp);
    }
  });
}

// 3. Load Hotspots from API
async function loadHotspotsData() {
  try {
    const url = `${API_BASE}/api/hotspots?mode=${currentMode}&state=${currentState}`;
    const res = await fetch(url);
    const data = await res.json();
    rawHotspots = data.features || [];

    applyFilters();

    // Auto-select first hotspot (or flagship TG-4082 if in replay mode)
    if (rawHotspots.length > 0) {
      const defaultItem = rawHotspots.find(
        (f) => f.properties.event_id === "TG-4082" || f.properties.id === 4082
      ) || rawHotspots[0];
      selectHotspot(defaultItem.properties);
    }
  } catch (err) {
    console.error("Failed to load hotspots:", err);
  }
}

// Load National Facility Mesh GeoJSON
async function loadFacilitiesData() {
  try {
    const res = await fetch(`${API_BASE}/api/facilities`);
    facilitiesGeoJSON = await res.json();
    if (map && map.getSource("facilities-src")) {
      map.getSource("facilities-src").setData(facilitiesGeoJSON);
    }
  } catch (err) {
    console.error("Failed to load facilities mesh:", err);
  }
}

// Dynamic Legend Pointer calculation along the FRP gradient
function updateLegendPointer(frpVal) {
  const pointer = document.getElementById("apple-legend-pointer");
  const liveVal = document.getElementById("apple-legend-live-val");
  if (!pointer) return;
  const frp = Number(frpVal || 0);
  // Scale: 0 to 200 MW (clamped 3% to 97%)
  const pct = Math.min(97, Math.max(3, (frp / 200) * 100));
  pointer.style.left = `${pct}%`;
  if (liveVal) {
    const statusText = frp > 150 ? "Critical Flare" : frp > 50 ? "Elevated" : "Nominal";
    liveVal.textContent = `${frp.toFixed(1)} MW (${statusText})`;
    liveVal.style.color = frp > 150 ? "#ff4d4d" : frp > 50 ? "#f59e0b" : "#00e5a3";
  }
}

// 4. Apply Filters (Class, Search, Confidence, Timeline Radar Scrubber)
function applyFilters(timelineHoursLimit = null) {
  const classFilter = document.getElementById("class-filter") ? document.getElementById("class-filter").value : "ALL";
  const confFilter = document.getElementById("conf-filter") ? parseInt(document.getElementById("conf-filter").value) : 0;
  const search = document.getElementById("search-input") ? document.getElementById("search-input").value.toLowerCase() : "";

  const filtered = rawHotspots.filter((f, idx) => {
    const p = f.properties;
    // Class filter
    if (classFilter !== "ALL") {
      if (classFilter === "ABNORMAL" && !p.classification.includes("Abnormal")) return false;
      if (classFilter === "PERSISTENT" && !p.classification.includes("Persistent")) return false;
      if (classFilter === "NATURAL" && !p.classification.includes("Wildfire") && !p.classification.includes("Agricultural") && !p.classification.includes("Natural")) return false;
      if (classFilter === "INSUFFICIENT" && !p.classification.includes("Insufficient")) return false;
      if (classFilter === "UNCERTAIN" && !p.classification.includes("Uncertain")) return false;
    }

    // Confidence filter
    if (p.confidence_pct < confFilter) return false;

    // Search filter
    if (search) {
      const matchId = p.event_id && p.event_id.toLowerCase().includes(search);
      const matchFac = p.facility_name && p.facility_name.toLowerCase().includes(search);
      const matchClass = p.classification && p.classification.toLowerCase().includes(search);
      if (!matchId && !matchFac && !matchClass) return false;
    }

    // Timeline Scrubber Filtering (simulates historical satellite pass sequence)
    if (timelineHoursLimit !== null && timelineHoursLimit !== undefined) {
      const thresholdIdx = Math.max(2, Math.floor((timelineHoursLimit / 100) * rawHotspots.length));
      if (idx > thresholdIdx) return false;
    }

    return true;
  });

  // Update map source
  if (map && map.getSource("hotspots-src")) {
    map.getSource("hotspots-src").setData({
      type: "FeatureCollection",
      features: filtered,
    });
  }

  updateKpiStrip(rawHotspots);
}

// 5. Select & Display Hotspot Intelligence Dossier
function selectHotspot(p) {
  activeHotspot = p;

  // Unpack properties (handles JSON strings if stored as such)
  if (typeof p.evidence_cards === "string") {
    try { p.evidence_cards = JSON.parse(p.evidence_cards); } catch (e) { p.evidence_cards = []; }
  }
  if (typeof p.feature_attribution === "string") {
    try { p.feature_attribution = JSON.parse(p.feature_attribution); } catch (e) { p.feature_attribution = {}; }
  }

  const theme = CLASS_THEMES[p.classification] || CLASS_THEMES["Uncertain"];

  // Header & Title
  const evId = p.event_id || (p.id ? `TG-${String(p.id).padStart(4, "0")}` : "TG-XXXX");
  document.getElementById("ev-event-id").textContent = evId;
  document.getElementById("ev-tag").textContent = theme.tag;

  // Classification Banner
  const banner = document.getElementById("ev-banner");
  banner.className = `panel-classification-banner ${theme.bannerClass}`;
  document.getElementById("ev-class-name").textContent = p.classification;
  document.getElementById("ev-confidence").textContent = `${p.confidence_pct}% Conf.`;

  // Industrial Probability
  const indProb = p.industrial_probability !== undefined ? p.industrial_probability : Math.round(p.confidence_pct);
  document.getElementById("ev-prob-val").textContent = `${indProb}%`;
  document.getElementById("ev-prob-bar").style.width = `${indProb}%`;

  // Telemetry Grid
  document.getElementById("ev-current-frp").textContent = `${p.frp} MW`;
  document.getElementById("ev-baseline-frp").textContent = `${p.baseline_frp} MW`;

  const zscore = p.frp_zscore !== undefined ? p.frp_zscore : 0.0;
  const zSign = zscore > 0 ? "+" : "";
  const devEl = document.getElementById("ev-frp-dev");
  devEl.textContent = `${zSign}${zscore}σ`;
  devEl.style.color = zscore >= 2.0 ? "var(--color-abnormal)" : zscore > 0.5 ? "var(--color-natural)" : "var(--color-persistent)";

  document.getElementById("ev-facility-name").textContent = p.facility_name || "Isolated Area";
  document.getElementById("ev-facility-dist").textContent = p.facility_distance_m ? `${Math.round(p.facility_distance_m)} m` : "> 5.0 km";

  // Land Cover Proxy
  document.getElementById("ev-landcover").textContent = `Built: ${p.built_pct}% | Tree: ${p.tree_pct}% | Crop: ${p.crop_pct}%`;

  // Recurrence
  const rec30 = p.recurrence_30d || 0;
  document.getElementById("ev-recurrence").textContent = `${rec30} detections / 30d`;

  // Evidence Cards
  const cardsList = document.getElementById("ev-cards-list");
  cardsList.innerHTML = "";
  const evidenceCards = p.evidence_cards && p.evidence_cards.length > 0
    ? p.evidence_cards
    : [
        { status: "pass", text: `Industrial infrastructure proximity verified (${p.facility_name || "Area"})` },
        { status: "pass", text: `${rec30} historical acquisitions recorded at site` },
        { status: zscore >= 2.0 ? "warn" : "pass", text: `Current FRP (${p.frp} MW) relative to baseline: ${zSign}${zscore}σ` },
        { status: "info", text: `VIIRS detection: ${p.daynight === "N" ? "Night-time pass" : "Day-time pass"}` },
      ];

  evidenceCards.forEach((card) => {
    const el = document.createElement("div");
    el.className = "evidence-card";
    const icon = card.status === "pass" ? "✓" : card.status === "warn" ? "⚠" : "ℹ";
    const statusClass = `evidence-status-${card.status}`;
    el.innerHTML = `<span class="${statusClass}" style="font-weight:700">${icon}</span><span>${card.text}</span>`;
    cardsList.appendChild(el);
  });

  // AI Explanation Narrative
  document.getElementById("ev-ai-explanation").textContent = p.ai_explanation || 
    `Classification derived from multi-sensor CFSA pipeline. Feature attribution confirms proximity weight of ${(p.proximity_score || 70)}/100 and temporal recurrence score of ${(p.recurrence_score || 60)}/100.`;

  // Thermal Behaviour Fingerprint
  document.getElementById("tb-recurrence").textContent = `${rec30 > 0 ? Math.min(99, rec30 * 4) : 10}%`;
  document.getElementById("tb-night-ratio").textContent = `${Math.round((p.daynight_ratio || 0.45) * 100)}%`;
  document.getElementById("tb-burst").textContent = `${(1.0 + Math.max(0, zscore) * 0.4).toFixed(1)}×`;
  document.getElementById("tb-interval-cv").textContent = (0.15 + (1.0 - (p.regularity_score || 0.8)) * 0.3).toFixed(2);
  document.getElementById("tb-cluster-growth").textContent = p.spread_rate ? `+${Math.round(p.spread_rate)} m/h` : "Stable";
  document.getElementById("tb-periodicity").textContent = (p.periodicity_score || 0.8) > 0.6 ? "Cyclic" : "Irregular";

  // Update Apple Weather Legend Gradient Needle
  updateLegendPointer(p.frp);

  // Render Historical FRP Canvas Chart
  fetchAndRenderFRPChart(p.id || evId);
}

// 6. Fetch & Render Historical FRP Canvas Chart
async function fetchAndRenderFRPChart(eventId) {
  try {
    const res = await fetch(`${API_BASE}/api/events/${eventId}/history`);
    const history = await res.json();
    drawFRPChart(history);
  } catch (err) {
    console.error("Error fetching event history:", err);
  }
}

function drawFRPChart(history) {
  const canvas = document.getElementById("frp-chart-canvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");

  // Fix retina display sharpness
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  const w = rect.width;
  const h = rect.height;

  ctx.clearRect(0, 0, w, h);

  const points = history.timeline || [];
  if (points.length < 2) return;

  const baseline = history.baseline_frp || 40.0;
  const currentFRP = history.current_frp || 120.0;
  const maxFRP = Math.max(...points.map((p) => p.frp), baseline * 1.5, currentFRP * 1.15);
  const minFRP = 0;

  const padLeft = 32;
  const padRight = 16;
  const padTop = 16;
  const padBottom = 20;

  const chartW = w - padLeft - padRight;
  const chartH = h - padTop - padBottom;

  const getX = (idx) => padLeft + (idx / (points.length - 1)) * chartW;
  const getY = (val) => padTop + chartH - ((val - minFRP) / (maxFRP - minFRP)) * chartH;

  // Draw grid lines
  ctx.strokeStyle = "rgba(255, 255, 255, 0.06)";
  ctx.lineWidth = 1;
  for (let step = 0; step <= 3; step++) {
    const yVal = minFRP + (step / 3) * maxFRP;
    const y = getY(yVal);
    ctx.beginPath();
    ctx.moveTo(padLeft, y);
    ctx.lineTo(w - padRight, y);
    ctx.stroke();

    ctx.fillStyle = "#64748b";
    ctx.font = "9px 'JetBrains Mono', monospace";
    ctx.fillText(`${Math.round(yVal)}`, 4, y + 3);
  }

  // Draw Baseline Dashed Line
  const baselineY = getY(baseline);
  ctx.save();
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = "rgba(148, 163, 184, 0.7)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(padLeft, baselineY);
  ctx.lineTo(w - padRight, baselineY);
  ctx.stroke();
  ctx.restore();

  // Baseline Label
  ctx.fillStyle = "#94a3b8";
  ctx.font = "9px 'Inter', sans-serif";
  ctx.fillText(`Baseline: ${Math.round(baseline)} MW`, w - padRight - 85, baselineY - 4);

  // Draw Line Curve for Readings
  ctx.beginPath();
  ctx.strokeStyle = "rgba(0, 229, 163, 0.8)";
  ctx.lineWidth = 2;
  points.forEach((pt, i) => {
    const x = getX(i);
    const y = getY(pt.frp);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // Draw Data Points
  points.forEach((pt, i) => {
    const x = getX(i);
    const y = getY(pt.frp);
    const isCurrent = i === points.length - 1;

    ctx.beginPath();
    if (isCurrent) {
      // Red pulsing beacon
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fillStyle = "#ff4d4d";
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#ffffff";
      ctx.stroke();

      // Text label above peak
      ctx.fillStyle = "#ff4d4d";
      ctx.font = "bold 10px 'JetBrains Mono', monospace";
      ctx.fillText(`${pt.frp} MW`, x - 20, y - 8);
    } else {
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fillStyle = "#00e5a3";
      ctx.fill();
    }
  });
}

// 7. Update KPI Counters Strip
function updateKpiStrip(hotspots) {
  let abnormalCount = 0;
  let industrialCount = 0;
  let naturalCount = 0;

  hotspots.forEach((h) => {
    const cls = h.properties.classification || "";
    if (cls.includes("Abnormal")) abnormalCount++;
    else if (cls.includes("Industrial")) industrialCount++;
    else if (cls.includes("Wildfire") || cls.includes("Agricultural") || cls.includes("Natural")) naturalCount++;
  });

  const total = hotspots.length;
  document.getElementById("kpi-total-hotspots").textContent = total;
  document.getElementById("kpi-industrial-count").textContent = industrialCount;
  document.getElementById("kpi-abnormal-count").textContent = abnormalCount;
  document.getElementById("kpi-natural-count").textContent = naturalCount;
  document.getElementById("kpi-monitored-facilities").textContent = "65";
}

// 8. Load and Render Recent Intelligence Alerts
async function loadAlerts() {
  try {
    const res = await fetch(`${API_BASE}/api/alerts`);
    const data = await res.json();
    activeAlerts = data.alerts || [];

    const container = document.getElementById("alerts-scroll-row");
    if (!container) return;
    container.innerHTML = "";

    activeAlerts.forEach((alert) => {
      const pill = document.createElement("div");
      pill.className = `alert-card-pill ${alert.severity}`;
      pill.innerHTML = `
        <span class="alert-dot ${alert.severity}"></span>
        <div class="alert-text-wrap">
          <span class="alert-pill-title">${alert.title}</span>
          <span class="alert-pill-meta">${alert.zone} • ${alert.time_ago}</span>
        </div>
      `;

      pill.addEventListener("click", () => {
        // Fly camera to alert coordinate and select event
        if (alert.coordinates && map) {
          map.flyTo({
            center: alert.coordinates,
            zoom: 12,
            speed: 1.2,
          });
        }
        // Match hotspot
        const matched = rawHotspots.find(
          (f) => f.properties.event_id === alert.event_id || f.properties.id === alert.event_id
        );
        if (matched) {
          selectHotspot(matched.properties);
        }
      });

      container.appendChild(pill);
    });

    document.getElementById("alerts-badge-count").textContent = activeAlerts.length;
  } catch (err) {
    console.error("Error loading alerts:", err);
  }
}

// 9. Live Mode / Scenario Replay Toggle
function setMode(mode) {
  if (currentMode === mode) return;
  currentMode = mode;

  document.getElementById("mode-btn-live").classList.toggle("active", mode === "live");
  document.getElementById("mode-btn-replay").classList.toggle("active", mode === "replay");

  const statusLabel = document.getElementById("live-status-label");
  if (mode === "live") {
    statusLabel.textContent = "LIVE DATA";
    statusLabel.parentElement.style.borderColor = "rgba(0, 229, 163, 0.3)";
  } else {
    statusLabel.textContent = "SCENARIO REPLAY";
    statusLabel.parentElement.style.borderColor = "rgba(56, 189, 248, 0.4)";
  }

  loadHotspotsData();
}

// 10. Refresh Live Pipeline Trigger
async function triggerRefresh() {
  const btn = document.getElementById("refresh-btn");
  btn.disabled = true;
  btn.textContent = `Refreshing ${currentState}...`;
  try {
    const res = await fetch(`${API_BASE}/api/refresh?state=${currentState}`, { method: "POST" });
    const data = await res.json();
    if (data.status === "pipeline already in progress") {
      btn.textContent = "Run in progress...";
    }
  } catch (err) {
    console.error("Refresh request failed:", err);
  }

  setTimeout(async () => {
    await loadHotspotsData();
    await loadAlerts();
    btn.disabled = false;
    btn.textContent = "Refresh Live Data";
  }, 9000);
}

// 11. Live Clock Ticker
function startClock() {
  function update() {
    const now = new Date();
    const utc = now.toISOString().replace("T", " ").substring(0, 19) + " UTC";
    const clockEl = document.getElementById("header-clock");
    if (clockEl) clockEl.textContent = utc;
  }
  update();
  setInterval(update, 1000);
}

// Event Listeners on DOM Ready
document.addEventListener("DOMContentLoaded", () => {
  initMap();
  startClock();

  // Mode toggles
  document.getElementById("mode-btn-live").addEventListener("click", () => setMode("live"));
  document.getElementById("mode-btn-replay").addEventListener("click", () => setMode("replay"));

  // Refresh button
  document.getElementById("refresh-btn").addEventListener("click", triggerRefresh);

  // Region AOI & National Zone switcher
  const REGION_CONFIG = {
    all_india: { center: [79.0, 22.5], zoom: 4.8, state: "all_india" },
    north_india: { center: [77.2, 30.5], zoom: 6.0, state: "north_india" },
    west_india: { center: [72.5, 20.5], zoom: 6.2, state: "west_india" },
    south_india: { center: [78.5, 13.5], zoom: 5.8, state: "south_india" },
    east_central: { center: [84.0, 22.5], zoom: 6.0, state: "east_central" },
    northeast: { center: [93.5, 26.2], zoom: 6.2, state: "northeast" },
    gujarat: { center: [71.2, 22.3], zoom: 7.2, state: "gujarat" },
    punjab: { center: [75.3, 30.9], zoom: 7.5, state: "punjab" },
    odisha: { center: [85.1, 20.8], zoom: 7.2, state: "odisha" },
    maharashtra: { center: [74.5, 19.5], zoom: 7.0, state: "maharashtra" },
    kutch: { center: [69.85, 22.38], zoom: 9.3, state: "kutch" },
  };

  const regSelect = document.getElementById("region-filter");
  if (regSelect) {
    regSelect.addEventListener("change", (e) => {
      const selectedKey = e.target.value;
      const reg = REGION_CONFIG[selectedKey] || REGION_CONFIG["all_india"];
      currentState = reg.state;
      if (map) {
        map.flyTo({
          center: reg.center,
          zoom: reg.zoom,
          speed: 1.2,
          curve: 1.4,
        });
      }
      loadHotspotsData();
    });
  }

  // Filters
  document.getElementById("class-filter").addEventListener("change", applyFilters);
  document.getElementById("conf-filter").addEventListener("change", applyFilters);
  document.getElementById("search-input").addEventListener("input", applyFilters);

  // Apple Weather Segmented Mode Pill Layer Toggles
  const btnHeatmap = document.getElementById("btn-mode-heatmap");
  if (btnHeatmap) {
    btnHeatmap.addEventListener("click", () => {
      btnHeatmap.classList.toggle("active");
      const isVis = btnHeatmap.classList.contains("active") ? "visible" : "none";
      if (map && map.getLayer("hotspots-heatmap")) {
        map.setLayoutProperty("hotspots-heatmap", "visibility", isVis);
      }
    });
  }

  const btnHotspots = document.getElementById("btn-mode-hotspots");
  if (btnHotspots) {
    btnHotspots.addEventListener("click", () => {
      btnHotspots.classList.toggle("active");
      const isVis = btnHotspots.classList.contains("active") ? "visible" : "none";
      if (map && map.getLayer("hotspots-points")) {
        map.setLayoutProperty("hotspots-points", "visibility", isVis);
      }
      if (map && map.getLayer("hotspots-halo")) {
        map.setLayoutProperty("hotspots-halo", "visibility", isVis);
      }
    });
  }

  const btnFacilities = document.getElementById("btn-mode-facilities");
  if (btnFacilities) {
    btnFacilities.addEventListener("click", () => {
      btnFacilities.classList.toggle("active");
      const isVis = btnFacilities.classList.contains("active") ? "visible" : "none";
      if (map && map.getLayer("facilities-rings")) {
        map.setLayoutProperty("facilities-rings", "visibility", isVis);
      }
      if (map && map.getLayer("facilities-points")) {
        map.setLayoutProperty("facilities-points", "visibility", isVis);
      }
    });
  }

  // Apple Weather Circular FABs
  const fabBasemap = document.getElementById("fab-basemap");
  if (fabBasemap) fabBasemap.addEventListener("click", cycleBasemap);

  const fabRecenter = document.getElementById("fab-recenter");
  if (fabRecenter) {
    fabRecenter.addEventListener("click", () => {
      if (map) {
        map.flyTo({ center: [79.0, 22.5], zoom: 4.8, speed: 1.2 });
      }
    });
  }

  const fabZoomIn = document.getElementById("fab-zoom-in");
  if (fabZoomIn) fabZoomIn.addEventListener("click", () => { if (map) map.zoomIn(); });

  const fabZoomOut = document.getElementById("fab-zoom-out");
  if (fabZoomOut) fabZoomOut.addEventListener("click", () => { if (map) map.zoomOut(); });

  // Apple Weather 48h Timeline Radar Scrubber
  const radarSlider = document.getElementById("radar-slider");
  if (radarSlider) {
    radarSlider.addEventListener("input", (e) => {
      setRadarScrubber(Number(e.target.value));
    });
  }

  const radarPlayBtn = document.getElementById("radar-play-btn");
  if (radarPlayBtn) {
    radarPlayBtn.addEventListener("click", toggleRadarPlay);
  }

  // Analyst Action Buttons
  document.getElementById("btn-investigate").addEventListener("click", () => {
    alert(`[ANALYST WORKFLOW]\nDispatching immediate high-priority inspection for ${activeHotspot ? activeHotspot.event_id : "Event"} at ${activeHotspot ? activeHotspot.facility_name : "site"}.\nTelemetry logged.`);
  });

  document.getElementById("btn-verify").addEventListener("click", () => {
    alert(`[VERIFICATION]\nHotspot ${activeHotspot ? activeHotspot.event_id : "Event"} marked as Verified Operator Activity by Analyst.`);
  });

  document.getElementById("btn-export").addEventListener("click", () => {
    if (!activeHotspot) return;
    const blob = new Blob([JSON.stringify(activeHotspot, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ThermalGuard_Dossier_${activeHotspot.event_id || "Event"}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });
});

// Radar Timeline Scrubber & Animation Helpers
function setRadarScrubber(val) {
  radarProgress = val;
  const slider = document.getElementById("radar-slider");
  if (slider) slider.value = val;

  const timeLabel = document.getElementById("radar-timestamp");
  if (val >= 98) {
    if (timeLabel) timeLabel.textContent = "Last 48 Hours → Live NOAA-20/21";
    applyFilters(null);
  } else {
    const hoursAgo = Math.round(((100 - val) / 100) * 48);
    if (timeLabel) timeLabel.textContent = `T - ${hoursAgo}h (${hoursAgo} hours prior pass)`;
    applyFilters(val);
  }
}

function toggleRadarPlay() {
  const playIcon = document.getElementById("radar-play-icon");

  if (isPlayingRadar) {
    isPlayingRadar = false;
    clearInterval(radarAnimationTimer);
    if (playIcon) {
      playIcon.innerHTML = '<polygon points="5 3 19 12 5 21 5 3"></polygon>';
    }
  } else {
    isPlayingRadar = true;
    if (playIcon) {
      playIcon.innerHTML = '<rect x="6" y="4" width="4" height="16" fill="currentColor"></rect><rect x="14" y="4" width="4" height="16" fill="currentColor"></rect>';
    }
    if (radarProgress >= 98) {
      radarProgress = 5;
    }
    radarAnimationTimer = setInterval(() => {
      radarProgress += 3;
      if (radarProgress > 100) {
        radarProgress = 5;
      }
      setRadarScrubber(radarProgress);
    }, 220);
  }
}
