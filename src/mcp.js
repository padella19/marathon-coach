// ============================================================================
// Connettore MCP (Streamable HTTP, risposte JSON, JSON-RPC 2.0) per Claude.
// Indirizzo: /mcp con header "Authorization: Bearer <MCP_SECRET>". Per un periodo di transizione vale
// ancora /mcp/<MCP_SECRET> (segreto nell'indirizzo): si spegne con la variabile MCP_PATH_AUTH = "off". Nessun tool cancella dati:
// al massimo sostituisce il piano futuro, e si può annullare per 7 giorni.
// ============================================================================
import { get, put } from './store.js';
import * as P from './personal.js';
import * as Z from './jose.js';

const sha256 = async (v) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(v))));
// Token dall'header (preferito) o, in transizione, dal percorso
export async function mcpAuthorized(req, env, path) {
  const h = req.headers.get('authorization') || '';
  if (h.startsWith('Bearer ') && (await secretOk(h.slice(7).trim(), env))) return 'header';
  const inPath = path.length > 5 ? decodeURIComponent(path.slice(5)) : '';
  if (inPath && env.MCP_PATH_AUTH !== 'off' && (await secretOk(inPath, env))) return 'path';
  return null;
}
export async function secretOk(given, env) {
  if (!env.MCP_SECRET || String(env.MCP_SECRET).length < 24) return false;
  const [a, b] = await Promise.all([sha256(given), sha256(env.MCP_SECRET)]);
  let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

const SESSION = {
  type: 'object',
  properties: {
    date: { type: 'string', description: 'YYYY-MM-DD, da domani a +28 giorni' },
    kind: { type: 'string', enum: ['easy', 'quality', 'long', 'runwalk', 'strength', 'rest'] },
    title: { type: 'string' }, min: { type: 'number', description: 'minuti (per la corsa li ricalcolo dai passi)' },
    rpe: { type: 'string', description: 'es. "3-4"' }, zone: { type: 'string', description: 'es. "Z1-Z2"' }, desc: { type: 'string' },
    hotel: { type: 'boolean', description: 'fattibile in trasferta' }, strength: { type: 'string', enum: ['A', 'B', 'C', 'D', 'E'], description: 'routine a corpo libero: A core, B gambe, C piede-caviglia-anca, D mobilità 10\', E mobilità 5\' dopo la corsa' },
    test: { type: 'string', enum: ['5k', '30min'], description: 'solo per la sessione di test (ogni 6-8 settimane)' },
    optional: { type: 'boolean' },
    steps: {
      type: 'array', description: 'Passi del workout per l\'orologio. Ogni passo: {type: warmup|run|recover|walk|cooldown, min, zone: Z1-Z5, note?} oppure {type: "repeat", reps, steps: [...]}',
      items: { type: 'object' },
    },
  },
  required: ['date', 'kind', 'title'],
};
const FEEDBACK_ITEM = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['activity', 'checkin', 'answer', 'note'] },
    activity_id: { type: 'string', description: 'con kind activity' }, question_id: { type: 'string', description: 'con kind answer' },
    headline: { type: 'string', description: 'max 80 caratteri' }, verdict: { type: 'string', enum: ['on_track', 'too_hard', 'too_easy', 'warning', 'info'] },
    summary: { type: 'string', description: 'uscite: 2-3 righe (verdetto + 1 numero chiave + cosa cambia)' },
    dettaglio: { type: 'string', description: 'analisi completa dietro il pulsante "Approfondisci": passo, FC, zone, deriva cardiaca, parziali, confronto col pianificato. Scrivila subito, non serve un altro giro.' },
    test_result: { type: 'object', description: 'solo per correggere il risultato di un test: {type: "5k"|"30min", dist_km, time_s, hr_avg?, hr_max?}', properties: { type: { type: 'string', enum: ['5k', '30min'] }, dist_km: { type: 'number' }, time_s: { type: 'number' }, hr_avg: { type: 'number' }, hr_max: { type: 'number' } } },
    kpis: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'string' }, status: { type: 'string', enum: ['good', 'ok', 'bad'] } } } },
    adjustments: { type: 'array', description: 'proposte che Luca applica con un tocco, solo date dei prossimi 7 giorni', items: { type: 'object', properties: { date: { type: 'string' }, action: { type: 'string', enum: ['keep', 'reduce', 'easy', 'rest', 'move', 'replace'] }, to_date: { type: 'string' }, new_title: { type: 'string' }, new_min: { type: 'number' }, new_rpe: { type: 'string' }, reason: { type: 'string' } } } },
    tips: { type: 'array', items: { type: 'object', properties: { type: { type: 'string', enum: ['nutrition', 'recovery', 'travel', 'technique', 'motivation'] }, text: { type: 'string' } } } },
  },
  required: ['kind', 'headline', 'summary'],
};
const MEMORY = { type: 'object', properties: { add: { type: 'array', items: { type: 'string' } }, update: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } } } }, remove: { type: 'array', items: { type: 'string' } } } };

const TOOLS = [
  { name: 'coach_get_briefing', description: 'Tutto quello che serve a José, il coach di Luca, in un colpo: protocollo (persona e passi da seguire), chat in attesa e recente, segnali, valutazioni, uscite e check-in da commentare, meteo, luoghi, scarpe, badge, test e previsione, profilo, memoria, check-up, metriche e piano dei prossimi 28 giorni. Chiamalo per primo.', inputSchema: { type: 'object', properties: {} }, run: (env) => P.briefing(env) },
  { name: 'coach_post_feedback', description: 'Pubblica nella dashboard i commenti del coach: uscite (kind activity + activity_id), check-in, risposte alle domande (kind answer + question_id), note.', inputSchema: { type: 'object', properties: { items: { type: 'array', items: FEEDBACK_ITEM } }, required: ['items'] }, run: (env, a) => P.postFeedback(env, a) },
  { name: 'coach_ask_questions', description: 'Apre il check-up: 3-6 domande che Luca vede nella dashboard. Solo quando checkup.stage è "ask".', inputSchema: { type: 'object', properties: { intro: { type: 'string' }, questions: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' }, type: { type: 'string', enum: ['scale', 'choice', 'text'] }, options: { type: 'array', items: { type: 'string' } } }, required: ['text', 'type'] } } }, required: ['questions'] }, run: (env, a) => P.askQuestions(env, a) },
  { name: 'coach_apply_plan', description: 'Chiude il check-up applicando il piano ricalibrato (da domani a +28 giorni). Il Worker applica i limiti di sicurezza, salva la versione precedente (annullabile 7 giorni), aggiorna la memoria, invia i workout al Garmin e restituisce le correzioni fatte.', inputSchema: { type: 'object', properties: { summary: { type: 'string', description: 'titolo del check-up, max 120 caratteri' }, why: { type: 'string', description: 'cosa cambia e perché, con i numeri' }, runs_per_week: { type: 'integer', minimum: 3, maximum: 5 }, sessions: { type: 'array', items: SESSION }, memory: MEMORY }, required: ['summary', 'why', 'sessions'] }, run: (env, a) => P.applyPlan(env, a) },
  { name: 'coach_send_message', description: 'Scrive a Luca nella chat della dashboard. Risposta a un suo messaggio: reply_to = id da chat_in_attesa, kind "reply". Messaggio spontaneo (da un segnale): senza reply_to, kind "spontaneous", "scolding" o "praise", signal_id = id del segnale. Al massimo 1 spontaneo per giro (lo impone il Worker).', inputSchema: { type: 'object', properties: { text: { type: 'string' }, reply_to: { type: 'string' }, kind: { type: 'string', enum: ['reply', 'spontaneous', 'scolding', 'praise'] }, signal_id: { type: 'string' } }, required: ['text', 'kind'] }, run: (env, a) => Z.sendMessage(env, a) },
  { name: 'coach_update_profile', description: `Aggiorna il profilo di Luca con quello che impari in chat. set = {campo: testo}. Campi: ${P.PROFILE_FIELDS.join(', ')}.`, inputSchema: { type: 'object', properties: { set: { type: 'object', additionalProperties: { type: 'string' } }, remove: { type: 'array', items: { type: 'string' } } }, required: ['set'] }, run: (env, a) => P.updateProfile(env, a) },
  { name: 'coach_post_weekly_report', description: 'Report settimanale del lunedì mattina (solo se report_settimanale.da_scrivere è true). I numeri fatto/pianificato li calcola il Worker.', inputSchema: { type: 'object', properties: { week: { type: 'string', description: 'lunedì della settimana chiusa, YYYY-MM-DD (default: la scorsa)' }, voto: { type: 'integer', minimum: 1, maximum: 10 }, titolo: { type: 'string' }, commento: { type: 'string', description: '3-5 frasi, tono José' }, bene: { type: 'array', items: { type: 'string' } }, male: { type: 'array', items: { type: 'string' } }, focus: { type: 'string', description: 'focus della settimana nuova, una riga' }, focus_perche: { type: 'string' } }, required: ['voto', 'commento', 'focus'] }, run: (env, a) => Z.postWeeklyReport(env, a) },
  { name: 'coach_set_place_amenities', description: 'Salva le dotazioni di un hotel/città: valgono per tutte le trasferte successive nella stessa città. Metti solo i campi che Luca ti ha detto.', inputSchema: { type: 'object', properties: { city: { type: 'string' }, hotel: { type: 'string' }, treadmill: { type: 'boolean' }, gym: { type: 'boolean' }, outdoor: { type: 'boolean', description: 'parco o lungofiume vicino' }, early_breakfast: { type: 'boolean' }, note: { type: 'string' } }, required: ['city'] }, run: (env, a) => Z.setPlace(env, a) },
  { name: 'coach_update_memory', description: 'Aggiunge, corregge o toglie note durature su Luca (massimo 30).', inputSchema: MEMORY, run: async (env, a) => ({ facts: await P.updateMemory(env, a) }) },
];

const rpc = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcErr = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

// Limite semplice: 60 chiamate l'ora
async function rateOk(env) {
  const k = `mcp_rate:${new Date().toISOString().slice(0, 13)}`;
  const n = (await get(env, k, 0)) + 1;
  await env.KV.put(k, JSON.stringify(n), { expirationTtl: 7200 });
  return n <= 60;
}

async function handleOne(msg, env) {
  const { id, method, params } = msg || {};
  if (!method) return rpcErr(id ?? null, -32600, 'Richiesta non valida');
  if (method.startsWith('notifications/')) return null;
  if (method === 'initialize') return rpc(id, { protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'marathon-coach', version: '2.0.0' }, instructions: 'Sei José, il coach di corsa di Luca: chiama coach_get_briefing e segui il campo "protocollo".' });
  if (method === 'ping') return rpc(id, {});
  if (method === 'tools/list') return rpc(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
  if (method === 'tools/call') {
    const t = TOOLS.find((x) => x.name === params?.name);
    if (!t) return rpcErr(id, -32602, `Tool sconosciuto: ${params?.name}`);
    if (!(await rateOk(env))) return rpc(id, { content: [{ type: 'text', text: 'Troppe chiamate in quest\'ora: riprova più tardi.' }], isError: true });
    try {
      await Z.touch(env, t.name).catch(() => {}); // stato di José in dashboard: "ultima visita…"
      const out = await t.run(env, params.arguments || {});
      return rpc(id, { content: [{ type: 'text', text: JSON.stringify(out) }], isError: !!out?.error });
    } catch (e) {
      console.error('mcp', t.name, e);
      return rpc(id, { content: [{ type: 'text', text: `Errore: ${e.message}` }], isError: true });
    }
  }
  return rpcErr(id, -32601, `Metodo non supportato: ${method}`);
}

export async function handleMcp(req, env) {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: { allow: 'POST' } });
  let body;
  try { body = await req.json(); } catch { return Response.json(rpcErr(null, -32700, 'JSON non valido'), { status: 400 }); }
  const batch = Array.isArray(body);
  const res = (await Promise.all((batch ? body : [body]).map((m) => handleOne(m, env)))).filter(Boolean);
  if (!res.length) return new Response(null, { status: 202 });
  return Response.json(batch ? res : res[0], { headers: { 'cache-control': 'no-store' } });
}
