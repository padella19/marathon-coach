// Accesso a Cloudflare KV (un solo utente → chiavi singole JSON)
import { DEFAULT_SETTINGS } from '../public/lib/engine.js';

export async function get(env, key, fallback = null) {
  const v = await env.KV.get(key, 'json');
  return v ?? fallback;
}
export async function put(env, key, value) {
  await env.KV.put(key, JSON.stringify(value));
}
export async function getSettings(env) {
  return { ...DEFAULT_SETTINGS, ...(await get(env, 'settings', {})) };
}

// ----------------------------------------------------------------------------
// Raccolte senza scritture concorrenti che si pestano (feed del coach, check-in)
//
// Prima feed e check-in erano un unico array/oggetto: sincronizzazione delle uscite e check-in
// leggevano, aggiungevano e riscrivevano tutto, e chi arrivava secondo cancellava
// l'altro. Ora ogni elemento sta in una chiave propria:
//     feed:<timestamp>-<uuid>      checkin:<YYYY-MM-DD>
// e scrivere un elemento non tocca gli altri.
//
// Per non leggere decine di chiavi (più una list) a ogni polling della dashboard,
// che sul piano gratuito di KV esaurirebbe le quote giornaliere, accanto alle
// chiavi c'è un riepilogo (feed_snap / checkin_snap) ricostruito dalle chiavi a
// ogni scrittura: /api/state legge solo quello. Il riepilogo è derivato: se due
// ricostruzioni si incrociano, la successiva (o il cron giornaliero) lo riallinea.
// ----------------------------------------------------------------------------
const FEED = { prefix: 'feed:', snap: 'feed_snap', keep: 80, legacy: 'feed' };
const CHECKINS = { prefix: 'checkin:', snap: 'checkin_snap', keep: 90, legacy: 'checkins' };

async function listNames(env, prefix) {
  const names = []; let cursor;
  do {
    const r = await env.KV.list({ prefix, cursor });
    names.push(...r.keys.map((k) => k.name));
    cursor = r.list_complete ? null : r.cursor;
  } while (cursor);
  return names;
}

// Ricostruisce il riepilogo dalle chiavi. `fresh` = elementi appena scritti da chi chiama
// (usati al posto di quelli in cache, e inclusi anche se la list non li mostra ancora).
async function rebuild(env, c, fresh = {}) {
  let items = {};
  for (let round = 0; round < 2; round++) {
    const names = new Set([...(await listNames(env, c.prefix)), ...Object.keys(fresh)]);
    const sorted = [...names].sort().reverse(); // i nomi iniziano per data/ora: i più recenti in testa
    const keep = sorted.slice(0, c.keep), drop = sorted.slice(c.keep);
    const prev = (await get(env, c.snap))?.items || {};
    items = {};
    await Promise.all(keep.map(async (n) => { items[n] = fresh[n] ?? prev[n] ?? (await get(env, n)); }));
    for (const n of Object.keys(items)) if (items[n] == null) delete items[n];
    const same = Object.keys(prev).length === Object.keys(items).length && Object.keys(items).every((n) => n in prev && !(n in fresh));
    if (!same) await put(env, c.snap, { v: 2, builtAt: Date.now(), items });
    await Promise.all(drop.map((n) => env.KV.delete(n)));
    // Se nel frattempo qualcun altro ha scritto un elemento, un secondo giro lo raccoglie
    if (same || round === 1) break;
    const again = await listNames(env, c.prefix);
    if (again.every((n) => names.has(n))) break;
  }
  return items;
}

// Migrazione al primo avvio: il vecchio array/oggetto unico viene spostato nelle nuove chiavi
async function migrate(env, c) {
  const old = await get(env, c.legacy);
  const fresh = {};
  if (c === FEED && Array.isArray(old)) {
    for (const it of old) if (it?.id) fresh[`${c.prefix}${String(it.ts || 0).padStart(13, '0')}-${it.id}`] = it;
  } else if (c === CHECKINS && old && typeof old === 'object') {
    for (const [d, ci] of Object.entries(old)) if (/^\d{4}-\d{2}-\d{2}$/.test(d) && ci) fresh[c.prefix + d] = ci;
  }
  await Promise.all(Object.entries(fresh).map(([n, v]) => put(env, n, v)));
  const items = await rebuild(env, c, fresh);
  if (!Object.keys(items).length) await put(env, c.snap, { v: 2, builtAt: Date.now(), items: {} }); // segna la migrazione come fatta
  if (old != null) await env.KV.delete(c.legacy);
  return items;
}
async function snapshot(env, c) {
  const s = await get(env, c.snap);
  return s ? s.items || {} : migrate(env, c);
}
const newestFirst = (items) => Object.keys(items).sort().reverse().map((n) => items[n]);

// ---------- Feed del coach ----------
export async function getFeed(env) {
  return newestFirst(await snapshot(env, FEED));
}
export async function pushFeed(env, item) {
  await snapshot(env, FEED); // garantisce la migrazione prima della prima scrittura
  const entry = { id: crypto.randomUUID(), ts: Date.now(), ...item };
  const name = `${FEED.prefix}${String(entry.ts).padStart(13, '0')}-${entry.id}`;
  await put(env, name, entry);
  await rebuild(env, FEED, { [name]: entry });
  return entry;
}
export async function clearFeed(env) {
  await Promise.all((await listNames(env, FEED.prefix)).map((n) => env.KV.delete(n)));
  await put(env, FEED.snap, { v: 2, builtAt: Date.now(), items: {} });
}

// ---------- Check-in ----------
export async function getCheckins(env) {
  return Object.fromEntries(newestFirst(await snapshot(env, CHECKINS)).filter((c) => c?.date).map((c) => [c.date, c]));
}
// Lettura diretta della chiave del giorno: sempre aggiornata, anche subito dopo il salvataggio
export async function getCheckin(env, date) {
  return (await get(env, CHECKINS.prefix + date)) || (await getCheckins(env))[date] || null;
}
export async function putCheckin(env, ci) {
  await snapshot(env, CHECKINS);
  const name = CHECKINS.prefix + ci.date;
  await put(env, name, ci);
  await rebuild(env, CHECKINS, { [name]: ci });
}

// Riallineamento periodico (cron giornaliero): ripara un riepilogo rimasto indietro
export async function repairSnapshots(env) {
  await snapshot(env, FEED); await snapshot(env, CHECKINS);
  await rebuild(env, FEED); await rebuild(env, CHECKINS);
}

// Aggiorna un elemento del feed (applicata, valutazione, risposta arrivata) senza toccare gli altri
export async function patchFeed(env, id, patch) {
  const items = await snapshot(env, FEED);
  const name = Object.keys(items).find((n) => items[n]?.id === id);
  if (!name) return null;
  const entry = { ...(await get(env, name)) || items[name], ...patch };
  await put(env, name, entry);
  await rebuild(env, FEED, { [name]: entry });
  return entry;
}
