import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../public/lib/engine.js';

const settings = { ...E.DEFAULT_SETTINGS };
const today = '2027-03-16'; // martedì, fase base
const plan = E.generatePlan(settings);
// 3 settimane di corse regolari: ~150'/settimana, lungo max 70'
function history() {
  const acts = []; let id = 1;
  for (let d = E.addDays(today, -21); d <= today; d = E.addDays(d, 1)) {
    const w = E.dow(d);
    const min = w === 0 ? 70 : [2, 4, 6].includes(w) ? 27 : 0;
    if (min) acts.push({ id: id++, date: d, type: 'Run', moving_min: min, dist_km: min / 7, avg_hr: 140, pace_s: 420 });
  }
  return acts;
}
const base = () => ({ today, plan, overrides: {}, acts: history(), checkins: {}, tripSet: new Map(), settings });
const sess = (date, kind, min, extra = {}) => ({ date, kind, title: kind, min, rpe: '4', zone: 'Z2', desc: '', ...extra });
const week = (mon, spec) => spec.map(([i, k, m]) => sess(E.addDays(mon, i), k, m));
const nextMon = E.addDays(E.mondayOf(today), 7);

test('volume settimanale: massimo +12% (o quanto già previsto dal piano)', () => {
  const p = week(nextMon, [[0, 'rest', 0], [1, 'easy', 90], [2, 'easy', 90], [3, 'quality', 90], [4, 'easy', 90], [5, 'easy', 90], [6, 'long', 80]]);
  const r = E.validatePlan(p, base());
  const tot = r.sessions.reduce((t, s) => t + E.runMinutes(s), 0);
  const oldWeek = [0, 1, 2, 3, 4, 5, 6].reduce((t, i) => t + E.runMinutes(E.planIndex(plan)[E.addDays(nextMon, i)]), 0);
  assert.ok(tot <= Math.max(150 * 1.12, oldWeek) + 5, `totale ${tot}`);
  assert.ok(r.corrections.some((c) => c.includes('volume')));
});

test('lungo: massimo +10 minuti sul più lungo recente', () => {
  const r = E.validatePlan([sess(E.addDays(nextMon, 6), 'long', 130)], base());
  const oldLong = E.planIndex(plan)[E.addDays(nextMon, 6)];
  assert.ok(r.sessions[0].min <= Math.max(80, oldLong?.min || 0), `lungo ${r.sessions[0].min}`);
});

test('qualità: massimo 2 a settimana e mai consecutive', () => {
  const p = week(nextMon, [[0, 'rest', 0], [1, 'quality', 30], [2, 'quality', 30], [4, 'quality', 30], [5, 'quality', 30]]);
  const r = E.validatePlan(p, base());
  const q = r.sessions.filter((s) => s.kind === 'quality');
  assert.ok(q.length <= 2);
  for (let i = 1; i < q.length; i++) assert.ok(E.diffDays(q[i - 1].date, q[i].date) > 1);
});

test('almeno un giorno di riposo a settimana', () => {
  const p = week(nextMon, [[0, 'easy', 20], [1, 'easy', 20], [2, 'easy', 20], [3, 'easy', 20], [4, 'easy', 20], [5, 'easy', 20], [6, 'long', 60]]);
  const r = E.validatePlan(p, base());
  assert.ok(r.sessions.some((s) => s.kind === 'rest'));
});

test('fastidio ≥5: nessun aumento e niente qualità', () => {
  const ctx = base(); ctx.checkins = { [today]: { date: today, pain: { area: 'polpaccio', level: 6 } } };
  const d = E.addDays(today, 2); const old = E.planIndex(plan)[d];
  const r = E.validatePlan([sess(d, 'quality', (old?.min || 30) + 30)], ctx);
  assert.notEqual(r.sessions[0].kind, 'quality');
  assert.ok(r.sessions[0].min <= (old?.min || 0));
});

test('trasferta: niente lungo, versione hotel', () => {
  const ctx = base(); const d = E.addDays(nextMon, 6); ctx.tripSet = new Map([[d, 'Bologna']]);
  const r = E.validatePlan([sess(d, 'long', 70, { hotel: false })], ctx);
  assert.equal(r.sessions[0].kind, 'easy'); assert.equal(r.sessions[0].hotel, true);
});

test('fuori periodo e gara: ignorati', () => {
  const r = E.validatePlan([sess(today, 'easy', 30), sess(E.addDays(today, 60), 'easy', 30), sess(settings.raceDate, 'easy', 30)], base());
  assert.equal(r.sessions.length, 0);
});

test('scarico finale: solo riduzioni', () => {
  const t = E.addDays(settings.raceDate, -24);
  const ctx = { ...base(), today: t };
  const d = E.addDays(settings.raceDate, -10); const old = E.planIndex(plan)[d];
  const r = E.validatePlan([sess(d, 'long', 200)], ctx);
  assert.ok(E.runMinutes(r.sessions[0]) <= E.runMinutes(old) + 0.01);
});

test('check-up: dopo 8 allenamenti', () => {
  const acts = history();
  const t = E.reviewTrigger({ today, acts, plan, settings, review: {}, m: E.computeMetrics(acts, settings, today) });
  assert.equal(t.stage, 'ask'); assert.ok(t.runsSince >= 8);
});

test('check-up: pausa di 5 giorni, ma il fastidio la scavalca', () => {
  const acts = history();
  const review = { lastReviewAt: Date.parse(E.addDays(today, -2) + 'T08:00:00Z'), lastPhase: 'base' };
  const m = E.computeMetrics(acts, settings, today);
  assert.equal(E.reviewTrigger({ today, acts, plan, settings, review, m }).stage, 'none');
  const checkins = { [E.addDays(today, -1)]: { date: E.addDays(today, -1), pain: { area: 'Ginocchio', level: 4 } }, [today]: { date: today, pain: { area: 'ginocchio', level: 5 } } };
  assert.equal(E.reviewTrigger({ today, acts, plan, settings, review, m, checkins }).stage, 'ask');
});

test('check-up: domande in attesa, poi scadenza a 72 ore', () => {
  const r1 = E.reviewTrigger({ today, acts: [], plan, settings, review: { status: 'questions', askedAt: Date.now() - 3.6e6 } });
  assert.equal(r1.stage, 'waiting_answers');
  const r2 = E.reviewTrigger({ today, acts: [], plan, settings, review: { status: 'questions', askedAt: Date.now() - 80 * 3.6e6 } });
  assert.equal(r2.stage, 'apply_no_answers');
  const r3 = E.reviewTrigger({ today, acts: [], plan, settings, review: { status: 'questions', askedAt: Date.now(), answeredAt: Date.now() } });
  assert.equal(r3.stage, 'apply');
});

// ---------------------------------------------------------------- Blocco 3: aggiunte
test('rientro da una pausa ≥7 giorni: volume al massimo 70% di prima per 2 settimane', () => {
  const ctx = base();
  ctx.pauses = [{ id: 'p', from: E.addDays(today, -9), endedOn: E.addDays(today, -1), reason: 'illness' }];
  ctx.acts = history().filter((a) => a.date < E.addDays(today, -9));
  const p = week(nextMon, [[0, 'rest', 0], [1, 'easy', 40], [2, 'easy', 40], [3, 'quality', 45], [5, 'easy', 40], [6, 'long', 60]]);
  const r = E.validatePlan(p, ctx);
  const tot = r.sessions.reduce((t, s) => t + E.runMinutes(s), 0);
  assert.ok(tot <= 150 * 0.7 + 5, `totale ${tot}`);
  assert.ok(r.corrections.some((c) => c.includes('rientro')));
});

test('check-up: niente durante la pausa, check-up di ripresa al rientro (anche nei 5 giorni di pausa minima)', () => {
  const acts = history(), m = E.computeMetrics(acts, settings, today);
  const review = { lastReviewAt: Date.parse(E.addDays(today, -3) + 'T08:00:00Z'), lastPhase: 'base' };
  const paused = E.reviewTrigger({ today, acts, plan, settings, review, m, pauses: [{ id: 'p', from: E.addDays(today, -1), reason: 'injury' }] });
  assert.equal(paused.stage, 'paused');
  const back = E.reviewTrigger({ today, acts, plan, settings, review, m, pauses: [{ id: 'p', from: E.addDays(today, -2), endedOn: today, reason: 'injury' }] });
  assert.equal(back.stage, 'ask'); assert.ok(back.reasons.some((x) => x.k === 'return'));
});

test('passi strutturati: ripuliti e durata ricalcolata', () => {
  const steps = [{ type: 'warmup', min: 10, zone: 'Z2' }, { type: 'repeat', reps: 6, steps: [{ type: 'run', min: 2, zone: 'Z4' }, { type: 'recover', min: 2, zone: 'Z9' }] }, { type: 'cooldown', min: 6, zone: 'Z1' }, { type: 'evil', min: 999 }];
  const r = E.validatePlan([sess(E.addDays(today, 2), 'quality', 999, { steps })], base());
  const s = r.sessions[0];
  assert.ok(s.steps.length >= 3 && s.steps.length <= 4);
  assert.ok(s.steps.every((x) => x.type === 'repeat' || /^Z[1-5]$/.test(x.zone)));
  assert.ok(s.min <= 240);
  assert.ok(Math.abs(E.stepsMinutes(s.steps) - s.min) <= 1); // il volume ha accorciato la sessione: i passi seguono
});

test('testo workout per intervals.icu', () => {
  const t = E.toIntervalsText([{ type: 'warmup', min: 10, zone: 'Z2' }, { type: 'repeat', reps: 6, steps: [{ type: 'run', min: 0.5, zone: 'Z4' }, { type: 'walk', min: 1.5, zone: 'Z1' }] }, { type: 'cooldown', min: 5, zone: 'Z1' }]);
  assert.match(t, /^Warmup\n- 10m Z2 HR/);
  assert.match(t, /6x\n- 30s Z4 HR\n- Cammino 1m30s Z1 HR/);
  assert.match(t, /Cooldown\n- 5m Z1 HR$/);
});

test('piano generato: corse a settimana 3/4/5 e passi coerenti con la durata', () => {
  for (const r of [3, 4, 5]) {
    const pl = E.generatePlan({ ...settings, runsPerWeek: r });
    const runs = pl.filter((s) => s.date >= '2027-03-01' && s.date <= '2027-03-07' && E.RUN_KINDS.includes(s.kind) && !s.optional).length;
    assert.equal(runs, r);
    assert.ok(pl.every((s) => !s.steps || Math.abs(E.stepsMinutes(s.steps) - s.min) <= 2));
  }
});

test('corse a settimana: +1 al massimo e solo con dati buoni', () => {
  const acts = history(), m = E.computeMetrics(acts, settings, today);
  const ok = E.guardRunsPerWeek(3, 5, { acts, plan: E.generatePlan({ ...settings, runsPerWeek: 3 }), today, m });
  assert.equal(ok.value <= 4, true);
  const pain = E.guardRunsPerWeek(3, 4, { acts, checkins: { [today]: { date: today, pain: { level: 5 } } }, plan, today, m });
  assert.equal(pain.value, 3); assert.match(pain.note, /fastidio/);
  assert.equal(E.guardRunsPerWeek(4, 3, { acts, plan, today, m }).value, 3);
});
