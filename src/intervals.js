// Connettore Intervals.icu (API v1) — attività e stream FC/passo.
// Garmin → Intervals.icu → questo Worker. Accesso con la API key personale
// (Intervals.icu → Settings → Developer Settings): Basic auth, utente "API_KEY".
// Con la API key non esistono webhook: le nuove uscite si leggono a intervalli (cron).
import { histFromStreams, decouplingFromStreams, hrBucket } from '../public/lib/engine.js';

const base = (env) => (env.INTERVALS_BASE || 'https://intervals.icu').replace(/\/+$/, '');
// "0" = l'atleta a cui appartiene la API key
const athleteId = (env) => String(env.INTERVALS_ATHLETE_ID || '0').trim();
export const configured = (env) => !!env.INTERVALS_API_KEY;

async function api(env, path, method = 'GET', body = null) {
  if (!configured(env)) throw new Error('Intervals.icu non collegato: manca il secret INTERVALS_API_KEY');
  const r = await fetch(`${base(env)}/api/v1${path}`, {
    method,
    headers: { authorization: `Basic ${btoa(`API_KEY:${env.INTERVALS_API_KEY}`)}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (r.status === 401 || r.status === 403) throw new Error(`Intervals.icu ha rifiutato l'accesso (${r.status}): controlla API key e ID atleta`);
  if (r.status === 429) throw new Error('Intervals.icu: troppe richieste, riprovo più tardi');
  if (!r.ok) throw new Error(`Intervals.icu ${r.status} su ${path.split('?')[0]}`);
  return r.json();
}

// Profilo dell'atleta: serve a verificare il collegamento e a mostrare il nome
export async function athlete(env) {
  const a = await api(env, `/athlete/${athleteId(env)}`);
  return { id: a.id, name: a.name || [a.firstname, a.lastname].filter(Boolean).join(' ') || null };
}

// Zone FC della corsa dalle impostazioni sport dell'atleta (verifica: athlete.sportSettings[].types / hr_zones / max_hr / lthr).
// hr_zones = limiti superiori di ogni zona; se le zone sono più di 5 (es. 7), dalla quinta in su diventano Z5.
export function zonesFromAthlete(a) {
  const ss = (a?.sportSettings || []).find((x) => (x.types || []).some((t) => /Run/.test(t)));
  const b = (ss?.hr_zones || []).map(Number).filter((v) => v > 0).sort((x, y) => x - y);
  if (b.length < 5) return null;
  const max = Number(ss.max_hr) || b[b.length - 1];
  const his = [b[0], b[1], b[2], b[3], Math.max(max, b[4])];
  const zones = his.map((hi, i) => ({ z: i + 1, lo: i === 0 ? Math.round(hi * 0.85) : his[i - 1], hi: Math.round(hi) }));
  return { zones, max, lthr: Number(ss.lthr) || null, src: 'intervals.icu', ts: Date.now() };
}
export async function hrZones(env) {
  return zonesFromAthlete(await api(env, `/athlete/${athleteId(env)}`));
}

// Attività tra due date locali (YYYY-MM-DD, estremi inclusi), dalla più vecchia alla più recente
export async function listRange(env, oldest, newest) {
  const list = await api(env, `/athlete/${athleteId(env)}/activities?oldest=${oldest}&newest=${newest}`);
  return (Array.isArray(list) ? list : []).sort((a, b) => String(a.start_date_local || '').localeCompare(String(b.start_date_local || '')));
}

// Le attività che Intervals.icu riceve da Strava non sono leggibili via API (arrivano vuote):
// servono quelle sincronizzate direttamente da Garmin o caricate a mano.
export const isStravaStub = (s) => s?.source === 'STRAVA';
export const usable = (s) => !!s && !isStravaStub(s) && !!s.id && !!s.start_date_local && !!s.type && (s.moving_time || 0) > 0;

// Impronta dei campi che contano: se non cambia, l'attività non viene riscaricata né riscritta
export const fingerprint = (s) => [s.name, s.type, s.start_date_local, s.distance, s.moving_time, s.average_heartrate, s.max_heartrate, s.icu_rpe, s.perceived_exertion, s.description, s.trainer, (s.icu_hr_zone_times || []).join(',')].map((v) => v ?? '').join('|');

// Stream → { time: [...], heartrate: [...], velocity_smooth: [...], distance: [...], altitude: [...] }
export async function streams(env, id) {
  const arr = await api(env, `/activity/${encodeURIComponent(id)}/streams.json?types=time,heartrate,velocity_smooth,distance,altitude`);
  const out = {};
  for (const s of Array.isArray(arr) ? arr : []) if (s?.type && Array.isArray(s.data)) out[s.type] = s.data;
  return out;
}

// Parziali al km ricavati dagli stream (passo, FC media, dislivello)
export function splitsFromStreams(st) {
  const { time, distance, heartrate: hr, altitude: alt } = st || {};
  if (!time || !distance || time.length < 30 || time.length !== distance.length) return null;
  const out = []; let i0 = 0, hrSum = 0, hrN = 0;
  for (let i = 1; i < time.length; i++) {
    if (hr?.[i]) { hrSum += hr[i]; hrN++; }
    if (distance[i] - distance[i0] >= 1000 || i === time.length - 1) {
      const d = distance[i] - distance[i0], t = time[i] - time[i0];
      if (d >= 400 && t > 0) out.push({ p: Math.round((t / d) * 1000), hr: hrN ? Math.round(hrSum / hrN) : null, el: alt?.[i] != null && alt?.[i0] != null ? Math.round(alt[i] - alt[i0]) : 0 });
      i0 = i; hrSum = 0; hrN = 0;
    }
  }
  return out.length ? out.slice(0, 60) : null;
}

// Attività Intervals.icu → formato compatto usato da dashboard e coach
export function normalize(d, st = null) {
  const start = String(d.start_date_local).slice(0, 19);
  const dist = d.distance ?? d.icu_distance ?? 0;
  const moving = d.moving_time || 0;
  const speed = d.average_speed || (moving > 0 ? dist / moving : 0);
  const cad = d.average_cadence ? Math.round(d.average_cadence) : null;
  const a = {
    id: String(d.id), src: 'intervals', fp: fingerprint(d),
    date: start.slice(0, 10), start,
    name: d.name || 'Attività',
    type: d.type,
    dist_km: Math.round(dist / 10) / 100,
    moving_min: Math.round(moving / 6) / 10,
    elapsed_min: Math.round((d.elapsed_time || moving) / 6) / 10,
    elev: Math.round(d.total_elevation_gain || 0),
    avg_hr: d.average_heartrate ? Math.round(d.average_heartrate) : null,
    max_hr: d.max_heartrate ? Math.round(d.max_heartrate) : null,
    speed,
    cadence: cad == null ? null : cad < 120 ? cad * 2 : cad, // passi/min: se arriva per singola gamba si raddoppia
    trainer: !!d.trainer,
    desc: d.description || '',
    detailed: !!st,
  };
  a.pace_s = a.speed > 0 ? Math.round(1000 / a.speed) : null;
  // Secondi per zona calcolati da intervals.icu (verifica: icu_hr_zone_times), ridotti a 5 zone
  const zt = Array.isArray(d.icu_hr_zone_times) ? d.icu_hr_zone_times.map((v) => Math.max(0, Number(v) || 0)) : null;
  if (zt && zt.length >= 5 && zt.some((v) => v > 0)) a.zone_secs = [zt[0], zt[1], zt[2], zt[3], zt.slice(4).reduce((x, y) => x + y, 0)];
  const m = a.desc.match(/RPE\s*[:=]?\s*(10|[1-9])\b/i);
  const rpe = d.icu_rpe || d.perceived_exertion;
  if (rpe) { a.rpe = Math.max(1, Math.min(10, Math.round(rpe))); a.rpe_src = 'intervals'; }
  else if (m) { a.rpe = +m[1]; a.rpe_src = 'nota'; }
  if (st?.heartrate && st?.time) {
    a.hist = histFromStreams(st.time, st.heartrate);
    a.decoupling = decouplingFromStreams(st.time, st.heartrate, st.velocity_smooth);
    const sp = splitsFromStreams(st); if (sp) a.splits = sp;
  } else if (a.avg_hr) {
    a.hist = { [hrBucket(a.avg_hr)]: Math.round(a.moving_min * 60) };
    a.approx = true;
  }
  if (a.decoupling == null && typeof d.decoupling === 'number' && a.moving_min >= 40) a.decoupling = Math.round(d.decoupling * 10) / 10;
  return a;
}

// Corsa fatta senza orologio → attività manuale su intervals.icu (verifica: POST /athlete/{id}/activities/manual).
// La RPE va anche nella descrizione ("RPE 6"), che normalize() sa leggere.
export async function createManual(env, { date, min, km, rpe, note }) {
  const desc = [note, rpe ? `RPE ${rpe}` : ''].filter(Boolean).join(' · ');
  const body = { start_date_local: `${date}T12:00:00`, type: 'Run', name: 'Corsa (inserita a mano)', moving_time: Math.round(min * 60), elapsed_time: Math.round(min * 60), distance: Math.round((km || 0) * 1000), description: desc, external_id: `mc-manual-${date}-${Date.now()}` };
  if (rpe) body.icu_rpe = rpe;
  return api(env, `/athlete/${athleteId(env)}/activities/manual`, 'POST', body);
}

// ---------- Calendario (workout pianificati → Garmin) ----------
// Verifica gli endpoint: GET /athlete/{id}/events?oldest&newest, POST /athlete/{id}/events/bulk?upsert=true, DELETE /athlete/{id}/events/{eventId}
export const listEvents = (env, oldest, newest) => api(env, `/athlete/${athleteId(env)}/events?oldest=${oldest}&newest=${newest}`);
export const upsertEvents = (env, events) => api(env, `/athlete/${athleteId(env)}/events/bulk?upsert=true`, 'POST', events);
export async function deleteEvent(env, id) {
  const r = await fetch(`${base(env)}/api/v1/athlete/${athleteId(env)}/events/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { authorization: `Basic ${btoa(`API_KEY:${env.INTERVALS_API_KEY}`)}` } });
  if (!r.ok && r.status !== 404) throw new Error(`Intervals.icu ${r.status} cancellando un evento`);
}
