// Sincronizzazione attività Intervals.icu → KV
import * as iv from './intervals.js';
import { get, put } from './store.js';
import { addDays, todayISO } from '../public/lib/engine.js';

const KEEP_MANUAL = (oldA, newA) => {
  if (oldA?.rpe_src === 'manuale') { newA.rpe = oldA.rpe; newA.rpe_src = 'manuale'; }
  if (oldA?.analyzed) newA.analyzed = oldA.analyzed;
  if (oldA?.coached) newA.coached = oldA.coached; // già commentata dal coach (connettore)
  return newA;
};
const sortActs = (list) => list.sort((a, b) => (a.start || a.date).localeCompare(b.start || b.date));

// meta viene riscritto solo se cambia davvero qualcosa: il controllo periodico non consuma scritture KV
async function patchMeta(env, patch) {
  const meta = await get(env, 'meta', {});
  if (Object.entries(patch).every(([k, v]) => JSON.stringify(meta[k] ?? null) === JSON.stringify(v ?? null))) return meta;
  const next = { ...meta, ...patch };
  await put(env, 'meta', next);
  return next;
}
export const noteError = (env, e) => patchMeta(env, { syncError: String(e?.message || e).slice(0, 200) });

// Riepilogo Intervals.icu → attività completa (con stream FC/passo quando ci sono)
async function build(env, s) {
  let st = null;
  const hasHr = s.has_heartrate || s.average_heartrate || (s.stream_types || []).includes('heartrate');
  if (hasHr) { try { st = await iv.streams(env, s.id); } catch (_) { /* stream opzionali */ } }
  return iv.normalize(s, st);
}

// Primo collegamento: 120 giorni di storico, stream sulle ultime 8 uscite
export async function backfill(env) {
  const today = todayISO(), from = addDays(today, -120);
  const all = await iv.listRange(env, from, addDays(today, 1));
  const summaries = all.filter(iv.usable);
  const existing = await get(env, 'activities', []);
  // Restano solo le attività di Intervals.icu: quelle di un vecchio collegamento sarebbero doppioni
  const byId = new Map(existing.filter((a) => a.src === 'intervals').map((a) => [String(a.id), a]));
  const detailFrom = Math.max(0, summaries.length - 8);
  for (let i = 0; i < summaries.length; i++) {
    const s = summaries[i], id = String(s.id), old = byId.get(id);
    if (old && old.fp === iv.fingerprint(s) && (old.detailed || i < detailFrom)) continue;
    let a;
    try { a = i >= detailFrom ? await build(env, s) : iv.normalize(s); } catch (e) { console.log('backfill', id, e.message); a = iv.normalize(s); }
    byId.set(id, KEEP_MANUAL(old, a));
  }
  await put(env, 'activities', sortActs([...byId.values()]));
  let athlete = null;
  try { athlete = (await iv.athlete(env)).name; } catch (_) { /* il nome è solo informativo */ }
  try { await refreshZones(env); } catch (_) { /* senza zone si usa il calcolo della dashboard */ }
  await patchMeta(env, { backfilled: Date.now(), lastSync: Date.now(), syncError: null, stravaStubs: all.filter(iv.isStravaStub).length, ...(athlete ? { athlete } : {}) });
  return { imported: summaries.length, skippedStrava: all.filter(iv.isStravaStub).length };
}

// Controllo periodico (cron ogni 10 minuti, pulsante Sync): scarica solo ciò che è nuovo o cambiato
export async function pullRecent(env, days = 3) {
  const meta = await get(env, 'meta', {});
  if (!meta.backfilled) { const r = await backfill(env); return { added: [], refreshed: [], removed: 0, backfilled: r.imported }; }
  const list = await get(env, 'activities', []);
  const today = todayISO();
  const last = list.length ? list[list.length - 1].date : addDays(today, -30);
  // Finestra: ultimi `days` giorni, estesa fino all'ultima uscita nota (max 30 giorni) se il Worker è rimasto fermo
  let from = addDays(last < addDays(today, -days) ? last : addDays(today, -days), -1);
  if (from < addDays(today, -30)) from = addDays(today, -30);
  const all = await iv.listRange(env, from, addDays(today, 1));
  const summaries = all.filter(iv.usable).slice(-12);
  const byId = new Map(list.map((a) => [String(a.id), a]));
  const added = [], refreshed = [];
  for (const s of summaries) {
    const id = String(s.id), old = byId.get(id);
    if (old && old.fp === iv.fingerprint(s)) continue;
    try {
      const a = KEEP_MANUAL(old, await build(env, s));
      byId.set(id, a); (old ? refreshed : added).push(a);
    } catch (e) { console.log('pull', id, e.message); }
  }
  // Uscite cancellate su Intervals.icu: spariscono anche qui (solo dentro la finestra appena letta)
  const listed = new Set(all.map((s) => String(s.id)));
  let removed = 0;
  for (const a of list) if (a.src === 'intervals' && a.date >= from && !listed.has(String(a.id))) { byId.delete(String(a.id)); removed++; }
  if (added.length || refreshed.length || removed) {
    await put(env, 'activities', sortActs([...byId.values()]));
    await patchMeta(env, { lastSync: Date.now(), syncError: null, stravaStubs: all.filter(iv.isStravaStub).length });
  } else await patchMeta(env, { syncError: null, stravaStubs: all.filter(iv.isStravaStub).length });
  return { added, refreshed, removed };
}

// Zone FC della corsa da intervals.icu → impostazioni (solo se cambiano: niente scritture inutili)
export async function refreshZones(env) {
  const z = await iv.hrZones(env);
  const s = await get(env, 'settings', {});
  const same = JSON.stringify(s.hrZones?.zones || null) === JSON.stringify(z?.zones || null);
  if (!same) await put(env, 'settings', { ...s, hrZones: z });
  return z;
}
