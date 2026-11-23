// ============================================================================
// Marathon Coach — Cloudflare Worker
// Serve la dashboard (cartella /public), espone le API, legge le uscite da Intervals.icu
// (cron ogni 10 minuti), chiama Claude per il Coach Live Feedback, gira i cron giornaliero e settimanale.
// ============================================================================
import { generatePlan, todayISO, addDays, mondayOf, planWeeks, placeKey, PLAN_MIN_WEEKS, PLAN_MAX_WEEKS } from '../public/lib/engine.js';
import { get, put, getSettings, getFeed, clearFeed, getCheckins, putCheckin, repairSnapshots } from './store.js';
import * as iv from './intervals.js';
import * as sync from './sync.js';
import * as coach from './coach.js';
import { refreshTrips } from './trips.js';
import { handleMcp, mcpAuthorized } from './mcp.js';
import * as Z from './jose.js';
import * as P from './personal.js';
import { syncGarmin } from './garmin.js';
import { romeNow, digest, flushQueue, rememberOrigin } from './notify.js';
import { patchFeed } from './store.js';

const json = (d, status = 200) => new Response(JSON.stringify(d), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});
// Confronto del token a tempo costante: si confrontano gli hash SHA-256 byte per byte,
// così il tempo di risposta non dice quanti caratteri erano giusti.
const sha256 = async (v) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(v))));
async function authed(req, env) {
  if (!env.DASH_TOKEN) return false;
  const h = req.headers.get('authorization') || '';
  if (!h.startsWith('Bearer ')) return false; // il token viaggia solo nell'header, mai nell'URL
  const [a, b] = await Promise.all([sha256(h.slice(7)), sha256(env.DASH_TOKEN)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url), p = url.pathname, m = req.method;
    try {
      // Connettore per Claude: /mcp con "Authorization: Bearer <MCP_SECRET>" (in transizione vale ancora /mcp/<MCP_SECRET>)
      if (p === '/mcp' || p.startsWith('/mcp/')) {
        if (!(await mcpAuthorized(req, env, p))) return p === '/mcp' ? new Response('Unauthorized', { status: 401, headers: { 'www-authenticate': 'Bearer' } }) : new Response('Not found', { status: 404 });
        return await handleMcp(req, env);
      }
      if (p.startsWith('/api/')) {
        if (!(await authed(req, env))) return json({ error: 'unauthorized' }, 401);
        ctx.waitUntil(rememberOrigin(env, url.origin).catch(() => {}));
        return await api(p, m, req, env, ctx, url);
      }
      return env.ASSETS.fetch(req);
    } catch (e) {
      console.error(e);
      return json({ error: String(e.message || e) }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCron(event.cron, env));
  },
};

// ---------- Intervals.icu: controllo nuove uscite ----------
// Scarica ciò che è nuovo o cambiato e restituisce le uscite recenti ancora da far analizzare al coach
async function syncNow(env) {
  try {
    const r = await sync.pullRecent(env, 3);
    const since = addDays(todayISO(), -2); // lo storico importato non viene analizzato, solo le uscite fresche
    return { ...r, fresh: r.added.filter((a) => !a.analyzed && a.date >= since) };
  } catch (e) { await sync.noteError(env, e).catch(() => {}); throw e; }
}

// ---------- API dashboard ----------
async function state(env) {
  const [settings, plan0, overrides, activities, trips, checkins, feed, weekly, meta, logs, pauses, garmin, profile, memory, review, inbox] = await Promise.all([
    getSettings(env), get(env, 'plan'), get(env, 'overrides', {}), get(env, 'activities', []), get(env, 'trips', { manual: [], ical: [] }),
    getCheckins(env), getFeed(env), get(env, 'weekly', {}), get(env, 'meta', {}), get(env, 'logs', []), get(env, 'pauses', []), get(env, 'garmin_sync', null),
    get(env, 'profile', null), get(env, 'coach_memory', { facts: [] }), get(env, 'review', {}), get(env, 'inbox', []),
  ]);
  let plan = plan0;
  if (!plan) { plan = generatePlan(settings); await put(env, 'plan', plan); }
  return {
    ...(await Z.dashState(env)),
    settings, plan, overrides, activities, trips, checkins, feed, weekly, meta, logs, pauses, garmin,
    profile, memory: memory.facts || [], review, inbox: inbox.length, connector: !!env.MCP_SECRET,
    intervals: { connected: iv.configured(env), athlete: meta?.athlete || null, imported: !!meta?.backfilled, error: meta?.syncError || null, stravaStubs: meta?.stravaStubs || 0 },
    ai: !!env.ANTHROPIC_API_KEY, telegram: !!env.TELEGRAM_BOT_TOKEN, serverToday: todayISO(),
  };
}

async function api(p, m, req, env, ctx, url) {
  // Nota vocale: il corpo è l'audio, non JSON
  if (p === '/api/chat/voice' && m === 'POST') { const r = await Z.voice(env, req); return json(r, r.error ? 400 : 200); }
  let am = p.match(/^\/api\/chat\/audio\/([\w-]+)$/);
  if (am && m === 'GET') return Z.audio(env, am[1]);
  const body = m === 'POST' ? await req.json().catch(() => ({})) : {};
  const reply = (r) => json(r, r?.error ? 400 : 200);

  // ---------- José: chat, voti, "Non riesco", test, scarpe, luoghi, gara ----------
  if (p === '/api/chat' && m === 'POST') return reply(await Z.lucaMessage(env, body.text));
  if (p === '/api/rate' && m === 'POST') {
    const r = body.type === 'chat' ? await Z.rateChat(env, String(body.id || ''), body.rating, body.note) : body.type === 'report' ? await Z.rateReport(env, String(body.id || ''), body.rating, body.note)
      : await patchFeed(env, String(body.id || ''), { rating: ['up', 'down'].includes(body.rating) ? body.rating : null, ratingNote: String(body.note || '').slice(0, 200) || null });
    return r ? json({ ok: true }) : json({ error: 'elemento non trovato' }, 404);
  }
  if (p === '/api/skip' && m === 'POST') return reply(await Z.skip(env, body));
  if (p === '/api/tests' && m === 'POST') return reply(await Z.recordTest(env, body));
  if (p === '/api/tests/delete' && m === 'POST') return reply(await Z.deleteTest(env, String(body.id || '')));
  if (p === '/api/shoes' && m === 'POST') return json(await Z.saveShoes(env, body.list));
  if (p === '/api/place' && m === 'POST') return reply(await Z.setPlace(env, body));
  if (p === '/api/race' && m === 'POST') return json(await Z.saveRace(env, body));
  if (p === '/api/meteo' && m === 'POST') return json(await Z.refreshMeteo(env, 0));
  am = p.match(/^\/api\/activity\/([\w-]+)\/shoe$/);
  if (am && m === 'POST') return reply(await Z.assignShoe(env, am[1], body.shoe ? String(body.shoe) : null));

  if (p === '/api/state' && m === 'GET') return json(await state(env));

  if (p === '/api/sync' && m === 'POST') {
    if (!iv.configured(env)) return json({ error: 'Intervals.icu non collegato: imposta il secret INTERVALS_API_KEY sul Worker' }, 400);
    const r = await syncNow(env);
    for (const a of r.fresh) ctx.waitUntil(coach.analyzeActivity(env, a).then(() => Z.autoTest(env, a)).catch((e) => console.error('analisi', e.message)));
    return json({ added: r.added.length, refreshed: r.refreshed.length, removed: r.removed, backfilled: r.backfilled || 0 });
  }

  if (p === '/api/checkin' && m === 'POST') {
    const d = body.date || todayISO();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return json({ error: 'data non valida' }, 400);
    // Una chiave per giorno (checkin:<data>): nessuna rilettura/riscrittura dell'intero storico
    // Check-in corto: energia 1-5, gambe 1-5, fastidio (zona + 1-10), giornata. Niente sonno.
    const lv = (v, lo, hi, def) => (Number.isFinite(+v) && v !== null && v !== '' ? Math.max(lo, Math.min(hi, Math.round(+v))) : def);
    const pain = lv(body.pain?.level, 0, 10, 0);
    await putCheckin(env, { date: d, energy: lv(body.energy, 1, 5, 3), legs: lv(body.legs, 1, 5, 2), day: ['light', 'normal', 'heavy'].includes(body.day) ? body.day : 'normal', pain: { area: pain ? String(body.pain?.area || '').slice(0, 40) : '', level: pain }, ts: Date.now() });
    ctx.waitUntil(coach.dailyCheck(env, d).then(() => d === todayISO() && syncGarmin(env, 'check-in')).catch((e) => console.error('checkin', e.message)));
    return json({ ok: true });
  }

  let mm = p.match(/^\/api\/activity\/([\w-]+)\/rpe$/);
  if (mm && m === 'POST') {
    const list = await get(env, 'activities', []);
    const a = list.find((x) => String(x.id) === mm[1]);
    if (!a) return json({ error: 'attività non trovata' }, 404);
    a.rpe = Math.max(1, Math.min(10, +body.rpe || 0)) || null; a.rpe_src = a.rpe ? 'manuale' : null;
    await put(env, 'activities', list);
    return json({ ok: true });
  }
  mm = p.match(/^\/api\/activity\/([\w-]+)\/analyze$/);
  if (mm && m === 'POST') {
    const a = (await get(env, 'activities', [])).find((x) => String(x.id) === mm[1]);
    if (!a) return json({ error: 'attività non trovata' }, 404);
    ctx.waitUntil(coach.analyzeActivity(env, a));
    return json({ ok: true, queued: true });
  }

  if (p === '/api/settings' && m === 'POST') {
    const cur = await getSettings(env);
    const v = validateSettings(body, cur);
    if (v.error) return json({ error: v.error }, 400);
    const s = { ...cur, ...v.patch };
    await put(env, 'settings', s);
    if ('icalUrls' in v.patch) ctx.waitUntil(refreshTrips(env));
    return json(s);
  }

  if (p === '/api/plan' && m === 'POST') {
    const s = await getSettings(env);
    if (body.mode === 'generate') {
      const plan = generatePlan(s);
      await put(env, 'plan', plan); await put(env, 'settings', { ...s, planSource: 'generated' });
      return json({ ok: true, count: plan.length });
    }
    if (body.mode === 'import' && Array.isArray(body.sessions) && body.sessions.length) {
      await put(env, 'plan', body.sessions.slice(0, 800)); await put(env, 'settings', { ...s, planSource: 'import' });
      return json({ ok: true, count: body.sessions.length });
    }
    return json({ error: 'mode non valido' }, 400);
  }

  if (p === '/api/override' && m === 'POST') {
    const o = await get(env, 'overrides', {});
    if (!body.date) return json({ error: 'date mancante' }, 400);
    if (body.session) o[body.date] = { ...body.session, date: body.date, override: true, manual: true, ts: Date.now(), reason: String(body.reason || '').slice(0, 200) };
    else delete o[body.date];
    await put(env, 'overrides', o);
    ctx.waitUntil(syncGarmin(env, 'modifica').catch((e) => console.error('garmin', e.message)));
    return json({ ok: true });
  }

  if (p === '/api/trips' && m === 'POST') {
    const t = await get(env, 'trips', { manual: [], ical: [] });
    const okDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
    t.manual = (Array.isArray(body.manual) ? body.manual : []).filter((x) => okDate(x?.start)).slice(0, 200).map((x) => ({
      id: String(x.id || crypto.randomUUID()).slice(0, 40), start: x.start, end: okDate(x.end) && x.end >= x.start ? x.end : x.start,
      city: String(x.city || 'Trasferta').slice(0, 40), type: x.type === 'vacation' ? 'vacation' : 'work', source: 'manual',
      facilities: cleanFacilities(x.facilities),
    }));
    t.manualUpdated = Date.now();
    await put(env, 'trips', t);
    await Z.refreshMeteo(env, 0).catch(() => {});
    return json(t);
  }
  // Cosa c'è in trasferta (domanda dei 2 giorni prima): vale anche per le trasferte del calendario
  if (p === '/api/trips/facilities' && m === 'POST') {
    if (typeof body.key !== 'string' || !body.key) return json({ error: 'trasferta mancante' }, 400);
    const t = await get(env, 'trips', { manual: [], ical: [] });
    t.facilities = { ...(t.facilities || {}), [body.key.slice(0, 80)]: { f: cleanFacilities(body.facilities) || [], ts: Date.now() } };
    // tiene solo le risposte recenti
    t.facilities = Object.fromEntries(Object.entries(t.facilities).filter(([k]) => k.slice(0, 10) >= addDays(todayISO(), -60)));
    // Le dotazioni valgono per la città: si riusano alle trasferte successive
    const fl = cleanFacilities(body.facilities) || [];
    if (body.city && fl.length) { const k = placeKey(body.city); t.places = { ...(t.places || {}), [k]: { ...(t.places?.[k] || {}), city: String(body.city).slice(0, 40), treadmill: fl.includes('treadmill'), gym: fl.includes('gym'), outdoor: fl.includes('outdoor'), early_breakfast: fl.includes('breakfast'), ts: Date.now() } }; }
    await put(env, 'trips', t);
    return json(t);
  }
  if (p === '/api/trips/refresh' && m === 'POST') { const t = await refreshTrips(env); await Z.refreshMeteo(env, 0).catch(() => {}); return json(t); }

  // "Fatto" su forza/mobilità
  if (p === '/api/log' && m === 'POST') {
    const d = body.date, today = todayISO();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d || '') || d > today || d < addDays(today, -60)) return json({ error: 'data non valida (oggi o negli ultimi 60 giorni)' }, 400);
    const kind = body.kind === 'mobility' ? 'mobility' : 'strength';
    const min = Math.round(+body.min || 0);
    if (min < 1 || min > 180) return json({ error: 'durata tra 1 e 180 minuti' }, 400);
    const rpe = body.rpe == null || body.rpe === '' ? null : Math.round(+body.rpe);
    if (rpe != null && (rpe < 1 || rpe > 10)) return json({ error: 'RPE tra 1 e 10' }, 400);
    const routine = ['A', 'B', 'C', 'D'].includes(body.routine) ? body.routine : null;
    const logs = (await get(env, 'logs', [])).filter((l) => !(l.date === d && l.kind === kind));
    logs.push({ date: d, kind, routine, min, rpe, ts: Date.now() });
    await put(env, 'logs', logs.sort((a, b) => a.date.localeCompare(b.date)).slice(-400));
    return json({ ok: true });
  }
  if (p === '/api/log/delete' && m === 'POST') {
    const logs = (await get(env, 'logs', [])).filter((l) => !(l.date === body.date && l.kind === body.kind));
    await put(env, 'logs', logs);
    return json({ ok: true });
  }
  // Corsa fatta senza orologio: va su intervals.icu (così i dati restano in un posto solo), altrimenti resta qui
  if (p === '/api/activity/manual' && m === 'POST') {
    const d = body.date, today = todayISO();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d || '') || d > today || d < addDays(today, -60)) return json({ error: 'data non valida' }, 400);
    const min = +body.min, km = +body.km || 0, rpe = body.rpe ? Math.round(+body.rpe) : null;
    if (!(min >= 5 && min <= 360)) return json({ error: 'durata tra 5 e 360 minuti' }, 400);
    if (km < 0 || km > 60) return json({ error: 'distanza non valida' }, 400);
    if (rpe != null && (rpe < 1 || rpe > 10)) return json({ error: 'RPE tra 1 e 10' }, 400);
    const note = String(body.note || '').slice(0, 200);
    let a = null, warning = null;
    if (iv.configured(env)) {
      try {
        const r = await iv.createManual(env, { date: d, min, km, rpe, note });
        if (r?.id) a = iv.normalize({ ...r, start_date_local: r.start_date_local || `${d}T12:00:00`, type: r.type || 'Run', moving_time: r.moving_time || min * 60, distance: r.distance ?? km * 1000, description: r.description ?? note, icu_rpe: r.icu_rpe ?? rpe });
      } catch (e) { warning = `Non sono riuscito a crearla su intervals.icu (${e.message}): resta solo nella dashboard`; }
    }
    if (!a) a = { id: 'm-' + crypto.randomUUID().slice(0, 8), src: 'manual', date: d, start: `${d}T12:00:00`, name: 'Corsa (inserita a mano)', type: 'Run', dist_km: Math.round(km * 100) / 100, moving_min: min, elapsed_min: min, avg_hr: null, speed: km > 0 ? (km * 1000) / (min * 60) : 0, pace_s: km > 0 ? Math.round((min * 60) / km) : null, desc: note, rpe, rpe_src: rpe ? 'manuale' : null };
    const list = (await get(env, 'activities', [])).filter((x) => String(x.id) !== String(a.id));
    list.push(a); list.sort((x, y) => (x.start || x.date).localeCompare(y.start || y.date));
    await put(env, 'activities', list);
    return json({ ok: true, activity: a, warning });
  }
  // "Mi fermo" / "Riprendo"
  if (p === '/api/pause' && m === 'POST') {
    const today = todayISO(), from = /^\d{4}-\d{2}-\d{2}$/.test(body.from || '') ? body.from : today;
    const to = /^\d{4}-\d{2}-\d{2}$/.test(body.to || '') ? body.to : null;
    if (from > addDays(today, 30) || from < addDays(today, -14)) return json({ error: 'inizio pausa tra 14 giorni fa e 30 giorni da oggi' }, 400);
    if (to && to < from) return json({ error: 'il rientro è prima dell\'inizio' }, 400);
    const pauses = await get(env, 'pauses', []);
    if (pauses.some((x) => !x.endedOn)) return json({ error: 'c\'è già una pausa in corso' }, 400);
    const reason = ['illness', 'injury', 'busy', 'other'].includes(body.reason) ? body.reason : 'other';
    pauses.push({ id: crypto.randomUUID().slice(0, 8), from, to, reason, note: String(body.note || '').slice(0, 200), ts: Date.now() });
    await put(env, 'pauses', pauses.slice(-30));
    ctx.waitUntil(syncGarmin(env, 'pausa').catch(() => {}));
    return json({ ok: true, pauses });
  }
  if (p === '/api/pause/end' && m === 'POST') {
    const pauses = await get(env, 'pauses', []), x = pauses.find((q) => q.id === body.id && !q.endedOn);
    if (!x) return json({ error: 'pausa non trovata' }, 404);
    const today = todayISO();
    x.endedOn = x.from > today ? x.from : today; // rientro da oggi (una pausa futura annullata non lascia giorni)
    await put(env, 'pauses', pauses);
    ctx.waitUntil(syncGarmin(env, 'rientro').catch(() => {}));
    return json({ ok: true, pauses });
  }

  // ---------- Profilo, memoria, check-up (coach personale) ----------
  if (p === '/api/profile' && m === 'POST') { const pr = P.cleanProfile(body); await put(env, 'profile', { ...pr, updatedAt: Date.now() }); return json({ ok: true, profile: pr }); }
  if (p === '/api/profile/export' && m === 'GET') return json({ profile: await get(env, 'profile', null), memory: await get(env, 'coach_memory', { facts: [] }), exportedAt: new Date().toISOString() });
  if (p === '/api/profile/delete' && m === 'POST') { await env.KV.delete('profile'); await env.KV.delete('coach_memory'); return json({ ok: true }); }
  if (p === '/api/memory/delete' && m === 'POST') return json({ ok: true, facts: await P.updateMemory(env, { remove: [String(body.id || '')] }) });
  if (p === '/api/review/answers' && m === 'POST') { const r = await P.saveAnswers(env, body.answers || {}); return json(r, r.error ? 400 : 200); }
  if (p === '/api/review/request' && m === 'POST') {
    const r = await get(env, 'review', {});
    if (r.status === 'questions') return json({ error: 'c\'è già un check-up aperto: rispondi alle domande' }, 400);
    await put(env, 'review', { ...r, requested: true });
    return json({ ok: true });
  }
  if (p === '/api/review/undo' && m === 'POST') { const r = await P.undoReview(env, String(body.snapshotId || '')); return json(r, r.error ? 400 : 200); }
  mm = p.match(/^\/api\/feed\/([\w-]+)\/(rate|applied)$/);
  if (mm && m === 'POST') {
    const patch = mm[2] === 'applied' ? { applied: true } : { rating: ['up', 'down'].includes(body.rating) ? body.rating : null, ratingNote: String(body.note || '').slice(0, 200) || null };
    const e = await patchFeed(env, mm[1], patch);
    return e ? json({ ok: true }) : json({ error: 'elemento non trovato' }, 404);
  }
  if (p === '/api/garmin/sync' && m === 'POST') return json(await syncGarmin(env, 'manuale'));

  if (p === '/api/coach/ask' && m === 'POST') {
    if (!body.q) return json({ error: 'domanda vuota' }, 400);
    ctx.waitUntil(coach.ask(env, body.q));
    return json({ ok: true, queued: true });
  }
  if (p === '/api/coach/weekly' && m === 'POST') {
    ctx.waitUntil(coach.weekly(env, body.week));
    return json({ ok: true, queued: true });
  }
  if (p === '/api/feed/clear' && m === 'POST') { await clearFeed(env); return json({ ok: true }); }

  // Verifica del collegamento: legge il profilo dell'atleta con la API key configurata
  if (p === '/api/intervals/test' && m === 'POST') {
    if (!iv.configured(env)) return json({ ok: false, error: 'Manca il secret INTERVALS_API_KEY sul Worker' });
    try { const a = await iv.athlete(env); return json({ ok: true, athlete: a.name, id: a.id }); } catch (e) { return json({ ok: false, error: e.message }); }
  }
  // Rilegge le zone FC della corsa da intervals.icu
  if (p === '/api/intervals/zones' && m === 'POST') {
    if (!iv.configured(env)) return json({ error: 'Intervals.icu non collegato' }, 400);
    const z = await sync.refreshZones(env);
    return json({ ok: !!z, zones: z, error: z ? null : 'Su intervals.icu non ci sono zone FC per la corsa: impostale in Settings → Run' });
  }
  if (p === '/api/intervals/backfill' && m === 'POST') {
    if (!iv.configured(env)) return json({ error: 'Intervals.icu non collegato: imposta il secret INTERVALS_API_KEY sul Worker' }, 400);
    try { return json(await sync.backfill(env)); } catch (e) { await sync.noteError(env, e).catch(() => {}); throw e; }
  }

  return json({ error: 'endpoint sconosciuto' }, 404);
}

const cleanFacilities = (f) => (Array.isArray(f) ? [...new Set(f.filter((x) => ['room', 'treadmill', 'gym', 'outdoor', 'breakfast'].includes(x)))] : null);

// ---------- Impostazioni: solo campi noti, con tipo e intervallo (gli stessi min/max del form) ----------
const NUM_FIELDS = {
  age: { min: 15, max: 90, nullable: true, label: 'Età' },
  weightKg: { min: 40, max: 150, nullable: true, label: 'Peso' },
  hrMax: { min: 140, max: 220, nullable: true, label: 'FC max' },
  hrRest: { min: 35, max: 90, nullable: false, label: 'FC a riposo' },
  runHour: { min: 5, max: 22, nullable: false, label: 'Ora abituale di corsa' },
  coldFeelsC: { min: -10, max: 15, nullable: false, label: 'Soglia del freddo percepito' },
};
export function validateSettings(body, current = {}) {
  const patch = {};
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'corpo della richiesta non valido' };
  for (const [k, f] of Object.entries(NUM_FIELDS)) {
    if (!(k in body)) continue;
    const v = body[k];
    if (v === null || v === '') { if (!f.nullable) return { error: `${f.label}: valore obbligatorio` }; patch[k] = null; continue; }
    if (typeof v !== 'number' || !Number.isFinite(v) || v < f.min || v > f.max) return { error: `${f.label}: serve un numero tra ${f.min} e ${f.max}` };
    patch[k] = v;
  }
  if ('longRunDay' in body) {
    if (body.longRunDay !== 0 && body.longRunDay !== 6) return { error: 'Giorno del lungo: 0 (domenica) o 6 (sabato)' };
    patch.longRunDay = body.longRunDay;
  }
  if ('homeCity' in body) {
    if (typeof body.homeCity !== 'string' || !body.homeCity.trim()) return { error: 'Città di casa: serve un testo' };
    patch.homeCity = body.homeCity.trim().slice(0, 40);
  }
  for (const [k, label] of [['runMorning', 'Giro del mattino'], ['runEvening', 'Giro della sera']]) {
    if (!(k in body)) continue;
    if (typeof body[k] !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(body[k])) return { error: `${label}: orario nel formato HH:MM` };
    patch[k] = body[k];
  }
  if ('raceName' in body) {
    if (typeof body.raceName !== 'string') return { error: 'Nome gara: serve un testo' };
    patch.raceName = body.raceName.trim().slice(0, 40) || 'Maratona';
  }
  // Inizio preparazione e data gara: date valide e una distanza che tenga in piedi le fasi del piano
  const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v + 'T00:00:00Z'));
  for (const [k, label] of [['planStart', 'Inizio preparazione'], ['raceDate', 'Data gara']]) {
    if (!(k in body)) continue;
    if (!isDate(body[k])) return { error: `${label}: data non valida` };
    patch[k] = body[k];
  }
  if ('planStart' in patch || 'raceDate' in patch) {
    const start = patch.planStart || current.planStart, race = patch.raceDate || current.raceDate;
    const w = planWeeks(start, race);
    if (w < PLAN_MIN_WEEKS) return { error: `Tra inizio preparazione e gara servono almeno ${PLAN_MIN_WEEKS} settimane (ora sono ${Math.max(0, w)})` };
    if (w > PLAN_MAX_WEEKS) return { error: `Tra inizio preparazione e gara al massimo ${PLAN_MAX_WEEKS} settimane (ora sono ${w})` };
  }
  if ('icalUrls' in body) {
    if (typeof body.icalUrls !== 'string') return { error: 'URL iCal: serve un testo, un indirizzo per riga' };
    const urls = body.icalUrls.split(/\s+/).filter(Boolean);
    if (urls.length > 5) return { error: 'URL iCal: massimo 5 calendari' };
    for (const u of urls) {
      let ok = false;
      try { ok = new URL(u).protocol === 'https:' && u.length <= 500; } catch { /* non è un URL */ }
      if (!ok) return { error: 'URL iCal: sono ammessi solo indirizzi https://' };
    }
    patch.icalUrls = urls.join('\n');
  }
  return { patch };
}

// ---------- Cron (uno solo, ogni 10 minuti: i lavori a orario seguono l'ora di Roma, anche con l'ora legale) ----------
async function runCron(cron, env) {
  const today = todayISO(), now = romeNow();
  if (iv.configured(env)) {
    try { const r = await syncNow(env); for (const a of r.fresh) { await coach.analyzeActivity(env, a); await Z.autoTest(env, a).catch((e) => console.error('test', e.message)); } } catch (e) { console.error('sync', e.message); }
  }
  // Trasferte dal calendario: rilette ogni ora (06-23), così un evento aggiunto in giornata arriva subito
  if (now.hm >= '06:00' && now.hm <= '23:00') {
    try { const t = await get(env, 'trips', {}); if (Date.now() - (t.icalUpdated || 0) > 55 * 60e3) await refreshTrips(env); } catch (e) { console.error('trips', e.message); }
  }
  // Meteo di oggi e domani (Open-Meteo): si rinfresca da solo ogni 3 ore, o subito se cambiano le trasferte
  if (now.hm >= '05:00') {
    try { await Z.refreshMeteo(env); } catch (e) { console.error('meteo', e.message); }
  }
  const st = await get(env, 'cron_state', {}), done = (k) => st[k] === now.date;
  const jobs = [];
  if (now.hm >= '05:30' && !done('daily')) jobs.push(['daily', async () => {
    await repairSnapshots(env); await refreshTrips(env);
    if (iv.configured(env)) { await sync.refreshZones(env); await syncGarmin(env, 'giornaliero'); }
  }]);
  if (now.hm >= '07:00' && !done('flush')) jobs.push(['flush', () => flushQueue(env)]);
  if (now.dow === 'Sun' && now.hm >= '19:00' && !done('weekly')) jobs.push(['weekly', () => coach.weekly(env, addDays(mondayOf(today), 7))]);
  if (now.hm >= '21:45' && !done('digest')) jobs.push(['digest', () => digest(env)]);
  if (!jobs.length) return;
  for (const [k, fn] of jobs) { try { await fn(); } catch (e) { console.error(k, e.message); } st[k] = now.date; }
  await put(env, 'cron_state', st);
}
