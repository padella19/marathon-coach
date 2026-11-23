// ============================================================================
// José — lato Worker: chat, messaggi spontanei, stato del connettore, luoghi,
// meteo (Open-Meteo), report settimanale, test e previsione, badge, scarpe,
// "Non riesco", note vocali (Workers AI Whisper) e area gara.
// José "pensa" solo quando gira Claude (due attività programmate al giorno):
// tutto ciò che è immediato lo calcola qui il Worker, a regole.
// ============================================================================
import { get, put, getSettings } from './store.js';
import { important, romeNow } from './notify.js';
import { syncGarmin } from './garmin.js';
import { geocode, resolveTripPlace } from './geo.js';
import * as J from '../public/lib/jose.js';
import {
  todayISO, addDays, diffDays, mondayOf, planIndex, effective, withPauses, tripDaySet, tripOn, allTrips, placeKey, computeMetrics, logActivities, hrProfile, fmtPace, DOW_IT,
} from '../public/lib/engine.js';

const clean = (v, n = 600) => String(v ?? '').replace(/<[^>]*>/g, '').trim().slice(0, n);
const uid = () => crypto.randomUUID().slice(0, 8);
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

// ---------- Stato: ultima chiamata del connettore ----------
export const touch = (env, tool) => put(env, 'mcp_status', { last_mcp_call: Date.now(), tool });

// ---------- Chat ----------
const KINDS = ['reply', 'spontaneous', 'scolding', 'praise'];
export const SPONTANEOUS_GAP_H = 6; // al massimo 1 messaggio spontaneo per giro
export const getChat = (env) => get(env, 'chat', []);
export async function lucaMessage(env, text, extra = {}) {
  const t = clean(text, 1500);
  if (!t) return { error: 'messaggio vuoto' };
  const chat = await getChat(env), msg = { id: uid(), ts: Date.now(), from: 'luca', text: t, answered: false, ...extra };
  await put(env, 'chat', [...chat, msg].slice(-300));
  return { ok: true, message: msg };
}
export async function sendMessage(env, { text, reply_to = null, kind = 'reply', signal_id = null } = {}) {
  const t = clean(text, 2000);
  if (!t) return { error: 'testo mancante' };
  kind = KINDS.includes(kind) ? kind : reply_to ? 'reply' : 'spontaneous';
  const chat = await getChat(env);
  const target = reply_to ? chat.find((m) => m.id === reply_to && m.from === 'luca') : null;
  if (reply_to && !target) return { error: `messaggio ${reply_to} non trovato: usa un id di chat_in_attesa oppure ometti reply_to` };
  const isReply = !!target || kind === 'reply';
  if (!isReply) {
    const last = [...chat].reverse().find((m) => m.from === 'jose' && m.kind !== 'reply');
    if (last && Date.now() - last.ts < SPONTANEOUS_GAP_H * 3.6e6) return { error: 'Hai già mandato un messaggio spontaneo in questo giro: al massimo uno per giro. Riprova al prossimo.' };
  }
  const msg = { id: uid(), ts: Date.now(), from: 'jose', kind, text: t, ...(target ? { replyTo: target.id } : {}), ...(signal_id ? { signal: clean(signal_id, 80) } : {}) };
  // Una risposta senza reply_to chiude tutti i messaggi in attesa
  for (const m of chat) if (m.from === 'luca' && !m.answered && (target ? m.id === target.id : isReply)) { m.answered = true; m.answeredBy = msg.id; }
  await put(env, 'chat', [...chat, msg].slice(-300));
  if (signal_id) await markSignals(env, [signal_id]);
  await important(env, kind === 'scolding' ? 'José ha qualcosa da dirti' : 'José', t.slice(0, 600), 'coach');
  return { ok: true, id: msg.id, kind };
}
export async function rateChat(env, id, rating, note) {
  const chat = await getChat(env), m = chat.find((x) => x.id === id && x.from === 'jose');
  if (!m) return null;
  m.rating = ['up', 'down'].includes(rating) ? rating : null; m.ratingNote = clean(note, 200) || null;
  await put(env, 'chat', chat);
  return m;
}
async function markSignals(env, ids) {
  const done = await get(env, 'signals_done', {});
  for (const id of ids) done[String(id).slice(0, 80)] = Date.now();
  await put(env, 'signals_done', Object.fromEntries(Object.entries(done).filter(([, ts]) => Date.now() - ts < 45 * 864e5)));
}

// ---------- Luoghi: dotazioni per hotel/città ----------
export async function setPlace(env, a = {}) {
  const city = clean(a.city, 40), key = placeKey(city);
  if (!key) return { error: 'città mancante' };
  const trips = await get(env, 'trips', { manual: [], ical: [] });
  const cur = trips.places?.[key] || {};
  const b = (k) => (typeof a[k] === 'boolean' ? a[k] : cur[k] ?? null);
  const place = { city, hotel: a.hotel != null ? clean(a.hotel, 60) : cur.hotel || '', treadmill: b('treadmill'), gym: b('gym'), outdoor: b('outdoor'), early_breakfast: b('early_breakfast'), note: a.note != null ? clean(a.note, 200) : cur.note || '', ts: Date.now() };
  trips.places = { ...(trips.places || {}), [key]: place };
  await put(env, 'trips', trips);
  syncGarmin(env, 'dotazioni').catch(() => {});
  return { ok: true, luogo: J.placeText(place) };
}

// ---------- Meteo (Open-Meteo: gratis, senza chiave) ----------
// Città del giorno: quella della trasferta (coordinate già risolte dal calendario), altrimenti casa.
const OM = 'https://api.open-meteo.com/v1/forecast';
const WMO = { 0: 'sereno', 1: 'quasi sereno', 2: 'parzialmente nuvoloso', 3: 'coperto', 45: 'nebbia', 48: 'nebbia gelata', 51: 'pioviggine debole', 53: 'pioviggine', 55: 'pioviggine forte',
  56: 'pioviggine gelata', 57: 'pioviggine gelata', 61: 'pioggia debole', 63: 'pioggia', 65: 'pioggia forte', 66: 'pioggia gelata', 67: 'pioggia gelata', 71: 'neve debole', 73: 'neve', 75: 'neve forte',
  77: 'nevischio', 80: 'rovesci deboli', 81: 'rovesci', 82: 'rovesci forti', 85: 'rovesci di neve', 86: 'rovesci di neve forti', 95: 'temporale', 96: 'temporale con grandine', 99: 'temporale con grandine' };
export const wmoText = (c) => (c == null ? null : WMO[c] || null);
// Riduce la previsione oraria alla fascia preferita, trova l'ora migliore della giornata e tiene le ore 6-22
export function pickHours(h, date, hour, coldC = 5, daily = null) {
  const at = (hh) => { const i = h.time.indexOf(`${date}T${String(hh).padStart(2, '0')}:00`); return i < 0 ? null : { hour: hh, temp: h.temperature_2m[i], feels: h.apparent_temperature[i], rain_prob: h.precipitation_probability?.[i] ?? null, rain_mm: h.precipitation?.[i] ?? 0, wind: h.wind_speed_10m[i], code: h.weather_code?.[i] ?? null }; };
  const cur = at(hour);
  if (!cur) return null;
  const bad = (x) => Math.max(0, coldC + 3 - x.feels) * 2 + (x.rain_prob ?? 0) / 10 + x.rain_mm * 5 + Math.max(0, x.wind - 25) / 5 + Math.abs(x.hour - hour) * 0.15;
  let best = cur;
  const hours = [];
  for (let hh = 6; hh <= 22; hh++) { const x = at(hh); if (!x) continue; hours.push({ hour: x.hour, temp: x.temp, feels: x.feels, rain_prob: x.rain_prob, wind: x.wind, code: x.code }); if (hh <= 21 && bad(x) < bad(best) - 0.01) best = x; }
  const { code, ...rest } = cur;
  const di = daily?.time ? daily.time.indexOf(date) : -1;
  const day = di >= 0 ? { min: daily.temperature_2m_min?.[di] ?? null, max: daily.temperature_2m_max?.[di] ?? null, rain_sum: daily.precipitation_sum?.[di] ?? null, rain_prob_max: daily.precipitation_probability_max?.[di] ?? null, code: daily.weather_code?.[di] ?? null }
    : hours.length ? { min: Math.min(...hours.map((x) => x.temp)), max: Math.max(...hours.map((x) => x.temp)), rain_sum: null, rain_prob_max: Math.max(...hours.map((x) => x.rain_prob ?? 0)), code: null } : null;
  if (day) day.cond = wmoText(day.code);
  return { ...rest, ...(code != null ? { code, cond: wmoText(code) } : {}), best: { hour: best.hour, feels: best.feels, rain_prob: best.rain_prob }, hours, day };
}
export async function refreshMeteo(env, maxAgeH = 3) {
  const [prev, s, trips, geo] = await Promise.all([get(env, 'meteo', null), getSettings(env), get(env, 'trips', { manual: [], ical: [] }), get(env, 'geo2', {})]);
  const fresh = prev && Date.now() - prev.ts < maxAgeH * 3.6e6 && prev.today === todayISO() && prev.v === 2 && !((trips.icalUpdated || 0) > prev.ts) && !((trips.manualUpdated || 0) > prev.ts);
  if (fresh) return prev;
  const today = todayISO(), home = s.homeCity || 'Milano', hour = Math.min(22, Math.max(5, Math.round(+s.runHour || 7)));
  const out = { v: 2, ts: Date.now(), today, days: {}, error: null }, geoN = Object.keys(geo).length, byLoc = {}, budget = { left: 8 };
  try {
    for (let i = 0; i < 3; i++) {
      const d = addDays(today, i), tr = tripOn(trips, d);
      let loc = null, city = home;
      if (tr?.lat != null) { loc = { lat: tr.lat, lon: tr.lon, name: tr.city }; city = tr.city; }
      else if (tr) { // trasferta manuale o non ancora risolta: provo città e titolo
        const p = await resolveTripPlace(tr.city || tr.title, tr.location || '', geo, budget).catch(() => null);
        if (p) { loc = { lat: p.lat, lon: p.lon, name: p.city }; city = p.city; }
      }
      if (!loc) { city = home; loc = await geocode(home, geo, budget); } // nessuna città riconoscibile: vale casa
      if (!loc) continue;
      const k = `${loc.lat},${loc.lon}`;
      if (!byLoc[k]) {
        const r = await fetch(`${OM}?latitude=${loc.lat}&longitude=${loc.lon}&hourly=temperature_2m,apparent_temperature,precipitation_probability,precipitation,wind_speed_10m,weather_code&daily=temperature_2m_min,temperature_2m_max,precipitation_sum,precipitation_probability_max,weather_code&timezone=auto&forecast_days=4`);
        if (!r.ok) throw new Error(`Open-Meteo ${r.status}`);
        const j = await r.json();
        byLoc[k] = { hourly: j.hourly, daily: j.daily };
      }
      const p = pickHours(byLoc[k].hourly, d, hour, s.coldFeelsC ?? 5, byLoc[k].daily);
      if (p) out.days[d] = { city: loc.name || city, trasferta: !!tr && tr.type !== 'vacation', vacanza: tr?.type === 'vacation', luogo: tr?.title || null, ...p };
    }
  } catch (e) { out.error = String(e.message || e).slice(0, 120); if (prev?.days) out.days = { ...prev.days, ...out.days }; }
  if (Object.keys(geo).length !== geoN) await put(env, 'geo2', geo);
  await put(env, 'meteo', out);
  return out;
}

// ---------- Contesto comune (piano effettivo, attività, viaggi) ----------
async function ctxOf(env) {
  const today = todayISO();
  const [settings, plan, overrides0, acts0, trips, pauses, logs] = await Promise.all([
    getSettings(env), get(env, 'plan', []), get(env, 'overrides', {}), get(env, 'activities', []), get(env, 'trips', { manual: [], ical: [] }), get(env, 'pauses', []), get(env, 'logs', []),
  ]);
  const acts = [...acts0, ...logActivities(logs, acts0)];
  return { today, settings, plan, overrides0, overrides: withPauses(overrides0, pauses, today), acts, acts0, trips, pauses, pIdx: planIndex(plan), tripSet: tripDaySet(trips) };
}

// ---------- "Non riesco" ----------
export async function skip(env, { date, choice } = {}) {
  const c = await ctxOf(env);
  if (!isDate(date) || date < c.today || date > addDays(c.today, 6)) return { error: 'si può spostare solo una sessione di oggi o dei prossimi 6 giorni' };
  const r = J.skipOptions(date, c);
  if (!r) return { error: 'in quel giorno non c\'è una corsa da spostare' };
  const o = r.options.find((x) => x.k === choice);
  if (!choice) return { options: r.options.map(({ k, to, label, sub }) => ({ k, to, label, sub })), session: r.session.title };
  if (!o) return { error: 'opzione non valida' };
  const ov = { ...c.overrides0 };
  for (const [d, s] of Object.entries(o.patch)) ov[d] = { ...s, date: d, override: true, manual: true, ts: Date.now(), reason: `Non riesco: ${o.label.toLowerCase()}` };
  await put(env, 'overrides', ov);
  const skips = await get(env, 'skips', []);
  await put(env, 'skips', [...skips.filter((x) => x.date !== date), { date, title: r.session.title, min: r.session.min, k: o.k, to: o.to, label: o.label, ts: Date.now() }].slice(-60));
  syncGarmin(env, 'non riesco').catch((e) => console.error('garmin', e.message));
  return { ok: true, choice: o.k, to: o.to, label: o.label };
}

// ---------- Test e previsione ----------
export async function recordTest(env, a = {}) {
  const type = a.type === '30min' ? '30min' : '5k', dist = +a.dist_km, time = Math.round(+a.time_s);
  if (!isDate(a.date) || a.date > todayISO()) return { error: 'data del test non valida' };
  if (!(dist >= 1 && dist <= 25) || !(time >= 300 && time <= 3 * 3600)) return { error: 'risultato non plausibile: servono distanza (km) e tempo (secondi)' };
  const pred = J.predict(dist, time), zones = J.paceZones(dist, time);
  const s = await getSettings(env), hrp = hrProfile(s);
  const t = { id: uid(), date: a.date, type, dist_km: Math.round(dist * 100) / 100, time_s: time, passo_s: Math.round(time / dist), hr_avg: +a.hr_avg || null, hr_max: +a.hr_max || null, activity_id: a.activity_id ? String(a.activity_id) : null,
    source: a.source === 'auto' ? 'auto' : a.source === 'jose' ? 'jose' : 'manuale', approx: !!a.approx, previsione: pred, zone_passo: zones,
    nota_fc: +a.hr_max > hrp.max ? `FC max del test ${a.hr_max} sopra quella impostata (${hrp.max}): aggiorna le zone su intervals.icu` : type === '30min' && +a.hr_avg ? `FC media del test ${a.hr_avg}: è una buona stima della soglia. Confrontala con il limite alto della Z4 (${hrp.zones[3].hi}).` : null, ts: Date.now() };
  const tests = (await get(env, 'tests', [])).filter((x) => x.date !== t.date);
  await put(env, 'tests', [...tests, t].sort((x, y) => x.date.localeCompare(y.date)).slice(-40));
  return { ok: true, test: t };
}
export async function deleteTest(env, id) { await put(env, 'tests', (await get(env, 'tests', [])).filter((x) => x.id !== id)); return { ok: true }; }
// Dopo la sincronizzazione: se quel giorno il piano prevedeva un test, il risultato si ricava dall'uscita
export async function autoTest(env, a) {
  const c = await ctxOf(env), p = effective(a.date, c.pIdx, c.overrides);
  if (!p || !(p.test || /\btest\b/i.test(p.title || ''))) return null;
  if ((await get(env, 'tests', [])).some((x) => x.date === a.date && x.source !== 'auto')) return null;
  const type = p.test || (/30/.test(p.title) ? '30min' : '5k'), r = J.extractTest(a, type);
  return r ? recordTest(env, { ...r, date: a.date, type, activity_id: a.id, source: 'auto' }) : null;
}

// ---------- Scarpe ----------
export async function saveShoes(env, list) {
  const cur = await get(env, 'shoes', { list: [], assign: {} });
  const next = (Array.isArray(list) ? list : []).slice(0, 12).map((x) => ({
    id: clean(x.id, 12) || uid(), model: clean(x.model, 40) || 'Scarpe', start: isDate(x.start) ? x.start : todayISO(), km0: Math.max(0, Math.min(3000, +x.km0 || 0)),
    limit: Math.max(200, Math.min(1500, +x.limit || 600)), def: !!x.def, retired: !!x.retired,
  }));
  let seen = false; for (const x of next) { if (x.def && (seen || x.retired)) x.def = false; if (x.def) seen = true; }
  // Se cambia la scarpa predefinita, le corse già fatte restano sulla vecchia
  const oldDef = cur.list.find((x) => x.def), newDef = next.find((x) => x.def);
  const assign = { ...cur.assign };
  if (oldDef && oldDef.id !== newDef?.id) for (const a of await get(env, 'activities', [])) if (!assign[a.id] && J.shoeOf(a, cur) === oldDef.id) assign[a.id] = oldDef.id;
  const out = { list: next, assign };
  await put(env, 'shoes', out);
  return out;
}
export async function assignShoe(env, actId, shoeId) {
  const cur = await get(env, 'shoes', { list: [], assign: {} });
  if (shoeId && shoeId !== 'none' && !cur.list.some((x) => x.id === shoeId)) return { error: 'scarpa non trovata' };
  const assign = { ...cur.assign }; if (shoeId) assign[actId] = shoeId; else delete assign[actId];
  const out = { ...cur, assign };
  await put(env, 'shoes', out);
  return out;
}

// ---------- Badge: il Worker li calcola e ricorda quali sono nuovi ----------
export async function refreshBadges(env, c, tests) {
  const now = J.computeBadges({ acts: c.acts, pIdx: c.pIdx, overrides: c.overrides, tripSet: c.tripSet, today: c.today, settings: c.settings, tests });
  const st = await get(env, 'badges', { earned: {} });
  let changed = false;
  for (const [id, date] of Object.entries(now)) if (!st.earned[id]) { st.earned[id] = { date, ts: Date.now() }; changed = true; }
  if (changed) await put(env, 'badges', st);
  return st.earned;
}

// ---------- Report settimanale (lunedì mattina) ----------
export async function postWeeklyReport(env, a = {}) {
  const c = await ctxOf(env);
  const week = isDate(a.week) ? mondayOf(a.week) : addDays(mondayOf(c.today), -7);
  if (week >= mondayOf(c.today)) return { error: 'il report riguarda una settimana già chiusa' };
  const list = (v) => (Array.isArray(v) ? v : v ? [v] : []).map((x) => clean(x, 240)).filter(Boolean).slice(0, 5);
  const voto = Number.isFinite(+a.voto) && a.voto != null && a.voto !== '' ? Math.max(1, Math.min(10, Math.round(+a.voto))) : null;
  if (!voto || !clean(a.commento)) return { error: 'servono almeno voto (1-10) e commento' };
  const rep = { week, ts: Date.now(), numeri: J.weekNumbers(week, c), voto, titolo: clean(a.titolo, 100) || `Settimana del ${week.slice(8)}/${week.slice(5, 7)}`, commento: clean(a.commento, 900), bene: list(a.bene), male: list(a.male), focus: clean(a.focus, 300), focus_perche: clean(a.focus_perche, 400) };
  const all = await get(env, 'reports', {});
  all[week] = rep;
  await put(env, 'reports', Object.fromEntries(Object.keys(all).sort().slice(-30).map((k) => [k, all[k]])));
  // Il focus della settimana nuova alimenta la card "Focus della settimana"
  if (rep.focus) {
    const next = addDays(week, 7), w = await get(env, 'weekly', {});
    w[next] = { week: next, source: 'claude', ts: Date.now(), title: rep.focus.slice(0, 100), why: rep.focus_perche || rep.commento.slice(0, 300), keys: [], targets: [], travel: '', nutrition: '', watch: '', adjustments: [] };
    await put(env, 'weekly', Object.fromEntries(Object.keys(w).sort().slice(-12).map((k) => [k, w[k]])));
  }
  await important(env, `Report della settimana: voto ${voto}/10`, `${rep.titolo}\n\n${rep.commento}`, 'coach');
  return { ok: true, week, numeri: rep.numeri };
}
export async function rateReport(env, week, rating, note) {
  const all = await get(env, 'reports', {});
  if (!all[week]) return null;
  all[week].rating = ['up', 'down'].includes(rating) ? rating : null; all[week].ratingNote = clean(note, 200) || null;
  await put(env, 'reports', all);
  return all[week];
}

// ---------- Note vocali: trascrizione con Workers AI Whisper ----------
export async function voice(env, req) {
  if (!env.AI) return { error: 'Trascrizione non attiva: aggiungi il binding [ai] in wrangler.toml e rifai il deploy' };
  const buf = await req.arrayBuffer();
  if (buf.byteLength < 800) return { error: 'registrazione troppo corta' };
  if (buf.byteLength > 2.5e6) return { error: 'nota vocale troppo lunga (massimo circa 2 minuti)' };
  const r = await env.AI.run('@cf/openai/whisper', { audio: [...new Uint8Array(buf)] });
  const text = clean(r?.text, 1500);
  if (!text) return { error: 'non ho capito l\'audio: riprova o scrivi' };
  const id = uid(), type = (req.headers.get('content-type') || 'audio/webm').slice(0, 60);
  await env.KV.put(`audio:${id}`, buf, { expirationTtl: 120 * 86400, metadata: { type } });
  return lucaMessage(env, text, { voice: true, audio: id });
}
export async function audio(env, id) {
  const r = await env.KV.getWithMetadata(`audio:${id}`, 'arrayBuffer');
  if (!r?.value) return new Response('Not found', { status: 404 });
  return new Response(r.value, { headers: { 'content-type': r.metadata?.type || 'audio/webm', 'cache-control': 'private, max-age=86400' } });
}

// ---------- Area gara ----------
export async function saveRace(env, b = {}) {
  const cur = await get(env, 'race', {});
  const next = { ...cur, ts: Date.now() };
  if ('hotel' in b) next.hotel = ['Maritim', 'Avani'].includes(b.hotel) ? b.hotel : '';
  if (b.notes && typeof b.notes === 'object') next.notes = Object.fromEntries(['arrivo', 'partenza', 'traguardo', 'vigilia', 'gel'].map((k) => [k, clean(b.notes[k] ?? cur.notes?.[k], 500)]));
  if (b.pack && typeof b.pack === 'object') next.pack = Object.fromEntries(Object.entries({ ...(cur.pack || {}), ...b.pack }).slice(0, 60).map(([k, v]) => [clean(k, 30), !!v]));
  if (Array.isArray(b.extra)) next.extra = b.extra.map((x) => clean(x, 60)).filter(Boolean).slice(0, 20);
  await put(env, 'race', next);
  return next;
}

// ---------- Dati per la dashboard ----------
export async function dashState(env) {
  const [chat, meteo, shoes, tests, reports, skips, race, status, badges] = await Promise.all([
    getChat(env), get(env, 'meteo', null), get(env, 'shoes', { list: [], assign: {} }), get(env, 'tests', []), get(env, 'reports', {}), get(env, 'skips', []), get(env, 'race', {}), get(env, 'mcp_status', null), get(env, 'badges', { earned: {} }),
  ]);
  return { chat: chat.slice(-80), meteo, shoes, tests, reports, skips: skips.slice(-20), race, jose: { last: status?.last_mcp_call || null }, badges: badges.earned, voice: !!env.AI };
}

// ---------- Dati in più per il briefing ----------
export async function briefingExtras(env, c) {
  const { today, settings } = c, hm = romeNow().hm;
  const [chat, shoes, tests, reports, skips, done] = await Promise.all([getChat(env), get(env, 'shoes', { list: [], assign: {} }), get(env, 'tests', []), get(env, 'reports', {}), get(env, 'skips', []), get(env, 'signals_done', {})]);
  const meteo = await refreshMeteo(env).catch(() => get(env, 'meteo', null));
  const earned = await refreshBadges(env, c, tests);
  // Nuovo = raggiunto negli ultimi 7 giorni e non ancora commentato (lo storico importato non fa rumore)
  const fresh = (b) => !done[`badge:${b.id}`] && diffDays(earned[b.id].date, today) <= 7;
  const newBadges = J.BADGES.filter((b) => earned[b.id] && fresh(b)).map((b) => ({ id: b.id, nome: b.nome, data: earned[b.id].date }));
  const places = c.trips.places || {};
  const sig = J.signals({ today, acts: c.acts, pIdx: c.pIdx, overrides: c.overrides, checkins: c.checkins, trips: c.trips, m: c.m, settings, meteo, skips, newBadges, shoes, tests, pause: c.pauses.find((p) => !p.endedOn && p.from <= today), places }).filter((s) => !done[s.id]);
  const when = (ts) => new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(ts));
  const wx = (d) => { const x = meteo?.days?.[d]; if (!x) return null; const v = J.weatherVerdict(x, settings.coldFeelsC ?? 5); return { citta: x.city, ...(x.trasferta ? { in_trasferta: x.luogo || true } : {}), condizioni: x.cond || x.day?.cond || null, minima: x.day?.min ?? null, massima: x.day?.max ?? null, ora: `${x.hour}:00`, temperatura: x.temp, percepita: x.feels, pioggia_prob_pct: x.rain_prob, pioggia_mm: x.rain_mm, vento_kmh: x.wind, ora_migliore: `${x.best.hour}:00 (percepiti ${x.best.feels} °C)`, avverso: v.bad, motivi: v.motivi, consiglio_regole: v.consiglio || null }; };
  const votes = [
    ...c.feed.filter((f) => f.rating).map((f) => ({ ts: f.ts, su: `commento (${f.kind})`, testo: f.headline, voto: f.rating, nota: f.ratingNote || null })),
    ...chat.filter((m) => m.rating).map((m) => ({ ts: m.ts, su: `messaggio (${m.kind})`, testo: m.text.slice(0, 120), voto: m.rating, nota: m.ratingNote || null })),
    ...Object.values(reports).filter((r) => r.rating).map((r) => ({ ts: r.ts, su: 'report settimanale', testo: r.titolo, voto: r.rating, nota: r.ratingNote || null })),
  ].sort((a, b) => b.ts - a.ts).slice(0, 12).map(({ ts, voto, ...x }) => ({ data: when(ts), ...x, voto: voto === 'up' ? '👍' : '👎' }));
  const lastTest = [...tests].pop() || null, lastWeek = addDays(mondayOf(today), -7);
  const upcoming = allTrips(c.trips).filter((t) => t.type !== 'vacation' && (t.end || t.start) >= today && t.start <= addDays(today, 21));
  return {
    prossimo_giro: J.nextRun(hm, settings),
    chat_in_attesa: chat.filter((m) => m.from === 'luca' && !m.answered).map((m) => ({ id: m.id, testo: m.text, ricevuto: when(m.ts), ...(m.voice ? { nota_vocale: true } : {}) })),
    chat_recente: chat.slice(-20).map((m) => ({ id: m.id, da: m.from === 'jose' ? 'José' : 'Luca', ...(m.kind ? { tipo: m.kind } : {}), testo: m.text, quando: when(m.ts), ...(m.rating ? { voto: m.rating === 'up' ? '👍' : '👎' } : {}) })),
    segnali: sig,
    valutazioni_recenti: votes,
    meteo: { soglia_freddo_percepito_c: settings.coldFeelsC ?? 5, fascia_oraria_preferita: `${Math.round(+settings.runHour || 7)}:00`, oggi: wx(today), domani: wx(addDays(today, 1)), ...(meteo?.error ? { errore: meteo.error } : {}) },
    luoghi: Object.values(places).map((p) => ({ citta: p.city, dotazioni: J.placeText(p) })),
    trasferte_in_arrivo: upcoming.map((t) => ({ dal: t.start, al: t.end || t.start, citta: t.city || t.title, dotazioni: places[placeKey(t.city || t.title)] ? J.placeText(places[placeKey(t.city || t.title)]) : t.facilities ? t.facilities.join(', ') : 'ignote: chiedile a Luca e salvale con coach_set_place_amenities' })),
    scarpe: J.shoeKm(shoes, c.acts).filter((x) => !x.retired).map((x) => ({ modello: x.model, km: x.km, soglia: x.limit, predefinita: !!x.def, da_cambiare: x.alert })),
    badge_nuovi: newBadges,
    test: { ...J.testDue(tests, today, settings), ultimo: lastTest ? { data: lastTest.date, tipo: J.TEST_TYPES[lastTest.type], km: lastTest.dist_km, tempo: J.fmtClock(lastTest.time_s), passo: fmtPace(lastTest.passo_s), fonte: lastTest.source, zone_passo: (lastTest.zone_passo || []).map((z) => `${z.nome} ${fmtPace(z.da)}-${fmtPace(z.a)}`), nota_fc: lastTest.nota_fc } : null, storico: tests.slice(-6).map((t) => `${t.date} ${t.type} ${t.dist_km} km in ${J.fmtClock(t.time_s)}`) },
    previsione: lastTest?.previsione ? { maratona: J.fmtHMS(lastTest.previsione.sec), forchetta: `${J.fmtHMS(lastTest.previsione.lo)}-${J.fmtHMS(lastTest.previsione.hi)}`, passo_gara: fmtPace(lastTest.previsione.passo_s), dal_test_del: lastTest.date, nota: 'Informativa: l\'obiettivo resta finirla. Serve a fissare il passo di gara.' } : null,
    report_settimanale: { da_scrivere: DOW_IT[new Date(today + 'T00:00:00Z').getUTCDay()] === 'Lun' && !reports[lastWeek] && lastWeek >= mondayOf(settings.planStart), settimana: lastWeek, numeri: J.weekNumbers(lastWeek, c), ultimo: Object.values(reports).pop()?.week || null },
  };
}
