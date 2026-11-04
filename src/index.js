// ============================================================================
// Marathon Coach — Cloudflare Worker
// Serve la dashboard (cartella /public), espone le API, riceve il webhook Strava,
// chiama Claude per il Coach Live Feedback, gira i cron giornaliero e settimanale.
// ============================================================================
import { generatePlan, todayISO, addDays, mondayOf } from '../public/lib/engine.js';
import { get, put, getSettings } from './store.js';
import * as st from './strava.js';
import * as sync from './sync.js';
import * as coach from './coach.js';
import { refreshTrips } from './trips.js';

const json = (d, status = 200) => new Response(JSON.stringify(d), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});
function authed(req, env, url) {
  const h = req.headers.get('authorization') || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : url.searchParams.get('k');
  return !!env.DASH_TOKEN && t === env.DASH_TOKEN;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url), p = url.pathname, m = req.method;
    try {
      if (p === '/webhook') return m === 'GET' ? webhookVerify(url, env) : webhookEvent(req, env, ctx);
      if (p === '/auth/strava') {
        if (!authed(req, env, url)) return new Response('Token dashboard mancante o errato', { status: 401 });
        const state = crypto.randomUUID();
        await env.KV.put('oauth_state', state, { expirationTtl: 600 });
        return Response.redirect(st.authUrl(env, `${url.origin}/auth/callback`, state), 302);
      }
      if (p === '/auth/callback') return oauthCallback(url, env, ctx);
      if (p.startsWith('/api/')) {
        if (!authed(req, env, url)) return json({ error: 'unauthorized' }, 401);
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

// ---------- Strava webhook ----------
function webhookVerify(url, env) {
  if (url.searchParams.get('hub.verify_token') !== env.STRAVA_VERIFY_TOKEN) return json({ error: 'verify token errato' }, 403);
  return json({ 'hub.challenge': url.searchParams.get('hub.challenge') });
}
async function webhookEvent(req, env, ctx) {
  const ev = await req.json().catch(() => null);
  if (!ev || ev.object_type !== 'activity') return json({ ok: true });
  const tok = await get(env, 'tokens');
  if (!tok || String(ev.owner_id) !== String(tok.athlete_id)) return json({ ok: true });
  ctx.waitUntil(handleActivityEvent(env, ev)); // Strava vuole risposta entro 2s
  return json({ ok: true });
}
async function handleActivityEvent(env, ev) {
  try {
    if (ev.aspect_type === 'delete') return sync.remove(env, ev.object_id);
    const a = await sync.ingest(env, ev.object_id);
    if (ev.aspect_type === 'create' && !a.analyzed) await coach.analyzeActivity(env, a);
  } catch (e) { console.error('webhook', e.message); }
}

// ---------- OAuth ----------
async function oauthCallback(url, env, ctx) {
  const state = url.searchParams.get('state');
  const saved = await env.KV.get('oauth_state');
  if (!state || state !== saved) return new Response('Stato OAuth non valido: riparti dalla dashboard', { status: 400 });
  await env.KV.delete('oauth_state');
  if (url.searchParams.get('error')) return Response.redirect(`${url.origin}/?strava=denied`, 302);
  const scope = url.searchParams.get('scope') || '';
  const tokens = await st.exchange(env, url.searchParams.get('code'), scope);
  await put(env, 'tokens', tokens);
  ctx.waitUntil((async () => {
    try { await sync.backfill(env); } catch (e) { console.error('backfill', e.message); }
    try { await st.subscribe(env, `${url.origin}/webhook`).then((r) => put(env, 'meta', { subscription: r.id, lastSync: Date.now() })); } catch (e) { console.error('subscribe', e.message); }
  })());
  return Response.redirect(`${url.origin}/?strava=${scope.includes('activity:read_all') ? 'ok' : 'scope'}`, 302);
}

// ---------- API dashboard ----------
async function state(env) {
  const [settings, plan0, overrides, activities, trips, checkins, feed, weekly, tokens, meta] = await Promise.all([
    getSettings(env), get(env, 'plan'), get(env, 'overrides', {}), get(env, 'activities', []), get(env, 'trips', { manual: [], ical: [] }),
    get(env, 'checkins', {}), get(env, 'feed', []), get(env, 'weekly', {}), get(env, 'tokens'), get(env, 'meta', {}),
  ]);
  let plan = plan0;
  if (!plan) { plan = generatePlan(settings); await put(env, 'plan', plan); }
  return {
    settings, plan, overrides, activities, trips, checkins, feed, weekly, meta,
    strava: { connected: !!tokens, athlete: tokens?.athlete_name || null, scopeOk: !!tokens?.scope?.includes('activity:read_all'), subscription: meta?.subscription || null },
    ai: !!env.ANTHROPIC_API_KEY, telegram: !!env.TELEGRAM_BOT_TOKEN, serverToday: todayISO(),
  };
}

async function api(p, m, req, env, ctx, url) {
  const body = m === 'POST' ? await req.json().catch(() => ({})) : {};

  if (p === '/api/state' && m === 'GET') return json(await state(env));

  if (p === '/api/sync' && m === 'POST') {
    const r = await sync.pullRecent(env, 3);
    for (const a of r.added) if (!a.analyzed) ctx.waitUntil(coach.analyzeActivity(env, a));
    return json({ added: r.added.length, refreshed: r.refreshed.length });
  }

  if (p === '/api/checkin' && m === 'POST') {
    const d = body.date || todayISO();
    const all = await get(env, 'checkins', {});
    all[d] = { date: d, sleep: +body.sleep || 3, energy: +body.energy || 3, soreness: +body.soreness || 0, stress: +body.stress || 3, travel: !!body.travel, pain: { area: String(body.pain?.area || '').slice(0, 40), level: +body.pain?.level || 0 }, note: String(body.note || '').slice(0, 300), ts: Date.now() };
    const keep = Object.keys(all).sort().slice(-90);
    await put(env, 'checkins', Object.fromEntries(keep.map((k) => [k, all[k]])));
    ctx.waitUntil(coach.dailyCheck(env, d));
    return json({ ok: true });
  }

  let mm = p.match(/^\/api\/activity\/(\d+)\/rpe$/);
  if (mm && m === 'POST') {
    const list = await get(env, 'activities', []);
    const a = list.find((x) => String(x.id) === mm[1]);
    if (!a) return json({ error: 'attività non trovata' }, 404);
    a.rpe = Math.max(1, Math.min(10, +body.rpe || 0)) || null; a.rpe_src = a.rpe ? 'manuale' : null;
    await put(env, 'activities', list);
    return json({ ok: true });
  }
  mm = p.match(/^\/api\/activity\/(\d+)\/analyze$/);
  if (mm && m === 'POST') {
    const a = (await get(env, 'activities', [])).find((x) => String(x.id) === mm[1]);
    if (!a) return json({ error: 'attività non trovata' }, 404);
    ctx.waitUntil(coach.analyzeActivity(env, a));
    return json({ ok: true, queued: true });
  }

  if (p === '/api/settings' && m === 'POST') {
    const s = { ...(await getSettings(env)), ...body };
    await put(env, 'settings', s);
    if ('icalUrls' in body) ctx.waitUntil(refreshTrips(env));
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
    if (body.session) o[body.date] = { ...body.session, date: body.date, override: true, reason: String(body.reason || '').slice(0, 200) };
    else delete o[body.date];
    await put(env, 'overrides', o);
    return json({ ok: true });
  }

  if (p === '/api/trips' && m === 'POST') {
    const t = await get(env, 'trips', { manual: [], ical: [] });
    t.manual = (body.manual || []).slice(0, 200);
    await put(env, 'trips', t);
    return json(t);
  }
  if (p === '/api/trips/refresh' && m === 'POST') return json(await refreshTrips(env));

  if (p === '/api/coach/ask' && m === 'POST') {
    if (!body.q) return json({ error: 'domanda vuota' }, 400);
    ctx.waitUntil(coach.ask(env, body.q));
    return json({ ok: true, queued: true });
  }
  if (p === '/api/coach/weekly' && m === 'POST') {
    ctx.waitUntil(coach.weekly(env, body.week));
    return json({ ok: true, queued: true });
  }
  if (p === '/api/feed/clear' && m === 'POST') { await put(env, 'feed', []); return json({ ok: true }); }

  if (p === '/api/strava/subscribe' && m === 'POST') {
    const r = await st.subscribe(env, `${url.origin}/webhook`);
    const meta = await get(env, 'meta', {}); meta.subscription = r.id; await put(env, 'meta', meta);
    return json(r);
  }
  if (p === '/api/strava/backfill' && m === 'POST') return json(await sync.backfill(env));

  return json({ error: 'endpoint sconosciuto' }, 404);
}

// ---------- Cron ----------
async function runCron(cron, env) {
  const today = todayISO();
  if (cron.includes('SUN')) {
    try { await coach.weekly(env, addDays(mondayOf(today), 7)); } catch (e) { console.error('weekly', e.message); }
    return;
  }
  // Giornaliero: trasferte da iCal + recupero uscite non arrivate col webhook (es. RPE aggiunto dopo)
  try { await refreshTrips(env); } catch (e) { console.error('trips', e.message); }
  if (await get(env, 'tokens')) {
    try {
      const r = await sync.pullRecent(env, 3);
      for (const a of r.added) if (!a.analyzed) await coach.analyzeActivity(env, a);
    } catch (e) { console.error('cron sync', e.message); }
  }
}
