// Trasferte: lette dagli URL iCal segreti dei calendari (Google Calendar → Impostazioni → "Indirizzo segreto in formato iCal")
// Ogni evento diventa { start, end, city, title, lat, lon }: la città viene dal campo Luogo o dal titolo
// (es. "My English School Firenze Campo di Marte" → Firenze), verificata con la geocodifica.
import { get, put, getSettings } from './store.js';
import { parseICS, addDays, todayISO, isVacationTitle, placeKey } from '../public/lib/engine.js';
import { resolveTripPlace } from './geo.js';

export async function refreshTrips(env) {
  const s = await getSettings(env);
  const urls = String(s.icalUrls || '').split(/\s+/).filter((u) => /^https:\/\//.test(u));
  const trips = await get(env, 'trips', { manual: [], ical: [] });
  if (!urls.length) { trips.ical = []; await put(env, 'trips', trips); return trips; }
  const from = addDays(todayISO(), -45), to = addDays(todayISO(), 120);
  const [geo, known] = await Promise.all([get(env, 'geo2', {}), get(env, 'trip_places', {})]);
  const geoN = Object.keys(geo).length, knownN = Object.keys(known).length;
  const budget = { left: 15 }; // limite di richieste per giro (Workers gratuiti: 50 sottorichieste); il resto al giro dopo
  const ical = [], errors = [], seen = new Set();
  for (const u of urls) {
    try {
      const r = await fetch(u, { headers: { 'user-agent': 'marathon-coach/1.0' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      for (const e of parseICS(await r.text())) {
        if (e.end < from || e.start > to) continue;
        const dup = `${e.start}|${e.end}|${placeKey(e.title)}`;
        if (seen.has(dup)) continue;
        seen.add(dup);
        const pk = placeKey(`${e.title}|${e.location || ''}`);
        let place = known[pk];
        if (place === undefined) {
          place = await resolveTripPlace(e.title, e.location, geo, budget).catch(() => undefined);
          if (place !== undefined) known[pk] = place; // null = nessuna città riconosciuta (si usa casa per il meteo)
        }
        ical.push({
          start: e.start, end: e.end, title: e.title, source: 'ical', type: isVacationTitle(e.title) ? 'vacation' : 'work',
          city: place?.city || e.location?.split(',')[0]?.trim() || e.title,
          ...(place ? { lat: place.lat, lon: place.lon, cc: place.cc } : {}),
          ...(e.location ? { location: e.location } : {}),
        });
      }
    } catch (e) { errors.push(e.message); }
  }
  ical.sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
  trips.ical = ical;
  trips.icalUpdated = Date.now();
  trips.icalErrors = errors;
  await put(env, 'trips', trips);
  if (Object.keys(geo).length !== geoN) await put(env, 'geo2', geo);
  if (Object.keys(known).length !== knownN) await put(env, 'trip_places', known);
  return trips;
}
