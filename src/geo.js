// Geocodifica (Open-Meteo, gratis e senza chiave) con cache nel KV.
// Regole per non sbagliare città: il nome trovato deve coincidere con quello cercato,
// si preferiscono i centri abitati in Italia/Svizzera/San Marino e poi i più popolosi.
import { placeKey, tripPlaceCandidates } from '../public/lib/engine.js';

const GEO = 'https://geocoding-api.open-meteo.com/v1/search';
const PREF = ['IT', 'CH', 'SM', 'VA'];

export function bestMatch(results, name) {
  const k = placeKey(name);
  const ok = (results || []).filter((r) => r && placeKey(r.name) === k && r.latitude != null);
  if (!ok.length) return null;
  const rank = (r) => [PREF.includes(r.country_code) ? 0 : 1, /^PPL/.test(r.feature_code || '') ? 0 : /^(ISL|ADM)/.test(r.feature_code || '') ? 1 : 2, -(r.population || 0)];
  ok.sort((a, b) => { const x = rank(a), y = rank(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; });
  const g = ok[0];
  return { lat: g.latitude, lon: g.longitude, name: g.name, cc: g.country_code || null };
}

// cache: oggetto { chiave: {lat,lon,name,cc} | false } (false = cercato e non trovato)
export async function geocode(name, cache, budget = { left: Infinity }) {
  const k = placeKey(name);
  if (!k) return null;
  if (k in cache) return cache[k] || null;
  if (budget.left <= 0) return undefined; // non cercato ora: si riprova al prossimo giro
  budget.left--;
  const r = await fetch(`${GEO}?name=${encodeURIComponent(name)}&count=10&language=it&format=json`);
  if (!r.ok) throw new Error(`geocodifica ${r.status}`);
  const hit = bestMatch((await r.json()).results, name);
  cache[k] = hit || false;
  return hit;
}

// Città di un evento del calendario: primo candidato che la geocodifica riconosce
export async function resolveTripPlace(title, location, cache, budget) {
  let pending = false;
  for (const c of tripPlaceCandidates(title, location)) {
    const g = await geocode(c, cache, budget);
    if (g === undefined) { pending = true; break; }
    if (g) return { city: g.name, lat: g.lat, lon: g.lon, cc: g.cc };
  }
  return pending ? undefined : null;
}
