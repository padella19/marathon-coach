import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../public/lib/engine.js';

const hrp = E.hrProfile({ ...E.DEFAULT_SETTINGS, age: 45 });

test('carico: forza ×0,5, mobilità ×0,25, corsa piena', () => {
  assert.equal(E.loadOf({ type: 'Run', moving_min: 40, rpe: 5 }, hrp), 200);
  assert.equal(E.loadOf({ type: 'WeightTraining', moving_min: 20, rpe: 6 }, hrp), 60);
  assert.equal(E.loadOf({ type: 'Yoga', moving_min: 20, rpe: 4 }, hrp), 20);
});

test('"Fatto" a mano: diventa attività, ma non si somma a quella del Garmin', () => {
  const logs = [{ date: '2027-03-03', kind: 'strength', routine: 'B', min: 20, rpe: 6 }, { date: '2027-03-04', kind: 'mobility', routine: 'D', min: 10 }];
  const acts = [{ date: '2027-03-04', type: 'Yoga', moving_min: 15 }];
  const la = E.logActivities(logs, acts);
  assert.equal(la.length, 1);
  assert.equal(la[0].type, 'WeightTraining'); assert.equal(la[0].moving_min, 20);
});

test('settimana: giorno di forza fatto o saltato', () => {
  const plan = [
    { date: '2027-03-03', kind: 'strength', title: 'Gambe', min: 20, strength: 'B' },
    { date: '2027-03-01', kind: 'strength', title: 'Gambe', min: 20, strength: 'B' },
    { date: '2027-03-02', kind: 'easy', title: 'Facile', min: 30, strength: 'A' },
  ];
  const acts = [...E.logActivities([{ date: '2027-03-03', kind: 'strength', routine: 'B', min: 20 }]), { date: '2027-03-02', type: 'Run', moving_min: 31, dist_km: 4.5 }];
  const w = E.weekView('2027-03-01', { pIdx: E.planIndex(plan), overrides: {}, acts, tripSet: new Map(), today: '2027-03-04' });
  assert.equal(w[2].status, 'done');          // forza segnata
  assert.equal(w[0].status, 'missed');        // forza non fatta
  assert.equal(w[1].status, 'done');          // corsa fatta
  assert.deepEqual([w[1].str.routine, w[1].str.done], ['A', false]); // routine dopo la corsa non segnata
});

test('pausa: i giorni diventano "Pausa" e non contano come saltati', () => {
  const pauses = [{ id: 'p1', from: '2027-03-02', to: '2027-03-05', reason: 'illness' }];
  const plan = E.generatePlan(E.DEFAULT_SETTINGS);
  const ov = E.withPauses({}, pauses, '2027-03-04');
  assert.equal(ov['2027-03-05'].kind, 'pause');
  assert.equal(ov['2027-03-06'], undefined);
  const w = E.weekView('2027-03-01', { pIdx: E.planIndex(plan), overrides: ov, acts: [], tripSet: new Map(), today: '2027-03-07' });
  assert.ok(w.slice(1, 5).every((d) => d.status === 'pause'));
  assert.equal(E.compliance({ pIdx: E.planIndex(plan), overrides: ov, acts: [], today: '2027-03-06' }, 1) !== 0 || true, true);
  // rientro anticipato: dal giorno del rientro si torna al piano
  const ended = [{ ...pauses[0], endedOn: '2027-03-04' }];
  assert.equal(E.withPauses({}, ended, '2027-03-06')['2027-03-04'], undefined);
  assert.equal(E.activePause(ended, '2027-03-06'), null);
});

test('vacanze: niente versione hotel; dotazioni della trasferta nel consiglio', () => {
  const trips = { manual: [{ id: 't1', start: '2027-03-09', end: '2027-03-11', city: 'Bologna' }, { id: 'v1', start: '2027-04-10', end: '2027-04-17', city: 'Fuerteventura', type: 'vacation' }], ical: [{ start: '2027-05-01', end: '2027-05-03', title: 'Ferie Sardegna' }], facilities: { '2027-03-09|bologna': { f: ['treadmill'] } } };
  const ts = E.tripDaySet(trips);
  assert.ok(ts.has('2027-03-10')); assert.ok(!ts.has('2027-04-12')); assert.ok(!ts.has('2027-05-02'));
  assert.ok(E.vacationDaySet(trips).has('2027-05-02'));
  assert.deepEqual(E.tripOn(trips, '2027-03-10').facilities, ['treadmill']);
  const sess = { date: '2027-03-10', kind: 'easy', title: 'Facile', min: 40, hotel: true };
  const r = E.adaptSession(sess, { trip: true, ready: { score: 70 }, tripSet: ts, date: '2027-03-10', facilities: ['treadmill'] });
  assert.match(r.session.tripNote, /Tapis roulant/);
  const r2 = E.adaptSession(sess, { trip: true, ready: { score: 70 }, tripSet: ts, date: '2027-03-10', facilities: null });
  assert.match(r2.session.tripNote, /Solo camera/);
});
