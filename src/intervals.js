// Connettore intervals.icu (gratuito, sincronizzato direttamente con Garmin Connect)
// Auth: Basic con utente "API_KEY" e password = chiave personale (Settings → Developer Settings)
import { histFromStreams, decouplingFromStreams, hrBucket } from '../public/lib/engine.js';

const BASE = 'https://intervals.icu/api/v1';
const athlete = (env) => env.INTERVALS_ATHLETE_ID || '0'; // 0 = atleta della chiave

async function api(env, path) {
  const r = await fetch(BASE + path, {
    headers: { Authorization: 'Basic ' + btoa('API_KEY:' + env.INTERVALS_API_KEY), accept: 'application/json' },
  });
  if (r.status === 401 || r.status === 403) throw new Error('intervals.icu: chiave API non valida');
  if (r.status === 429) throw new Error('intervals.icu: troppe richieste, riprovo più tardi');
  if (!r.ok) throw new Error(`intervals.icu ${r.status} su ${path.split('?')[0]}`);
  return r.json();
}

export const configured = (env) => !!env.INTERVALS_API_KEY;

export async function listRange(env, oldest, newest) {
  const list = await api(env, `/athlete/${athlete(env)}/activities?oldest=${oldest}&newest=${newest}`);
  // Le attività arrivate da Strava non sono esposte dall'API: hanno solo un id e una nota
  return (Array.isArray(list) ? list : []).filter((a) => a && a.start_date_local && !a._note);
}

export async function streams(env, id) {
  const raw = await api(env, `/activity/${id}/streams?types=time,heartrate,velocity_smooth`);
  const out = {};
  if (Array.isArray(raw)) for (const s of raw) out[s.type] = { data: s.data };
  else Object.assign(out, raw);
  return out;
}

export function normalize(d, st = null) {
  const start = String(d.start_date_local).slice(0, 19);
  const cad = d.average_cadence ? (d.average_cadence < 120 ? d.average_cadence * 2 : d.average_cadence) : null;
  const a = {
    id: String(d.id),
    date: start.slice(0, 10),
    start,
    name: d.name || d.type,
    type: d.type,
    dist_km: Math.round((d.distance || 0) / 10) / 100,
    moving_min: Math.round((d.moving_time || d.elapsed_time || 0) / 6) / 10,
    elapsed_min: Math.round((d.elapsed_time || 0) / 6) / 10,
    elev: Math.round(d.total_elevation_gain || 0),
    avg_hr: d.average_heartrate ? Math.round(d.average_heartrate) : null,
    max_hr: d.max_heartrate ? Math.round(d.max_heartrate) : null,
    speed: d.average_speed || (d.distance && d.moving_time ? d.distance / d.moving_time : 0),
    cadence: cad ? Math.round(cad) : null,
    trainer: !!d.trainer,
    desc: d.description || '',
    src: 'intervals',
    sig: `${d.moving_time}|${d.icu_rpe ?? d.perceived_exertion ?? ''}|${(d.description || '').length}|${d.name}`,
  };
  a.pace_s = a.speed > 0 ? Math.round(1000 / a.speed) : null;
  const rpe = d.icu_rpe ?? d.perceived_exertion;
  const m = a.desc.match(/RPE\s*[:=]?\s*(10|[1-9])\b/i);
  if (rpe) { a.rpe = Math.round(rpe); a.rpe_src = 'Garmin/intervals'; }
  else if (m) { a.rpe = +m[1]; a.rpe_src = 'nota'; }
  if (st?.heartrate?.data && st?.time?.data) {
    a.hist = histFromStreams(st.time.data, st.heartrate.data);
    a.decoupling = decouplingFromStreams(st.time.data, st.heartrate.data, st.velocity_smooth?.data);
  } else if (a.avg_hr) {
    a.hist = { [hrBucket(a.avg_hr)]: Math.round(a.moving_min * 60) };
    a.approx = true;
  }
  return a;
}
