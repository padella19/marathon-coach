// Connettore Strava API v3 — OAuth, refresh token, attività, streams, webhook
import { get, put } from './store.js';
import { histFromStreams, decouplingFromStreams, hrBucket } from '../public/lib/engine.js';

const API = 'https://www.strava.com/api/v3';
const OAUTH = 'https://www.strava.com/oauth';

export function authUrl(env, redirect, state) {
  const q = new URLSearchParams({
    client_id: env.STRAVA_CLIENT_ID, response_type: 'code', redirect_uri: redirect,
    approval_prompt: 'auto', scope: 'read,activity:read_all', state,
  });
  return `${OAUTH}/authorize?${q}`;
}

async function tokenRequest(env, params) {
  const r = await fetch(`${OAUTH}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.STRAVA_CLIENT_ID, client_secret: env.STRAVA_CLIENT_SECRET, ...params }),
  });
  if (!r.ok) throw new Error(`Strava OAuth ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

export async function exchange(env, code, scope) {
  const t = await tokenRequest(env, { code, grant_type: 'authorization_code' });
  return {
    access_token: t.access_token, refresh_token: t.refresh_token, expires_at: t.expires_at,
    athlete_id: t.athlete?.id, athlete_name: [t.athlete?.firstname, t.athlete?.lastname].filter(Boolean).join(' '), scope,
  };
}

export async function accessToken(env) {
  const t = await get(env, 'tokens');
  if (!t) throw new Error('Strava non collegato');
  if (t.expires_at * 1000 > Date.now() + 120_000) return t.access_token;
  const n = await tokenRequest(env, { grant_type: 'refresh_token', refresh_token: t.refresh_token });
  const merged = { ...t, access_token: n.access_token, refresh_token: n.refresh_token, expires_at: n.expires_at };
  await put(env, 'tokens', merged);
  return merged.access_token;
}

async function api(env, path) {
  const tok = await accessToken(env);
  const r = await fetch(API + path, { headers: { Authorization: `Bearer ${tok}` } });
  if (r.status === 429) throw new Error('Strava rate limit raggiunto, riprovo più tardi');
  if (!r.ok) throw new Error(`Strava ${r.status} su ${path}`);
  return r.json();
}

export async function listSince(env, afterEpoch, maxPages = 3) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const batch = await api(env, `/athlete/activities?after=${afterEpoch}&per_page=100&page=${page}`);
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}
export const detail = (env, id) => api(env, `/activities/${id}?include_all_efforts=false`);
export const streams = (env, id) => api(env, `/activities/${id}/streams?keys=time,heartrate,velocity_smooth&key_by_type=true`);

// Attività Strava → formato compatto usato da dashboard e coach
export function normalize(d, st = null) {
  const a = {
    id: d.id,
    date: (d.start_date_local || d.start_date).slice(0, 10),
    start: (d.start_date_local || d.start_date).slice(0, 19),
    name: d.name,
    type: d.sport_type || d.type,
    dist_km: Math.round((d.distance || 0) / 10) / 100,
    moving_min: Math.round((d.moving_time || 0) / 6) / 10,
    elapsed_min: Math.round((d.elapsed_time || 0) / 6) / 10,
    elev: Math.round(d.total_elevation_gain || 0),
    avg_hr: d.average_heartrate ? Math.round(d.average_heartrate) : null,
    max_hr: d.max_heartrate ? Math.round(d.max_heartrate) : null,
    speed: d.average_speed || 0,
    cadence: d.average_cadence ? Math.round(d.average_cadence * 2) : null,
    trainer: !!d.trainer,
    desc: d.description || '',
    detailed: d.resource_state === 3,
  };
  a.pace_s = a.speed > 0 ? Math.round(1000 / a.speed) : null;
  const m = a.desc.match(/RPE\s*[:=]?\s*(10|[1-9])\b/i);
  if (d.perceived_exertion) { a.rpe = Math.round(d.perceived_exertion); a.rpe_src = 'strava'; }
  else if (m) { a.rpe = +m[1]; a.rpe_src = 'nota Strava'; }
  if (d.splits_metric?.length) {
    a.splits = d.splits_metric.map((s) => ({
      p: s.average_speed > 0 ? Math.round(1000 / s.average_speed) : null,
      hr: s.average_heartrate ? Math.round(s.average_heartrate) : null,
      el: Math.round(s.elevation_difference || 0),
    }));
  }
  if (st?.heartrate?.data && st?.time?.data) {
    a.hist = histFromStreams(st.time.data, st.heartrate.data);
    a.decoupling = decouplingFromStreams(st.time.data, st.heartrate.data, st.velocity_smooth?.data);
  } else if (a.avg_hr) {
    a.hist = { [hrBucket(a.avg_hr)]: Math.round(a.moving_min * 60) };
    a.approx = true;
  }
  return a;
}

// Webhook: crea la sottoscrizione push (una sola per app)
export async function subscribe(env, callbackUrl) {
  const listR = await fetch(`${API}/push_subscriptions?client_id=${env.STRAVA_CLIENT_ID}&client_secret=${env.STRAVA_CLIENT_SECRET}`);
  const existing = listR.ok ? await listR.json() : [];
  if (existing.length) {
    const same = existing.find((s) => s.callback_url === callbackUrl);
    if (same) return { ok: true, id: same.id, existing: true };
    for (const s of existing) {
      await fetch(`${API}/push_subscriptions/${s.id}?client_id=${env.STRAVA_CLIENT_ID}&client_secret=${env.STRAVA_CLIENT_SECRET}`, { method: 'DELETE' });
    }
  }
  const r = await fetch(`${API}/push_subscriptions`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.STRAVA_CLIENT_ID, client_secret: env.STRAVA_CLIENT_SECRET, callback_url: callbackUrl, verify_token: env.STRAVA_VERIFY_TOKEN }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Sottoscrizione webhook fallita (${r.status}): ${JSON.stringify(j).slice(0, 200)}`);
  return { ok: true, id: j.id };
}
