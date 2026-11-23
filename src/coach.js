// Coach Live Feedback — motore a regole + Claude (Anthropic Messages API)
import { get, put, getSettings, pushFeed, getCheckin, patchFeed } from './store.js';
import { important } from './notify.js';
import {
  computeMetrics, phaseAt, planIndex, effective, tripDaySet, readiness, adaptSession, ruleFeedback,
  todayISO, addDays, mondayOf, fmtPace, fmtMin, zoneOf, zoneSeconds, rpeOf, loadOf, isRun, acwrBand, DOW_IT,
  logActivities, withPauses, activePause, tripOn, vacationDaySet, FACILITIES,
} from '../public/lib/engine.js';

const itDate = (iso) => iso ? iso.split('-').reverse().join('/') : '?';
// Le date vengono dalle impostazioni (modificabili dalla dashboard), non sono scritte qui
const systemFor = (s) => `Sei il personal running coach e data analyst di Luca: Area Manager con trasferte frequenti (di solito mar-mer-gio, calendario flessibile).
Obiettivo: TERMINARE la ${s.raceName || 'maratona'} del ${itDate(s.raceDate)} in sicurezza, senza infortuni e senza noia. Preparazione ${s.planStart <= todayISO() ? 'iniziata' : 'in partenza'} il ${itDate(s.planStart)} da zero (corsa/cammino).
Vincoli: niente bici, niente palestra. In trasferta solo strada/parco vicino all'hotel o tapis roulant + forza/core a corpo libero in camera. Lunghi e lavori chiave nel weekend (ven-sab-dom).
Stile: italiano, diretto, informale, pragmatico. Parla di numeri (FC, passo min/km, RPE 1-10, ACWR, km). Niente complimenti di circostanza, niente premesse ovvie.
Varietà: proponi fartlek a sensazione, progressivi, variazioni di ritmo, rigeneranti. Mai tabelle rigide ripetute.
Sicurezza: dolore che altera l'appoggio, peggiora correndo o dura oltre 48-72h → stop corsa e consulto medico/fisioterapista. ACWR > 1,5 → riduci. Aumenti di volume settimanale oltre il 10-15% vanno motivati. Non inventare dati assenti dal contesto. Non sei un medico.
Rispondi SOLO con un oggetto JSON valido, senza testo prima o dopo, senza markdown.`;

const FEEDBACK_SCHEMA = `{
 "headline": "max 80 caratteri, il punto chiave",
 "verdict": "on_track | too_hard | too_easy | warning | info",
 "summary": "2-4 frasi con numeri concreti",
 "kpis": [{"label": "breve", "value": "con unità", "status": "good | ok | bad"}],
 "adjustments": [{"date": "YYYY-MM-DD (solo date presenti in next7)", "action": "keep | reduce | easy | rest | move | replace", "to_date": "solo con action move: YYYY-MM-DD del giorno (tra quelli di next7, diverso da date) in cui spostare la sessione; altrimenti stringa vuota", "new_title": "", "new_min": 0, "new_rpe": "es. 3-4", "reason": "breve"}],
 "tips": [{"type": "nutrition | recovery | travel | technique | motivation", "text": "1 frase operativa"}]
}`;
const WEEKLY_SCHEMA = `{
 "title": "focus della settimana, max 70 caratteri",
 "why": "2-3 frasi: perché questo focus, con i numeri della settimana scorsa",
 "keys": ["3-4 azioni chiave concrete, una per riga"],
 "targets": [{"label": "Volume | Z1-Z2 | Sessioni | Lungo | ...", "value": "target"}],
 "travel": "come gestire le trasferte previste (1-2 frasi)",
 "nutrition": "1-2 frasi su idratazione/integrazione della settimana",
 "watch": "cosa monitorare (fastidi, segnali)",
 "adjustments": [{"date": "YYYY-MM-DD (un giorno della settimana in oggetto)", "action": "keep | reduce | easy | rest | move | replace", "to_date": "solo con action move: YYYY-MM-DD di un altro giorno della stessa settimana; altrimenti stringa vuota", "new_title": "", "new_min": 0, "new_rpe": "", "reason": ""}]
}`;

async function claude(env, user, maxTokens = 1400) {
  const system = systemFor(await getSettings(env));
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: env.CLAUDE_MODEL || 'claude-sonnet-5-5', max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
  });
  if (!r.ok) throw new Error(`Claude API ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  const text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const m = text.match(/\{[\s\S]*\}/);
  return JSON.parse(m ? m[0] : text);
}

// Pulizia output AI: niente HTML, tipi certi
const clean = (v, n = 600) => String(v ?? '').replace(/<[^>]*>/g, '').slice(0, n);
const ACTIONS = ['keep', 'reduce', 'easy', 'rest', 'move', 'replace'];
export function sanitizeFeedback(o, allowedDates) {
  return {
    headline: clean(o.headline, 120),
    verdict: ['on_track', 'too_hard', 'too_easy', 'warning', 'info'].includes(o.verdict) ? o.verdict : 'info',
    summary: clean(o.summary, 900),
    kpis: (o.kpis || []).slice(0, 8).map((k) => ({ label: clean(k.label, 30), value: clean(k.value, 40), status: ['good', 'ok', 'bad'].includes(k.status) ? k.status : 'ok' })),
    adjustments: (o.adjustments || []).filter((a) => allowedDates.has(a.date)).slice(0, 5).map((a) => ({
      date: a.date, action: ACTIONS.includes(a.action) ? a.action : 'replace',
      // "move" vale solo con una destinazione valida: una delle date ammesse, diversa dall'origine
      to_date: a.action === 'move' && allowedDates.has(a.to_date) && a.to_date !== a.date ? a.to_date : '',
      new_title: clean(a.new_title, 80), new_min: Math.max(0, Math.min(240, +a.new_min || 0)), new_rpe: clean(a.new_rpe, 10), reason: clean(a.reason, 200),
    })),
    tips: (o.tips || []).slice(0, 4).map((t) => ({ type: clean(t.type, 20), text: clean(t.text, 300) })),
  };
}

// Contesto compatto per Claude
async function buildContext(env, today = todayISO()) {
  const [settings, plan, overrides0, acts0, trips, ci, logs, pauses] = await Promise.all([
    getSettings(env), get(env, 'plan', []), get(env, 'overrides', {}), get(env, 'activities', []), get(env, 'trips', { manual: [], ical: [] }), getCheckin(env, today),
    get(env, 'logs', []), get(env, 'pauses', []),
  ]);
  // Forza/mobilità segnate a mano contano nel carico; i giorni in pausa diventano "Pausa"
  const acts = [...acts0, ...logActivities(logs, acts0)];
  const overrides = withPauses(overrides0, pauses, today);
  const pause = activePause(pauses, today);
  const m = computeMetrics(acts, settings, today);
  const pIdx = planIndex(plan), tripSet = tripDaySet(trips), vacSet = vacationDaySet(trips), ph = phaseAt(today, settings);
  const ready = readiness(ci, m);
  const next7 = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(today, i), s = effective(d, pIdx, overrides);
    const tr = tripOn(trips, d);
    next7.push({ date: d, giorno: DOW_IT[new Date(d + 'T00:00:00Z').getUTCDay()], trasferta: tripSet.get(d) ? `${tripSet.get(d)} (in hotel: ${tr?.facilities?.length ? tr.facilities.map((f) => FACILITIES[f]).join(', ') : 'non ancora detto, considera solo camera'})` : vacSet.get(d) ? `VACANZA ${vacSet.get(d)} (niente versione hotel, più tempo libero)` : null, sessione: s ? `${s.title} · ${s.min}' · RPE ${s.rpe} · ${s.kind}${s.optional ? ' (facoltativa)' : ''}` : 'nessuna' });
  }
  const recent = m.acts.slice(-10).map((a) => {
    const r = rpeOf(a, m.hrp);
    return `${a.date} ${a.type} "${a.name}" ${a.dist_km}km ${fmtMin(a.moving_min)} ${fmtPace(a.pace_s)} FC ${a.avg_hr || '-'} (Z${zoneOf(a.avg_hr, m.hrp) || '-'}) RPE ${r.v}${r.est ? '~' : ''} carico ${loadOf(a, m.hrp)}${a.decoupling != null ? ` deriva ${a.decoupling}%` : ''}`;
  });
  const lastWeeks = m.weeks.slice(-6).map((w) => `${w.week}: ${w.km.toFixed(1)} km, ${w.runs} corse, lungo ${fmtMin(w.longMin)}, carico ${w.load}`);
  const snapshot = {
    oggi: today, fase: `${ph.name} (settimana ${ph.week}/${ph.total})${ph.rec ? ' — settimana di scarico' : ''}`, focus_fase: ph.focus,
    zone_fc: m.hrp.zones.map((z) => `Z${z.z} ${z.lo}-${z.hi}`).join(', ') + ` (FCmax ${m.hrp.max} ${m.hrp.src}, riposo ${m.hrp.rest})`,
    acwr: m.acwr ? `${m.acwr.toFixed(2)} (${acwrBand(m.acwr, m.calibrating).label})` : 'in calibrazione',
    forma_pct: m.form != null ? Math.round(m.form) : null, monotonia: m.monotony,
    km_settimana: +m.week.km.toFixed(1), km_settimana_prec: m.prevWeek ? +m.prevWeek.km.toFixed(1) : null,
    z1z2_28g_pct: m.polar != null ? Math.round(m.polar) : null, efficienza_trend_pct: m.efTrend != null ? +m.efTrend.toFixed(1) : null,
    readiness: ready, checkin_oggi: ci, impostazioni: { peso: settings.weightKg, eta: settings.age, lungo: settings.longRunDay === 6 ? 'sabato' : 'domenica' },
  };
  snapshot.pausa = pause ? { dal: pause.from, rientro_previsto: pause.to, motivo: pause.reason } : null;
  return { settings, plan, overrides, acts, trips, m, pIdx, tripSet, ph, ci, ready, next7, recent, lastWeeks, snapshot, pause };
}


// 1) Analisi di un'uscita appena caricata
export async function analyzeActivity(env, a) {
  const ctx = await buildContext(env, a.date > todayISO() ? a.date : todayISO());
  const planned = effective(a.date, ctx.pIdx, ctx.overrides);
  const base = ruleFeedback(a, planned, ctx.m);
  let fb = base, source = 'rules', error = null;
  if (env.ANTHROPIC_API_KEY) {
    try {
      const z = zoneSeconds(a, ctx.m.hrp), tot = z.reduce((x, y) => x + y, 0) || 1;
      const prompt = `Analizza l'uscita appena caricata e decidi se ricalibrare i prossimi giorni.
USCITA: ${JSON.stringify({ data: a.date, tipo: a.type, nome: a.name, km: a.dist_km, minuti: a.moving_min, passo: fmtPace(a.pace_s), fc_media: a.avg_hr, fc_max: a.max_hr, cadenza: a.cadence, dislivello: a.elev, tapis_roulant: a.trainer, rpe: rpeOf(a, ctx.m.hrp), zone_pct: z.map((v) => Math.round((v / tot) * 100)), deriva_fc_pct: a.decoupling, split_km: (a.splits || []).slice(0, 45).map((s) => `${fmtPace(s.p)}@${s.hr || '-'}`), nota_atleta: a.desc })}
PIANIFICATO QUEL GIORNO: ${planned ? `${planned.title} · ${planned.min}' · RPE ${planned.rpe} · ${planned.zone} — ${planned.desc}` : 'niente (uscita extra)'}
ANALISI A REGOLE: ${JSON.stringify({ verdict: base.verdict, summary: base.summary })}
STATO: ${JSON.stringify(ctx.snapshot)}
ULTIME USCITE:\n${ctx.recent.join('\n')}
SETTIMANE:\n${ctx.lastWeeks.join('\n')}
next7 (piano effettivo):\n${ctx.next7.map((d) => `${d.date} ${d.giorno}${d.trasferta ? ' [TRASFERTA ' + d.trasferta + ']' : ''}: ${d.sessione}`).join('\n')}
Proponi adjustments solo se servono davvero (fatica, FC troppo alta, fastidi nella nota, trasferte). Schema:\n${FEEDBACK_SCHEMA}`;
      fb = sanitizeFeedback(await claude(env, prompt), new Set(ctx.next7.map((d) => d.date)));
      source = 'ai';
    } catch (e) { error = e.message; }
  }
  const item = await pushFeed(env, { kind: 'activity', ref: a.id, refDate: a.date, source, error, ...fb });
  const list = await get(env, 'activities', []);
  const i = list.findIndex((x) => String(x.id) === String(a.id));
  if (i >= 0) { list[i].analyzed = item.id; await put(env, 'activities', list); }
  // i commenti delle uscite vanno nel riepilogo serale; subito solo gli avvisi
  if (fb.verdict === 'warning') { await patchFeed(env, item.id, { important: true }); await important(env, fb.headline, fb.summary, 'coach'); }
  return item;
}

// 2) Check-in giornaliero (sonno, energia, fastidi, viaggio) → ricalibrazione
export async function dailyCheck(env, date = todayISO()) {
  const ctx = await buildContext(env, date);
  if (ctx.pause) return null; // in pausa il coach non commenta e non adatta
  const planned = effective(date, ctx.pIdx, ctx.overrides);
  const adapted = adaptSession(planned, { ci: ctx.ci, m: ctx.m, trip: ctx.tripSet.has(date), ready: ctx.ready, tripSet: ctx.tripSet, date, facilities: tripOn(ctx.trips, date)?.facilities });
  let fb = {
    headline: !planned ? `Readiness ${ctx.ready.score}/100` : adapted.changes.length ? `Oggi: ${adapted.session?.title || 'riposo'}` : `Readiness ${ctx.ready.score}: piano confermato`,
    verdict: adapted.level === 'red' ? 'warning' : adapted.level === 'amber' ? 'info' : 'on_track',
    summary: adapted.changes.join(' ') || 'Nessun motivo per cambiare la sessione di oggi.',
    kpis: [{ label: 'Readiness', value: `${ctx.ready.score}/100`, status: ctx.ready.tone === 'good' ? 'good' : ctx.ready.tone === 'warn' ? 'ok' : 'bad' }],
    adjustments: [], tips: [],
  };
  let source = 'rules', error = null;
  if (env.ANTHROPIC_API_KEY) {
    try {
      const prompt = `Check-in di oggi dell'atleta. Il motore a regole ha già adattato la sessione: conferma o affina, e ricalibra i giorni successivi se fatica da viaggio o fastidi lo richiedono, senza compromettere il piano lungo.
CHECK-IN: ${JSON.stringify(ctx.ci)}
SESSIONE PIANIFICATA: ${planned ? `${planned.title} ${planned.min}' RPE ${planned.rpe}` : 'nessuna'}
SESSIONE ADATTATA DALLE REGOLE: ${adapted.session ? `${adapted.session.title} ${adapted.session.min}'` : 'nessuna'} — modifiche: ${adapted.changes.join(' | ') || 'nessuna'}
STATO: ${JSON.stringify(ctx.snapshot)}
ULTIME USCITE:\n${ctx.recent.slice(-5).join('\n')}
next7:\n${ctx.next7.map((d) => `${d.date} ${d.giorno}${d.trasferta ? ' [TRASFERTA ' + d.trasferta + ']' : ''}: ${d.sessione}`).join('\n')}
Schema:\n${FEEDBACK_SCHEMA}`;
      fb = sanitizeFeedback(await claude(env, prompt, 1100), new Set(ctx.next7.map((d) => d.date)));
      source = 'ai';
    } catch (e) { error = e.message; }
  }
  const e = await pushFeed(env, { kind: 'checkin', refDate: date, source, error, ...fb });
  if (fb.verdict === 'warning') { await patchFeed(env, e.id, { important: true }); await important(env, fb.headline, fb.summary, 'oggi'); }
  return e;
}

// 3) Focus settimanale (cron domenica sera o su richiesta)
export async function weekly(env, weekMonday) {
  const today = todayISO();
  const mon = weekMonday || (new Date(today + 'T00:00:00Z').getUTCDay() === 0 ? addDays(today, 1) : mondayOf(today));
  const ctx = await buildContext(env, today);
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(mon, i), s = effective(d, ctx.pIdx, ctx.overrides);
    days.push(`${d} ${DOW_IT[new Date(d + 'T00:00:00Z').getUTCDay()]}${ctx.tripSet.has(d) ? ' [TRASFERTA ' + ctx.tripSet.get(d) + ']' : ''}: ${s ? `${s.title} ${s.min}' RPE ${s.rpe}${s.strength ? ' + forza ' + s.strength : ''}` : 'nessuna'}`);
  }
  const phNext = phaseAt(mon, ctx.settings);
  let w = null, source = 'rules', error = null;
  if (env.ANTHROPIC_API_KEY) {
    try {
      const prompt = `Prepara il FOCUS DELLA SETTIMANA che inizia ${mon} (${phNext.name}, settimana ${phNext.week}/${phNext.total}${phNext.rec ? ', settimana di scarico' : ''}).
STATO: ${JSON.stringify(ctx.snapshot)}
SETTIMANE:\n${ctx.lastWeeks.join('\n')}
ULTIME USCITE:\n${ctx.recent.join('\n')}
PIANO DELLA SETTIMANA:\n${days.join('\n')}
Varia gli stimoli, gestisci le trasferte con versioni hotel, avvicinandoti alla gara aggiungi indicazioni di tapering e integrazione. Schema:\n${WEEKLY_SCHEMA}`;
      const o = await claude(env, prompt, 1400);
      const allowed = new Set(days.map((x) => x.slice(0, 10)));
      w = {
        title: clean(o.title, 100), why: clean(o.why, 600), keys: (o.keys || []).slice(0, 5).map((k) => clean(k, 200)),
        targets: (o.targets || []).slice(0, 5).map((t) => ({ label: clean(t.label, 24), value: clean(t.value, 30) })),
        travel: clean(o.travel, 300), nutrition: clean(o.nutrition, 300), watch: clean(o.watch, 200),
        adjustments: sanitizeFeedback({ adjustments: o.adjustments }, allowed).adjustments,
      };
      source = 'ai';
    } catch (e) { error = e.message; }
  }
  if (!w) w = { title: `${phNext.name}: settimana ${phNext.week}`, why: phNext.focus, keys: days.filter((d) => !/Riposo|nessuna/.test(d)).slice(0, 4), targets: [], travel: '', nutrition: '', watch: '', adjustments: [] };
  const all = await get(env, 'weekly', {});
  all[mon] = { week: mon, source, error, ts: Date.now(), ...w };
  const keys = Object.keys(all).sort().slice(-12);
  await put(env, 'weekly', Object.fromEntries(keys.map((k) => [k, all[k]])));
  await pushFeed(env, { kind: 'weekly', refDate: mon, source, error, headline: w.title, verdict: 'info', summary: w.why, kpis: w.targets.map((t) => ({ ...t, status: 'ok' })), adjustments: w.adjustments, tips: [w.travel && { type: 'travel', text: w.travel }, w.nutrition && { type: 'nutrition', text: w.nutrition }].filter(Boolean) });
  await important(env, `Focus settimana: ${w.title}`, `${w.why}\n\n• ${w.keys.join('\n• ')}`, 'coach');
  return all[mon];
}

// 4) Domanda libera al coach
export async function ask(env, question) {
  const ctx = await buildContext(env);
  let fb, source = 'ai', error = null;
  if (!env.ANTHROPIC_API_KEY) {
    // Senza API: la domanda aspetta il prossimo giro del coach (attività programmata via connettore)
    const inbox = await get(env, 'inbox', []);
    const item = { id: crypto.randomUUID().slice(0, 8), q: clean(question, 1000), ts: Date.now() };
    await put(env, 'inbox', [...inbox, item].slice(-20));
    return pushFeed(env, { kind: 'answer', question: clean(question, 300), questionId: item.id, pending: true, source: 'rules', headline: 'Domanda ricevuta', verdict: 'info', summary: 'José risponde al prossimo giro (mattina o sera).', kpis: [], adjustments: [], tips: [] });
  } else {
    try {
      const prompt = `Domanda dell'atleta: "${clean(question, 1000)}"
STATO: ${JSON.stringify(ctx.snapshot)}
ULTIME USCITE:\n${ctx.recent.join('\n')}
next7:\n${ctx.next7.map((d) => `${d.date} ${d.giorno}${d.trasferta ? ' [TRASFERTA ' + d.trasferta + ']' : ''}: ${d.sessione}`).join('\n')}
Rispondi nel campo summary (anche 4-8 frasi se serve), metti KPI solo se utili. Schema:\n${FEEDBACK_SCHEMA}`;
      fb = sanitizeFeedback(await claude(env, prompt, 1500), new Set(ctx.next7.map((d) => d.date)));
    } catch (e) { error = e.message; fb = { headline: 'Risposta non disponibile', verdict: 'info', summary: e.message, kpis: [], adjustments: [], tips: [] }; source = 'rules'; }
  }
  return pushFeed(env, { kind: 'answer', question: clean(question, 300), source, error, ...fb });
}
