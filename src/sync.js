// Sincronizzazione attività Strava → KV
import * as st from './strava.js';
import { get, put } from './store.js';
import { addDays, todayISO } from '../public/lib/engine.js';

const KEEP_MANUAL = (oldA, newA) => {
  if (oldA?.rpe_src === 'manuale') { newA.rpe = oldA.rpe; newA.rpe_src = 'manuale'; }
  if (oldA?.analyzed) newA.analyzed = oldA.analyzed;
  return newA;
};

async function saveActivities(env, list) {
  list.sort((a, b) => (a.start || a.date).localeCompare(b.start || b.date));
  await put(env, 'activities', list);
}

export async function upsert(env, a) {
  const list = await get(env, 'activities', []);
  const i = list.findIndex((x) => String(x.id) === String(a.id));
  if (i >= 0) list[i] = KEEP_MANUAL(list[i], a); else list.push(a);
  await saveActivities(env, list);
  return i >= 0 ? list[i] : a;
}

export async function remove(env, id) {
  const list = await get(env, 'activities', []);
  await saveActivities(env, list.filter((x) => String(x.id) !== String(id)));
}

// Dettaglio + streams di una singola attività
export async function ingest(env, id) {
  const d = await st.detail(env, id);
  let streams = null;
  if (d.has_heartrate) { try { streams = await st.streams(env, id); } catch (_) { /* streams opzionali */ } }
  const a = await upsert(env, st.normalize(d, streams));
  const meta = await get(env, 'meta', {});
  meta.lastSync = Date.now();
  await put(env, 'meta', meta);
  return a;
}

// Primo collegamento: 120 giorni di storico (summary), dettaglio sulle ultime 8
export async function backfill(env) {
  const after = Math.floor(Date.now() / 1000) - 120 * 86400;
  const summaries = await st.listSince(env, after, 3);
  const existing = await get(env, 'activities', []);
  const byId = new Map(existing.map((a) => [String(a.id), a]));
  for (const s of summaries) {
    const id = String(s.id);
    if (!byId.has(id)) byId.set(id, st.normalize(s));
  }
  await saveActivities(env, [...byId.values()]);
  const recent = summaries.slice(-8);
  for (const s of recent) { try { await ingest(env, s.id); } catch (e) { console.log('ingest', s.id, e.message); } }
  return { imported: summaries.length };
}

// Sync manuale / cron: nuove attività dagli ultimi giorni
export async function pullRecent(env, days = 3) {
  const list = await get(env, 'activities', []);
  const known = new Set(list.map((a) => String(a.id)));
  const lastDate = list.length ? list[list.length - 1].date : addDays(todayISO(), -30);
  const fromDate = addDays(lastDate < addDays(todayISO(), -days) ? lastDate : addDays(todayISO(), -days), -1);
  const after = Math.floor(new Date(fromDate + 'T00:00:00Z').getTime() / 1000);
  const summaries = await st.listSince(env, after, 1);
  const added = [], refreshed = [];
  for (const s of summaries.slice(-12)) {
    const isNew = !known.has(String(s.id));
    try {
      const a = await ingest(env, s.id);
      (isNew ? added : refreshed).push(a);
    } catch (e) { console.log('pull', s.id, e.message); }
  }
  return { added, refreshed };
}
