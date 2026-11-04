// Sincronizzazione attività → KV
// Fonte principale: intervals.icu (gratis, collegato a Garmin). Strava resta supportato se configurato.
import * as st from './strava.js';
import * as iv from './intervals.js';
import { get, put } from './store.js';
import { addDays, todayISO } from '../public/lib/engine.js';

export const source = (env) => (iv.configured(env) ? 'intervals' : env.STRAVA_CLIENT_ID ? 'strava' : null);

const keepManual = (oldA, newA) => {
  if (oldA?.rpe_src === 'manuale') { newA.rpe = oldA.rpe; newA.rpe_src = 'manuale'; }
  if (oldA?.analyzed) newA.analyzed = oldA.analyzed;
  if (oldA?.hist && !oldA.approx && newA.approx) { newA.hist = oldA.hist; newA.decoupling = oldA.decoupling; delete newA.approx; }
  return newA;
};
async function saveActivities(env, list) {
  list.sort((a, b) => (a.start || a.date).localeCompare(b.start || b.date));
  await put(env, 'activities', list);
}
async function touchMeta(env, patch = {}) {
  const meta = await get(env, 'meta', {});
  await put(env, 'meta', { ...meta, lastSync: Date.now(), ...patch });
}

export async function upsert(env, a) {
  const list = await get(env, 'activities', []);
  const i = list.findIndex((x) => String(x.id) === String(a.id));
  if (i >= 0) list[i] = keepManual(list[i], a); else list.push(a);
  await saveActivities(env, list);
  return i >= 0 ? list[i] : a;
}
export async function remove(env, id) {
  const list = await get(env, 'activities', []);
  await saveActivities(env, list.filter((x) => String(x.id) !== String(id)));
}

// ---------- intervals.icu ----------
async function intervalsPull(env, oldest, withStreamsMax = 10) {
  const today = todayISO();
  const remote = await iv.listRange(env, oldest, addDays(today, 1));
  const list = await get(env, 'activities', []);
  const byId = new Map(list.map((a) => [String(a.id), a]));
  const added = [], refreshed = [];
  let streamsLeft = withStreamsMax;
  // le più recenti per prime, così gli streams vanno a quelle che contano
  for (const d of remote.sort((a, b) => b.start_date_local.localeCompare(a.start_date_local))) {
    const id = String(d.id), old = byId.get(id);
    const fresh = iv.normalize(d);
    if (old && old.sig === fresh.sig && !old.approx) continue;
    let a = fresh;
    if (d.average_heartrate && (!old || old.approx) && streamsLeft > 0) {
      streamsLeft--;
      try { a = iv.normalize(d, await iv.streams(env, id)); } catch (e) { console.log('streams', id, e.message); }
    }
    a = keepManual(old, a);
    byId.set(id, a);
    (old ? refreshed : added).push(a);
  }
  if (added.length || refreshed.length) await saveActivities(env, [...byId.values()]);
  await touchMeta(env, { source: 'intervals' });
  return { added: added.sort((a, b) => a.start.localeCompare(b.start)), refreshed };
}

// ---------- API comuni ----------
export async function backfill(env) {
  if (source(env) === 'intervals') {
    const r = await intervalsPull(env, addDays(todayISO(), -120), 12);
    await touchMeta(env, { backfilled: true });
    return { imported: r.added.length + r.refreshed.length };
  }
  const after = Math.floor(Date.now() / 1000) - 120 * 86400;
  const summaries = await st.listSince(env, after, 3);
  const existing = await get(env, 'activities', []);
  const byId = new Map(existing.map((a) => [String(a.id), a]));
  for (const s of summaries) if (!byId.has(String(s.id))) byId.set(String(s.id), st.normalize(s));
  await saveActivities(env, [...byId.values()]);
  for (const s of summaries.slice(-8)) { try { await ingest(env, s.id); } catch (e) { console.log('ingest', s.id, e.message); } }
  await touchMeta(env, { backfilled: true });
  return { imported: summaries.length };
}

export async function pullRecent(env, days = 3) {
  const list = await get(env, 'activities', []);
  const today = todayISO();
  const lastDate = list.length ? list[list.length - 1].date : addDays(today, -30);
  const from = addDays(lastDate < addDays(today, -days) ? lastDate : addDays(today, -days), -1);
  if (source(env) === 'intervals') return intervalsPull(env, from, 6);
  if (source(env) !== 'strava') return { added: [], refreshed: [] };
  const known = new Set(list.map((a) => String(a.id)));
  const summaries = await st.listSince(env, Math.floor(new Date(from + 'T00:00:00Z').getTime() / 1000), 1);
  const added = [], refreshed = [];
  for (const s of summaries.slice(-12)) {
    try { const a = await ingest(env, s.id); (known.has(String(s.id)) ? refreshed : added).push(a); } catch (e) { console.log('pull', s.id, e.message); }
  }
  return { added, refreshed };
}

// Strava: dettaglio + streams di una singola attività (usato dal webhook)
export async function ingest(env, id) {
  const d = await st.detail(env, id);
  let streams = null;
  if (d.has_heartrate) { try { streams = await st.streams(env, id); } catch (_) { /* opzionale */ } }
  const a = await upsert(env, st.normalize(d, streams));
  await touchMeta(env);
  return a;
}
