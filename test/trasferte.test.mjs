import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../public/lib/engine.js';
import { bestMatch, resolveTripPlace } from '../src/geo.js';
import { pickHours } from '../src/jose.js';

// Geocodifica finta: solo i nomi di città veri danno risultati (con omonimi all'estero)
const DB = {
  firenze: [{ name: 'Firenze', latitude: 43.77, longitude: 11.25, country_code: 'IT', feature_code: 'PPLA', population: 380000 }],
  mantova: [{ name: 'Mantova', latitude: 45.16, longitude: 10.79, country_code: 'IT', feature_code: 'PPLA2', population: 49000 }],
  lodi: [{ name: 'Lodi', latitude: 38.13, longitude: -121.27, country_code: 'US', feature_code: 'PPL', population: 62000 }, { name: 'Lodi', latitude: 45.31, longitude: 9.5, country_code: 'IT', feature_code: 'PPLA2', population: 45000 }],
  lugano: [{ name: 'Lugano', latitude: 46.0, longitude: 8.95, country_code: 'CH', feature_code: 'PPLA2', population: 63000 }],
  ravenna: [{ name: 'Ravenna', latitude: 44.42, longitude: 12.2, country_code: 'IT', feature_code: 'PPLA2', population: 158000 }],
  verona: [{ name: 'Verona', latitude: 45.44, longitude: 10.99, country_code: 'IT', feature_code: 'PPLA2', population: 257000 }],
  'reggio emilia': [{ name: 'Reggio Emilia', latitude: 44.7, longitude: 10.63, country_code: 'IT', feature_code: 'PPLA2', population: 170000 }],
  campo: [{ name: 'Campo', latitude: 1, longitude: 1, country_code: 'ES', feature_code: 'PPL', population: 300 }],
  marte: [{ name: 'Marte', latitude: 2, longitude: 2, country_code: 'IT', feature_code: 'PPL', population: 10 }],
};
let calls = 0;
globalThis.fetch = async (url) => { calls++; const n = decodeURIComponent(new URL(url).searchParams.get('name')).toLowerCase(); return { ok: true, json: async () => ({ results: DB[n] || [{ name: n + ' fuffa', latitude: 0, longitude: 0, country_code: 'US' }] }) }; };

const city = async (title, loc = '') => (await resolveTripPlace(title, loc, {}, { left: 99 }))?.city ?? null;

test('città dal titolo del calendario', async () => {
  assert.equal(await city('My English School Firenze Campo di Marte'), 'Firenze');
  assert.equal(await city('My English School Mantova'), 'Mantova');
  assert.equal(await city('Visita a Lodi'), 'Lodi');
  assert.equal(await city('MY ENGLISH SCHOOL LUGANO'), 'Lugano');
  assert.equal(await city('MyES Reggio Emilia - visita'), 'Reggio Emilia');
  assert.equal(await city('MONDAY MEETING @ Master'), null); // nessuna città: il meteo resta su casa
});
test('città dal campo Luogo (indirizzo con CAP) prima del titolo', async () => {
  assert.equal(await city('Visita sede', 'My English School, Viale dei Mille 12, 50131 Firenze FI, Italia'), 'Firenze');
  assert.equal(await city('Giro scuole', 'Ravenna, RA'), 'Ravenna');
});
test('omonimi: vince la città italiana', () => {
  const g = bestMatch(DB.lodi, 'Lodi'); assert.equal(g.cc, 'IT'); assert.equal(g.lat, 45.31);
  assert.equal(bestMatch(DB.firenze, 'Firenze Campo'), null);
});
test('trasferte sempre in ordine di data e senza doppioni', () => {
  const trips = { manual: [], ical: [
    { start: '2026-12-09', end: '2026-12-09', city: 'Lugano', title: 'MY ENGLISH SCHOOL LUGANO', source: 'ical' },
    { start: '2026-11-26', end: '2026-11-26', city: 'Lodi', title: 'Visita a Lodi', source: 'ical' },
    { start: '2026-11-25', end: '2026-11-25', city: 'Mantova', title: 'My English School Mantova', source: 'ical' },
    { start: '2026-12-01', end: '2026-12-01', city: 'MONDAY MEETING @ Master', title: 'MONDAY MEETING @ Master', source: 'ical' },
    { start: '2026-11-24', end: '2026-11-24', city: 'Firenze', title: 'My English School Firenze Campo di Marte', source: 'ical' },
    { start: '2026-12-01', end: '2026-12-01', city: 'MONDAY MEETING @ Master', title: 'MONDAY MEETING @ Master', source: 'ical' },
  ] };
  const all = E.allTrips(trips);
  assert.deepEqual(all.map((t) => t.start), ['2026-11-24', '2026-11-25', '2026-11-26', '2026-12-01', '2026-12-09']);
  assert.equal(E.tripName(all[0]), 'Firenze'); assert.equal(E.tripDetail(all[0]), 'My English School Firenze Campo di Marte');
  const next = all.find((x) => x.start >= '2026-11-23' && x.start <= '2026-11-25' && !x.facilities);
  assert.equal(next.city, 'Firenze');
  assert.equal(E.tripOn(trips, '2026-11-24').city, 'Firenze');
});
test('meteo: giornata completa con condizioni, min/max e ore', () => {
  const time = [], t = [], f = [], pr = [], mm = [], w = [], c = [];
  for (let h = 0; h < 24; h++) { time.push(`2026-11-24T${String(h).padStart(2, '0')}:00`); t.push(5 + (h > 10 && h < 17 ? 6 : 0)); f.push(3 + (h > 10 && h < 17 ? 6 : 0)); pr.push(h > 18 ? 60 : 0); mm.push(0); w.push(5); c.push(h > 18 ? 61 : 0); }
  const daily = { time: ['2026-11-24'], temperature_2m_min: [4], temperature_2m_max: [11], precipitation_sum: [1.2], precipitation_probability_max: [60], weather_code: [61] };
  const d = pickHours({ time, temperature_2m: t, apparent_temperature: f, precipitation_probability: pr, precipitation: mm, wind_speed_10m: w, weather_code: c }, '2026-11-24', 7, 5, daily);
  assert.equal(d.cond, 'sereno'); assert.equal(d.day.min, 4); assert.equal(d.day.max, 11); assert.equal(d.day.cond, 'pioggia debole');
  assert.equal(d.hours.length, 17); assert.equal(d.best.hour, 11);
});
