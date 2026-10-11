/**
 * DEMO-MODE SAMPLE DATA  -  ILLUSTRATIVE ONLY
 * ------------------------------------------------------------
 * Everything in this file is invented for frontend demonstrations:
 * place names are real Delhi localities, but the coordinates are approximate and
 * every probability, incident count and report is made up. None of it is
 * real-time or official data and none of it comes from a trained model.
 *
 * The mock model is deterministic: the same input always gives the same output.
 * It returns objects shaped EXACTLY like the proposed FastAPI responses, so
 * api.js can use one code path for both demo and real data.
 */
import { haversine, hashNoise, levelFromProbability, splitIntoSegments, pathLength } from './utils.js';

// -------------------------------------------------------------- hotspots -----
export const SAMPLE_HOTSPOTS = [
  { id: 'h01', name: 'Minto Bridge underpass', latitude: 28.6385, longitude: 77.2195, risk_probability: 0.82, historical_incident_count: 14, radius_m: 650 },
  { id: 'h02', name: 'Pul Prahladpur underpass', latitude: 28.4975, longitude: 77.2925, risk_probability: 0.76, historical_incident_count: 11, radius_m: 800 },
  { id: 'h03', name: 'Azadpur Mandi area', latitude: 28.708, longitude: 77.175, risk_probability: 0.69, historical_incident_count: 9, radius_m: 750 },
  { id: 'h04', name: 'Mukarba Chowk', latitude: 28.7335, longitude: 77.169, risk_probability: 0.64, historical_incident_count: 6, radius_m: 700 },
  { id: 'h05', name: 'Moolchand underpass', latitude: 28.5645, longitude: 77.234, risk_probability: 0.58, historical_incident_count: 7, radius_m: 600 },
  { id: 'h06', name: 'Nizamuddin bridge approach', latitude: 28.5895, longitude: 77.2535, risk_probability: 0.55, historical_incident_count: 4, radius_m: 600 },
  { id: 'h07', name: 'Laxmi Nagar main road', latitude: 28.63, longitude: 77.2775, risk_probability: 0.52, historical_incident_count: 6, radius_m: 650 },
  { id: 'h08', name: 'ITO intersection', latitude: 28.6285, longitude: 77.2405, risk_probability: 0.47, historical_incident_count: 5, radius_m: 600 },
  { id: 'h09', name: 'Kashmere Gate ISBT', latitude: 28.667, longitude: 77.2285, risk_probability: 0.41, historical_incident_count: 4, radius_m: 600 },
  { id: 'h10', name: 'Dhaula Kuan', latitude: 28.5925, longitude: 77.1615, risk_probability: 0.31, historical_incident_count: 3, radius_m: 600 },
  { id: 'h11', name: 'Connaught Place outer circle', latitude: 28.6315, longitude: 77.2167, risk_probability: 0.22, historical_incident_count: 2, radius_m: 550 },
  { id: 'h12', name: 'Rohini Sector 7 area', latitude: 28.707, longitude: 77.115, risk_probability: 0.15, historical_incident_count: 1, radius_m: 600 },
  // Deliberately without a prediction, so the "unknown" state is visible in the demo.
  { id: 'h13', name: 'Dwarka Sector 21 area (no model data)', latitude: 28.5524, longitude: 77.0585, risk_probability: null, historical_incident_count: null, radius_m: 600 },
];

/** Hotspots in the same shape the backend's GET /hotspots would return. */
export function sampleHotspotsResponse() {
  return SAMPLE_HOTSPOTS.map((h) => ({
    ...h,
    risk_level: levelFromProbability(h.risk_probability),
    rainfall_context: 'Illustrative heavy-rain scenario (not observed rainfall)',
    data_status: 'example',
    data_timestamp: null, // static sample: there is no real timestamp
    source_type: 'model_predicted',
  }));
}

// --------------------------------------------------------------- reports -----
export const SAMPLE_REPORTS = [
  { id: 'r01', location: 'Minto Road underpass', latitude: 28.6385, longitude: 77.2195, observed_at: '2026-07-28T17:40:00+05:30', severity: 'high', status: 'verified', source: 'Sample municipal record', description: 'Sample entry: water reported at vehicle-axle height after heavy rain.' },
  { id: 'r02', location: 'Azadpur Mandi', latitude: 28.708, longitude: 77.175, observed_at: '2026-08-03T09:15:00+05:30', severity: 'moderate', status: 'unverified', source: 'Sample citizen report', description: 'Sample entry: slow-moving traffic through ponding on the service road.' },
  { id: 'r03', location: 'Pul Prahladpur underpass', latitude: 28.4975, longitude: 77.2925, observed_at: '2026-08-14T19:05:00+05:30', severity: 'high', status: 'verified', source: 'Sample traffic-police record', description: 'Sample entry: underpass closed to light vehicles for some hours.' },
  { id: 'r04', location: 'Laxmi Nagar', latitude: 28.63, longitude: 77.2775, observed_at: '2026-08-21T14:20:00+05:30', severity: 'low', status: 'unverified', source: 'Sample citizen report', description: 'Sample entry: shallow water near a market entrance.' },
  { id: 'r05', location: 'ITO intersection', latitude: 28.6285, longitude: 77.2405, observed_at: '2026-09-02T08:30:00+05:30', severity: 'moderate', status: 'verified', source: 'Sample municipal record', description: 'Sample entry: waterlogging on one carriageway; drain cleared later.' },
  { id: 'r06', location: 'Moolchand underpass', latitude: 28.5645, longitude: 77.234, observed_at: '2026-09-11T18:10:00+05:30', severity: 'moderate', status: 'unverified', source: 'Sample citizen report', description: 'Sample entry: water collecting at the underpass dip.' },
  { id: 'r07', location: 'Mukarba Chowk', latitude: 28.7335, longitude: 77.169, observed_at: '2025-07-30T16:00:00+05:30', severity: 'high', status: 'historical', source: 'Sample historical record', description: 'Sample entry: archived record of severe waterlogging on the GT Karnal Road stretch.' },
  { id: 'r08', location: 'Dhaula Kuan', latitude: 28.5925, longitude: 77.1615, observed_at: '2025-08-12T11:45:00+05:30', severity: 'low', status: 'historical', source: 'Sample historical record', description: 'Sample entry: archived record of minor ponding near the flyover ramp.' },
  { id: 'r09', location: 'Kashmere Gate ISBT', latitude: 28.667, longitude: 77.2285, observed_at: '2025-09-05T20:30:00+05:30', severity: 'moderate', status: 'historical', source: 'Sample historical record', description: 'Sample entry: archived record of water near the bus terminal exit.' },
];

// ---------------------------------------------------------- popular places ---
// Quick-pick suggestions so place search is usable even if the geocoder is down.
// Coordinates are approximate landmark positions.
export const POPULAR_PLACES = [
  { name: 'India Gate', label: 'India Gate, Delhi', lat: 28.6129, lng: 77.2295 },
  { name: 'Connaught Place', label: 'Connaught Place, New Delhi', lat: 28.6315, lng: 77.2167 },
  { name: 'Red Fort', label: 'Red Fort, Old Delhi', lat: 28.6562, lng: 77.241 },
  { name: 'New Delhi Railway Station', label: 'New Delhi Railway Station', lat: 28.6428, lng: 77.2197 },
  { name: 'IGI Airport (Terminal 3)', label: 'IGI Airport Terminal 3', lat: 28.5562, lng: 77.1 },
  { name: 'AIIMS Delhi', label: 'AIIMS, Ansari Nagar', lat: 28.5672, lng: 77.21 },
  { name: 'Saket', label: 'Saket, South Delhi', lat: 28.5245, lng: 77.2066 },
  { name: 'Nehru Place', label: 'Nehru Place, South Delhi', lat: 28.5491, lng: 77.253 },
  { name: 'Karol Bagh', label: 'Karol Bagh, Central Delhi', lat: 28.6519, lng: 77.1909 },
  { name: 'Lajpat Nagar', label: 'Lajpat Nagar, South Delhi', lat: 28.5677, lng: 77.2433 },
  { name: 'Dwarka Sector 21', label: 'Dwarka Sector 21 Metro', lat: 28.5524, lng: 77.0585 },
  { name: 'Rohini Sector 7', label: 'Rohini Sector 7, North-West Delhi', lat: 28.7041, lng: 77.1025 },
  { name: 'Azadpur', label: 'Azadpur, North Delhi', lat: 28.7075, lng: 77.1745 },
  { name: 'Anand Vihar', label: 'Anand Vihar ISBT, East Delhi', lat: 28.6469, lng: 77.316 },
  { name: 'Laxmi Nagar', label: 'Laxmi Nagar, East Delhi', lat: 28.6304, lng: 77.2773 },
  { name: 'Kashmere Gate', label: 'Kashmere Gate ISBT', lat: 28.6675, lng: 77.2284 },
  { name: 'Hauz Khas', label: 'Hauz Khas, South Delhi', lat: 28.5494, lng: 77.2001 },
  { name: 'Vasant Kunj', label: 'Vasant Kunj, South-West Delhi', lat: 28.5198, lng: 77.1569 },
];

// ------------------------------------------------------------ mock model -----
/** Mock risk score (0-1) at a point: a low baseline plus influence from nearby sample hotspots. */
export function mockProbabilityAt(lat, lng) {
  let p = 0.05 + hashNoise(lat, lng) * 0.07;
  for (const h of SAMPLE_HOTSPOTS) {
    if (h.risk_probability === null) continue;
    const d = haversine([lat, lng], [h.latitude, h.longitude]);
    const influence = Math.exp(-Math.pow(d / (h.radius_m * 1.2), 2));
    p = Math.max(p, h.risk_probability * influence);
  }
  return Math.min(0.99, p);
}

export function nearestHotspot(lat, lng, maxDistM = 900) {
  let best = null;
  for (const h of SAMPLE_HOTSPOTS) {
    const d = haversine([lat, lng], [h.latitude, h.longitude]);
    if (d <= maxDistM && (!best || d < best.distance)) best = { hotspot: h, distance: d };
  }
  return best;
}

/** Same shape as the proposed POST /predict response (plus optional fields we don't invent). */
export function mockPredict(lat, lng) {
  const p = mockProbabilityAt(lat, lng);
  const near = nearestHotspot(lat, lng);
  return {
    risk_level: levelFromProbability(p),
    risk_probability: Math.round(p * 100) / 100,
    risk_probability_calibrated: false,
    prediction_timestamp: new Date().toISOString(),
    data_status: 'example',
    historical_hotspot: near && near.hotspot.historical_incident_count !== null
      ? { name: near.hotspot.name, incident_count: near.hotspot.historical_incident_count }
      : null,
    // Rainfall, terrain and drain distance are intentionally left out:
    // the demo must not invent them. The UI shows "Not available".
  };
}

/**
 * Same shape as the proposed POST /route-risk response.
 * Demo rules (NOT a real model):
 *  - each ~400 m chunk gets the highest mock score at its start / middle / end
 *  - neighbouring chunks with the same level are merged into one risk segment
 *  - overall: high if >=10% of the route is high-risk; moderate if any high-risk
 *    or >=20% moderate; otherwise low.
 */
export function mockRouteRisk(payload) {
  const routes = (payload.routes || []).map((route) => {
    const coords = route.geometry?.coordinates || [];
    const chunks = splitIntoSegments(coords, 400).map((seg) => {
      const pts = [seg[0], seg[Math.floor(seg.length / 2)], seg[seg.length - 1]];
      const p = Math.max(...pts.map(([lng, lat]) => mockProbabilityAt(lat, lng)));
      const len = pathLength(seg.map(([lng, lat]) => [lat, lng]));
      return { coordinates: seg, p, len, level: levelFromProbability(p) };
    });

    // merge runs of the same level
    const merged = [];
    for (const c of chunks) {
      const last = merged[merged.length - 1];
      if (last && last.level === c.level) {
        last.coordinates.push(...c.coordinates.slice(1));
        last.weighted += c.p * c.len;
        last.len += c.len;
      } else {
        merged.push({ coordinates: [...c.coordinates], level: c.level, weighted: c.p * c.len, len: c.len });
      }
    }

    const total = merged.reduce((s, m) => s + m.len, 0) || 1;
    const highLen = merged.filter((m) => m.level === 'high').reduce((s, m) => s + m.len, 0);
    const modLen = merged.filter((m) => m.level === 'moderate').reduce((s, m) => s + m.len, 0);
    const avg = merged.reduce((s, m) => s + m.weighted, 0) / total;
    let overall = 'low';
    if (highLen / total >= 0.1) overall = 'high';
    else if (highLen > 0 || modLen / total >= 0.2) overall = 'moderate';

    return {
      route_id: route.route_id,
      overall_risk: merged.length ? overall : 'unknown',
      average_risk_probability: merged.length ? Math.round(avg * 100) / 100 : null,
      high_risk_segment_count: merged.filter((m) => m.level === 'high').length,
      high_risk_distance_m: Math.round(highLen),
      risk_segments: merged.map((m) => ({
        coordinates: m.coordinates,
        risk_level: m.level,
        risk_probability: Math.round((m.weighted / m.len) * 100) / 100,
        // sample hotspot near the middle of the segment, if any (illustrative)
        historical_hotspot: (() => {
          const mid = m.coordinates[Math.floor(m.coordinates.length / 2)];
          const near = nearestHotspot(mid[1], mid[0], 700);
          return near && near.hotspot.historical_incident_count ? { name: near.hotspot.name, incident_count: near.hotspot.historical_incident_count } : null;
        })(),
      })),
      risk_probability_calibrated: false,
      prediction_timestamp: new Date().toISOString(),
      data_status: 'example',
    };
  });
  return { routes };
}
