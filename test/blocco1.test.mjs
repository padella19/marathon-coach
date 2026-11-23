import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../public/lib/engine.js';
import { zonesFromAthlete, normalize } from '../src/intervals.js';
import { validateSettings } from '../src/index.js';

const athlete7 = { sportSettings: [{ types: ['Ride'], hr_zones: [120, 140, 150, 160, 170] }, { types: ['Run', 'TrailRun'], hr_zones: [137, 151, 158, 167, 172, 177, 190], max_hr: 190, lthr: 168 }] };

test('zone FC della corsa da intervals.icu (7 zone ridotte a 5)', () => {
  const z = zonesFromAthlete(athlete7);
  assert.equal(z.zones.length, 5);
  assert.deepEqual(z.zones.map((x) => x.hi), [137, 151, 158, 167, 190]);
  assert.equal(z.zones[1].lo, 137); // contigue
  assert.equal(zonesFromAthlete({ sportSettings: [{ types: ['Run'], hr_zones: [140, 150] }] }), null);
});

test('hrProfile usa le zone di intervals.icu quando ci sono', () => {
  const s = { ...E.DEFAULT_SETTINGS, hrZones: zonesFromAthlete(athlete7) };
  const h = E.hrProfile(s);
  assert.equal(h.src, 'intervals.icu'); assert.equal(h.max, 190);
  assert.equal(E.zoneOf(145, h), 2); assert.equal(E.zoneOf(185, h), 5);
  assert.equal(E.hrProfile(E.DEFAULT_SETTINGS).src, 'provvisoria');
});

test('tempo nelle zone di intervals.icu (secondi oltre Z4 sommati in Z5)', () => {
  const a = normalize({ id: 1, start_date_local: '2027-03-14T08:00:00', type: 'Run', distance: 10000, moving_time: 3600, average_heartrate: 145, icu_hr_zone_times: [600, 2400, 400, 100, 50, 30, 20] });
  assert.deepEqual(a.zone_secs, [600, 2400, 400, 100, 100]);
  const hIv = E.hrProfile({ ...E.DEFAULT_SETTINGS, hrZones: zonesFromAthlete(athlete7) });
  assert.deepEqual(E.zoneSeconds(a, hIv), [600, 2400, 400, 100, 100]);
  // con zone calcolate dalla dashboard non si mescolano i due sistemi
  const own = E.zoneSeconds(a, E.hrProfile({ ...E.DEFAULT_SETTINGS, age: 45 }));
  assert.equal(own.reduce((x, y) => x + y, 0), 3600);
});

test('gara predefinita: Francoforte, 31/10/2027', () => {
  assert.equal(E.DEFAULT_SETTINGS.raceName, 'Maratona di Francoforte');
  assert.equal(E.DEFAULT_SETTINGS.raceDate, '2027-10-31');
});

test('impostazioni: inizio preparazione e data gara', () => {
  const cur = { planStart: '2026-12-10', raceDate: '2027-10-31' };
  assert.deepEqual(validateSettings({ planStart: '2026-11-16' }, cur).patch, { planStart: '2026-11-16' });
  assert.match(validateSettings({ planStart: '2027-05-01' }, cur).error, /almeno 36 settimane/);
  assert.match(validateSettings({ raceDate: '2028-12-31' }, cur).error, /al massimo 70/);
  assert.match(validateSettings({ planStart: '16/11/2026' }, cur).error, /data non valida/);
  assert.equal(validateSettings({ foo: 1, planSource: 'x' }, cur).patch.foo, undefined);
});

test('piano generato con una data di inizio anticipata: fasi coerenti', () => {
  const s = { ...E.DEFAULT_SETTINGS, planStart: '2026-11-16' };
  const plan = E.generatePlan(s);
  assert.equal(plan[0].date >= '2026-11-16', true);
  assert.equal(plan.at(-1).date, '2027-10-31');
  assert.equal(E.phaseAt('2026-11-17', s).id, 'cond');
  assert.equal(E.phaseAt('2027-10-20', s).id, 'taper');
});
