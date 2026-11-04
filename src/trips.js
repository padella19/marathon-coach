// Trasferte: lette dagli URL iCal segreti dei calendari (Google Calendar → Impostazioni → "Indirizzo segreto in formato iCal")
import { get, put, getSettings } from './store.js';
import { parseICS, addDays, todayISO } from '../public/lib/engine.js';

export async function refreshTrips(env) {
  const s = await getSettings(env);
  const urls = String(s.icalUrls || '').split(/\s+/).filter((u) => /^https:\/\//.test(u));
  const trips = await get(env, 'trips', { manual: [], ical: [] });
  if (!urls.length) { trips.ical = []; await put(env, 'trips', trips); return trips; }
  const from = addDays(todayISO(), -45), to = addDays(todayISO(), 120);
  const ical = [], errors = [];
  for (const u of urls) {
    try {
      const r = await fetch(u, { headers: { 'user-agent': 'marathon-coach/1.0' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      for (const e of parseICS(await r.text())) {
        if (e.end < from || e.start > to) continue;
        ical.push({ start: e.start, end: e.end, city: e.location?.split(',')[0] || e.title, title: e.title, source: 'ical' });
      }
    } catch (e) { errors.push(e.message); }
  }
  trips.ical = ical;
  trips.icalUpdated = Date.now();
  trips.icalErrors = errors;
  await put(env, 'trips', trips);
  return trips;
}
