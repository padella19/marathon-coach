// Piano → calendario di intervals.icu → Garmin Connect → orologio.
// Scrive i prossimi 14 giorni come workout strutturati (external_id "mc-<data>"), cancella solo gli eventi "mc-*"
// che non servono più e non tocca mai quelli creati a mano su intervals.icu.
import * as iv from './intervals.js';
import { get, put, getSettings, getCheckin } from './store.js';
import {
  todayISO, addDays, planIndex, effective, withPauses, tripDaySet, tripOn, adaptSession, readiness, computeMetrics, logActivities,
  stepsFor, toIntervalsText, RUN_KINDS, STRENGTH, strengthNeed,
} from '../public/lib/engine.js';

const DAYS = 14;
function eventFor(date, s) {
  if (!s || s.kind === 'rest' || s.kind === 'pause' || s.kind === 'race') return null;
  if (RUN_KINDS.includes(s.kind)) {
    const steps = s.steps || stepsFor(s);
    return { category: 'WORKOUT', type: s.walk ? 'Walk' : 'Run', start_date_local: `${date}T00:00:00`, name: s.title, description: steps ? toIntervalsText(steps) : `- ${s.min}m Z2 HR`, moving_time: Math.round((s.min || 0) * 60), external_id: `mc-${date}` };
  }
  const need = strengthNeed(s);
  if (need && need.main) {
    const r = STRENGTH[need.routine];
    return { category: 'WORKOUT', type: 'WeightTraining', start_date_local: `${date}T00:00:00`, name: `${s.title} (routine ${need.routine})`, description: r ? r.ex.map(([n, d]) => `${n}: ${d}`).join('\n') : s.desc, moving_time: Math.round((s.min || 20) * 60), external_id: `mc-${date}` };
  }
  return null;
}

export async function syncGarmin(env, reason = 'piano') {
  if (!iv.configured(env)) return { skipped: 'intervals non collegato' };
  const today = todayISO(), last = addDays(today, DAYS - 1);
  const [settings, plan, overrides0, acts0, trips, pauses, logs, ci, prev] = await Promise.all([
    getSettings(env), get(env, 'plan', []), get(env, 'overrides', {}), get(env, 'activities', []), get(env, 'trips', { manual: [], ical: [] }),
    get(env, 'pauses', []), get(env, 'logs', []), getCheckin(env, today), get(env, 'garmin_sync', {}),
  ]);
  const overrides = withPauses(overrides0, pauses, today), pIdx = planIndex(plan), tripSet = tripDaySet(trips);
  const m = computeMetrics([...acts0, ...logActivities(logs, acts0)], settings, today);
  const events = [], days = {};
  for (let i = 0; i < DAYS; i++) {
    const d = addDays(today, i);
    let s = effective(d, pIdx, overrides);
    // oggi: la versione adattata dal check-in (fastidi, readiness, trasferta)
    if (i === 0 && s) s = adaptSession(s, { ci, m, trip: tripSet.has(d), ready: readiness(ci, m), tripSet, date: d, facilities: tripOn(trips, d)?.facilities }).session;
    const ev = eventFor(d, s);
    if (ev) events.push(ev);
  }
  const out = { ts: Date.now(), reason, days: {}, error: null, todayUpdatedAt: prev.todayUpdatedAt || null };
  try {
    if (events.length) await iv.upsertEvents(env, events);
    const existing = await iv.listEvents(env, today, last);
    const keep = new Set(events.map((e) => e.external_id));
    for (const e of Array.isArray(existing) ? existing : []) {
      if (String(e.external_id || '').startsWith('mc-') && !String(e.external_id).startsWith('mc-manual') && !keep.has(e.external_id)) await iv.deleteEvent(env, e.id);
    }
    for (const e of events) out.days[e.start_date_local.slice(0, 10)] = { status: 'ok', name: e.name };
    // La sessione di oggi è cambiata dopo un invio precedente: va risincronizzato l'orologio
    const todayEv = events.find((e) => e.start_date_local.startsWith(today));
    const sig = todayEv ? `${todayEv.name}|${todayEv.description}` : '';
    if (prev.todaySig && prev.todayDate === today && prev.todaySig !== sig) out.todayUpdatedAt = Date.now();
    out.todaySig = sig; out.todayDate = today;
  } catch (e) {
    out.error = e.message;
    for (const ev of events) out.days[ev.start_date_local.slice(0, 10)] = { status: 'error', msg: e.message };
  }
  await put(env, 'garmin_sync', out);
  return out;
}
