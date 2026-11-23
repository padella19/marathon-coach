// ============================================================================
// Coach personale: profilo, memoria, domande libere, check-up periodico e
// applicazione del piano ricalibrato. Usato dal connettore MCP (Claude con
// l'abbonamento di Luca, attività programmate) e dalle API della dashboard.
// ============================================================================
import { get, put, getSettings, getCheckins, getFeed, pushFeed, patchFeed } from './store.js';
import { sanitizeFeedback } from './coach.js';
import { important } from './notify.js';
import { syncGarmin } from './garmin.js';
import { briefingExtras, recordTest } from './jose.js';
import {
  todayISO, addDays, diffDays, computeMetrics, phaseAt, planIndex, effective, withPauses, activePause, tripDaySet, vacationDaySet, allTrips,
  logActivities, readiness, reviewTrigger, validatePlan, planDiff, checkinTrend, profileText, guardRunsPerWeek, isRun, rpeOf, loadOf, zoneOf, zoneSeconds,
  fmtPace, fmtMin, DOW_IT, FACILITIES, PAUSE_REASONS, GUARD, REVIEW_HORIZON_DAYS, REVIEW_EVERY_RUNS, runMinutes, stepsFor, isStrengthAct, isMobilityAct,
} from '../public/lib/engine.js';

const clean = (v, n = 600) => String(v ?? '').replace(/<[^>]*>/g, '').trim().slice(0, n);

// ---------- Profilo (lo compila Luca nella dashboard) ----------
export const PROFILE_FIELDS = ['running', 'gym', 'races', 'quitTriggers', 'preferredDays', 'preferredTime', 'longDay', 'impossibleDays', 'typicalWeek', 'workload', 'sports', 'runningExperience', 'injuries', 'weakPoints', 'historyNotes', 'weekdaySlots', 'weekendSlots', 'travelPattern', 'sleepHours', 'workStress', 'lifeNotes', 'goal', 'goalTime', 'motivation', 'boredBy', 'feedbackStyle', 'goalNotes', 'lovedSessions', 'hatedSessions', 'timeOfDay', 'treadmill', 'social', 'prefNotes'];
export function cleanProfile(body) {
  const out = {};
  for (const k of PROFILE_FIELDS) if (body && k in body) { const v = clean(body[k], 600); if (v) out[k] = v; }
  return out;
}

// Profilo conversazionale: José aggiorna singoli campi con quello che impara in chat
export async function updateProfile(env, { set = {}, remove = [] } = {}) {
  const cur = (await get(env, 'profile', null)) || {};
  const patch = cleanProfile(set), gone = (Array.isArray(remove) ? remove : []).filter((k) => PROFILE_FIELDS.includes(k));
  const unknown = Object.keys(set || {}).filter((k) => !PROFILE_FIELDS.includes(k));
  if (!Object.keys(patch).length && !gone.length) return { error: `nessun campo valido. Campi: ${PROFILE_FIELDS.join(', ')}` };
  const next = { ...cur, ...patch, updatedAt: Date.now(), updatedBy: 'jose' };
  for (const k of gone) delete next[k];
  await put(env, 'profile', next);
  return { ok: true, aggiornati: Object.keys(patch), tolti: gone, ...(unknown.length ? { ignorati: unknown } : {}) };
}

// ---------- Memoria del coach ----------
export async function updateMemory(env, { add = [], update = [], remove = [] } = {}) {
  const mem = await get(env, 'coach_memory', { facts: [] });
  let facts = (mem.facts || []).filter((f) => !(remove || []).includes(f.id));
  for (const u of update || []) { const f = facts.find((x) => x.id === u.id); if (f && clean(u.text, 200)) { f.text = clean(u.text, 200); f.date = todayISO(); } }
  for (const a of add || []) { const t = clean(typeof a === 'string' ? a : a?.text, 200); if (t) facts.push({ id: crypto.randomUUID().slice(0, 8), text: t, date: todayISO() }); }
  facts = facts.slice(-30);
  await put(env, 'coach_memory', { facts });
  return facts;
}

// ---------- Contesto completo ----------
async function load(env) {
  const today = todayISO();
  const [settings, plan, overrides0, acts0, trips, checkins, pauses, logs, review, profile, mem, inbox, feed, garmin] = await Promise.all([
    getSettings(env), get(env, 'plan', []), get(env, 'overrides', {}), get(env, 'activities', []), get(env, 'trips', { manual: [], ical: [] }),
    getCheckins(env), get(env, 'pauses', []), get(env, 'logs', []), get(env, 'review', {}), get(env, 'profile', null), get(env, 'coach_memory', { facts: [] }),
    get(env, 'inbox', []), getFeed(env), get(env, 'garmin_sync', null),
  ]);
  const acts = [...acts0, ...logActivities(logs, acts0)];
  const overrides = withPauses(overrides0, pauses, today);
  const m = computeMetrics(acts, settings, today);
  return { today, settings, plan, overrides0, overrides, acts0, acts, trips, checkins, pauses, logs, review, profile, mem, inbox, feed, garmin, m, pIdx: planIndex(plan), tripSet: tripDaySet(trips), vacSet: vacationDaySet(trips) };
}
const trigger = (c) => reviewTrigger({ today: c.today, acts: c.acts, checkins: c.checkins, plan: c.plan, overrides: c.overrides0, settings: c.settings, review: c.review, m: c.m, pauses: c.pauses });

const actLine = (a, hrp) => {
  const r = rpeOf(a, hrp);
  if (!isRun(a)) return `${a.date} ${a.type} "${a.name}" ${fmtMin(a.moving_min)} RPE ${r.v}${r.est ? '~' : ''} carico ${loadOf(a, hrp)}`;
  return `${a.date} ${a.type} "${a.name}" ${a.dist_km}km ${fmtMin(a.moving_min)} ${fmtPace(a.pace_s)} FC ${a.avg_hr || '-'} (Z${zoneOf(a.avg_hr, hrp) || '-'}) RPE ${r.v}${r.est ? '~' : ''} carico ${loadOf(a, hrp)}${a.decoupling != null ? ` deriva ${a.decoupling}%` : ''}`;
};
const sessLine = (s) => (!s ? 'nessuna' : s.kind === 'pause' ? 'PAUSA' : `${s.title} · ${s.kind}${s.min ? ' · ' + s.min + "'" : ''}${s.rpe && s.rpe !== '-' ? ' · RPE ' + s.rpe : ''}${s.strength ? ' · routine ' + s.strength : ''}${s.optional ? ' (facoltativa)' : ''}${s.test ? ' · TEST ' + s.test : ''}`);

export const PROTOCOL = `Sei JOSÉ, l'allenatore di corsa di Luca. Lavori tramite questo connettore, da solo, due volte al giorno (mattina e sera). Luca ti legge nella dashboard: non hai altri canali. Segui i passi in ordine, poi termina.

CHI SEI
- Tono da sergente: diretto, esigente, lo spingi. Italiano, frasi brevi, numeri concreti (passo, FC, minuti, km). Dai del tu. Firma mai, emoji mai, zero complimenti di circostanza.
- SGRIDI quando serve, con il fatto e il numero: sessioni saltate senza motivo, uscite facili corse troppo forte, check-in mancati, volume aumentato di testa sua, "Non riesco" che diventa abitudine. Una sgridata dice cosa è successo, perché conta, cosa fa adesso.
- Riconosci i meriti veri, in modo asciutto ("Tre settimane piene. Così si costruisce."). Mai entusiasmo gratuito.
- NON sgridi MAI su dolore, malattia o stanchezza reale. Lì vale il protocollo di sicurezza: dolore che altera l'appoggio, che peggiora correndo o che dura oltre 48-72 ore → stop corsa e medico o fisioterapista. Non sei un medico e lo dici.
- Chi è Luca: area manager, molte trasferte (camera d'hotel), soffre il freddo, corre col Garmin, non dorme con l'orologio (niente dati di sonno: non chiederli). Obiettivo: FINIRE la maratona. La mezza di Fuerteventura di dicembre non si corre: dal 23/12 è solo vacanza.

PASSI
1. CHAT: rispondi a ogni messaggio di "chat_in_attesa" con coach_send_message (reply_to = id, kind "reply"). Usa "chat_recente" come contesto. Se Luca ti dice qualcosa di duraturo (un infortunio passato, una preferenza, un vincolo) salvalo: coach_update_profile per i campi del profilo, coach_update_memory (add) per il resto. Se ti dice le dotazioni di un hotel, salvale con coach_set_place_amenities.
2. USCITE: per ogni elemento di "uscite_da_commentare" chiama coach_post_feedback (kind "activity", activity_id). "summary" = 2-3 righe: verdetto + 1 numero chiave + cosa cambia. "dettaglio" = l'analisi completa, scritta subito: passo, FC, zone, deriva cardiaca, parziali, confronto col pianificato. Niente domande post-uscita. "adjustments" solo se servono e solo per i prossimi 7 giorni. Se l'uscita era un test (campo "test" o titolo), verifica il risultato in "test.ultimo": se è sbagliato correggilo con "test_result".
3. CHECK-IN: campi energia 1-5, gambe 1-5 (5 = a pezzi), fastidio (zona + 1-10), giornata (leggera/normale/pesante). Commenta "checkin_da_commentare" (kind "checkin") solo se hai qualcosa da aggiungere a "adattamento_regole".
4. SEGNALI: guarda "segnali" e scegli AL MASSIMO UNO per un messaggio spontaneo (coach_send_message senza reply_to, kind "scolding", "praise" o "spontaneous", signal_id = id del segnale). Priorità: sicurezza (fastidio ripetuto: niente sgridata) > sessione saltata / facile troppo forte / volume oltre il piano / nessun check-in / "non riesco" > trasferta con dotazioni ignote (chiedi: tapis roulant? palestra? parco o lungofiume vicino? colazione presto?) > meteo avverso (suggerisci UNA azione: orario migliore, abbigliamento a strati, tapis roulant o scambio col giorno dopo; Luca soffre il freddo) > badge > scarpe > test. Il Worker rifiuta il secondo messaggio spontaneo dello stesso giro: non riprovare. Se nessun segnale merita, non scrivere.
5. VALUTAZIONI: "valutazioni_recenti" sono i 👍/👎 di Luca ai tuoi commenti, con eventuale nota. Adatta stile e contenuti. Quando un'indicazione si ripete salvala in memoria ("preferisce X", "non gli serve Y").
6. REPORT DEL LUNEDÌ: se "report_settimanale.da_scrivere" è true chiama coach_post_weekly_report: voto 1-10 onesto, cosa è andato bene e male (con i numeri di "report_settimanale.numeri", che il Worker ricalcola comunque), focus della settimana nuova.
7. CHECK-UP (campo "checkup.stage"):
   - "ask": coach_ask_questions con 3-6 domande mirate (scale 1-5, scelte, testo breve). Vale anche per approfondire il profilo. Se il motivo è "return" (rientro da una pausa) chiedi come sta, dolori residui, quanto si sente pronto.
   - "apply" o "apply_no_answers": costruisci il piano da domani fino a ${REVIEW_HORIZON_DAYS} giorni e chiama coach_apply_plan. Per ogni corsa fornisci "steps" (zone Z1-Z5): vanno sull'orologio da soli. Decidi "runs_per_week" (3-5). FORZA E MOBILITÀ: indicativamente 2 sessioni a settimana da 15-20' (routine A, B, C a corpo libero, da camera d'hotel) e mobilità breve dopo le corse (strength "E" sulla corsa, o "D"): la frequenza la decidi tu. TRASFERTE: usa "dotazioni" (tapis roulant → la qualità si può fare; solo camera → forza/mobilità o riposo). TEST: ogni 6-8 settimane, mai nel condizionamento né nello scarico, metti una sessione kind "quality" con "test": "5k" oppure "30min" (vedi "test"). "memory.add": 0-3 cose durature imparate.
   - "waiting_answers", "paused", "none": niente check-up.
8. PAUSA: se "pausa_in_corso" non è null non commentare uscite né check-in, non sgridare, non fare check-up. Puoi rispondere alla chat.
9. PROFILO: se "profilo_mancante" è true, chiedi una volta in chat di compilarlo (4 schermate nella dashboard). Se è compilato ma ti manca qualcosa che ti serve, chiedilo in chat, una domanda alla volta.
10. ALIMENTAZIONE: prudente. Niente diete, calorie o pesate. Solo indicazioni generali da linee guida consolidate (ACSM, ISSN): cosa fare prima/dopo per tipo di sessione; nei lunghi dai 90' in su idratazione e carboidrati durante; allenare l'intestino provando gel e ristori nei lunghi, mesi prima della gara; ultimi giorni carico di carboidrati in forma generale, niente novità. Sempre con una riga di "perché". Per esigenze specifiche: "senti un nutrizionista".
11. PREVISIONE: "previsione" è informativa, serve a fissare il passo di gara. Non trasformarla in un obiettivo cronometrico.
12. Mai inventare dati che non sono nel briefing (né dettagli del percorso di Francoforte). Se non c'è niente da fare, non fare niente.`;

export async function briefing(env) {
  const c = await load(env), { today, settings, m } = c, hrp = m.hrp;
  const ph = phaseAt(today, settings), trig = trigger(c), pause = activePause(c.pauses, today);
  const lastReview = c.review.lastReviewAt ? new Date(c.review.lastReviewAt).toISOString().slice(0, 10) : null;
  const sinceRev = lastReview || addDays(today, -14);
  const fresh = c.acts0.filter((a) => a.date >= addDays(today, -3) && !a.coached);
  const ci = c.checkins[today];
  const checkinFeed = c.feed.find((f) => f.kind === 'checkin' && f.refDate === today);
  const plan28 = [];
  for (let i = 0; i <= REVIEW_HORIZON_DAYS; i++) {
    const d = addDays(today, i), s = effective(d, c.pIdx, c.overrides), tr = allTrips(c.trips).find((t) => t.start <= d && d <= (t.end || t.start));
    plan28.push({ data: d, giorno: DOW_IT[new Date(d + 'T00:00:00Z').getUTCDay()], sessione: sessLine(s), passi: s?.steps || stepsFor(s) || null,
      trasferta: tr && tr.type !== 'vacation' ? { citta: tr.city || tr.title, dotazioni: tr.facilities ? (tr.facilities.length ? tr.facilities.map((f) => FACILITIES[f]) : ['non lo sa']) : 'non ancora chieste (considera solo camera)' } : null,
      vacanza: tr && tr.type === 'vacation' ? tr.city || tr.title : null, garmin: c.garmin?.days?.[d]?.status || null });
  }
  const wk = m.weeks.slice(-8).map((w) => `${w.week}: ${w.km.toFixed(1)} km, ${w.runs} corse, lungo ${fmtMin(w.longMin)}, carico ${w.load}`);
  const strength14 = c.acts.filter((a) => a.date > addDays(today, -14) && (isStrengthAct(a) || isMobilityAct(a))).map((a) => `${a.date} ${isMobilityAct(a) ? 'mobilità' : 'forza'} ${fmtMin(a.moving_min)}${a.src === 'log' ? ' (segnata a mano)' : ' (Garmin)'}`);
  const pt = profileText(c.profile);
  return {
    oggi: today, ora_roma: new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit' }).format(new Date()),
    protocollo: PROTOCOL,
    gara: { nome: settings.raceName, data: settings.raceDate, giorni: diffDays(today, settings.raceDate), nota: 'Maratona di Francoforte: fine ottobre, clima di solito fresco. Non inventare dettagli del percorso.' },
    preparazione: { inizio: settings.planStart, fase: ph.name, settimana: `${ph.week}/${ph.total}`, scarico: !!ph.rec, focus_fase: ph.focus },
    corse_a_settimana: { attuale: settings.runsPerWeek || 3, storico: (settings.rpwHistory || []).slice(-5) },
    profilo: pt, profilo_mancante: !pt,
    memoria: (c.mem.facts || []).map((f) => ({ id: f.id, testo: f.text, data: f.date })),
    pausa_in_corso: pause ? { dal: pause.from, rientro_previsto: pause.to, motivo: PAUSE_REASONS[pause.reason], nota: pause.note } : null,
    pause_recenti: c.pauses.filter((p) => p.endedOn && p.endedOn >= addDays(today, -60)).map((p) => ({ dal: p.from, rientro: p.endedOn, motivo: PAUSE_REASONS[p.reason] })),
    checkup: {
      stage: trig.stage, motivi: trig.reasons.map((r) => ({ k: r.k, testo: r.label })), allenamenti_dall_ultimo: trig.runsSince, ogni: REVIEW_EVERY_RUNS, ultimo: lastReview,
      ultima_sintesi: c.review.lastSummary || null,
      domande: c.review.status === 'questions' ? c.review.questions : null, risposte: c.review.status === 'questions' ? c.review.answers || null : null,
      domande_e_risposte_precedenti: c.review.lastQA || null,
    },
    limiti_di_sicurezza: `Applicati dal Worker al piano che proponi: volume settimanale max +${Math.round(GUARD.weeklyGrowth * 100)}% sulla media delle 3 settimane precedenti; lungo max +${GUARD.longStepMin}' sul più lungo delle ultime 3 settimane; max ${GUARD.maxQualityPerWeek} qualità a settimana, mai consecutive; almeno 1 riposo completo a settimana; con fastidio ≥${GUARD.painLock} negli ultimi 3 check-in nessun aumento e niente qualità; in trasferta niente lunghi; ultime 3 settimane solo riduzioni; dopo una pausa ≥7 giorni per 2 settimane volume max ${Math.round(GUARD.returnFactor * 100)}% di prima; corse a settimana +1 al massimo per check-up.`,
    metriche: {
      acwr: m.calibrating ? 'in calibrazione' : m.acwr?.toFixed(2), forma_pct: m.form != null ? Math.round(m.form) : null, monotonia: m.monotony,
      km_settimana: +m.week.km.toFixed(1), km_settimana_prec: m.prevWeek ? +m.prevWeek.km.toFixed(1) : null, z1z2_28g_pct: m.polar != null ? Math.round(m.polar) : null,
      efficienza_trend_pct: m.efTrend != null ? +m.efTrend.toFixed(1) : null, zone_fc: hrp.zones.map((z) => `Z${z.z} ${z.lo}-${z.hi}`).join(', ') + ` (${hrp.src})`,
    },
    readiness_oggi: readiness(ci, m),
    uscite_da_commentare: fresh.map((a) => {
      const z = zoneSeconds(a, hrp), tot = z.reduce((x, y) => x + y, 0) || 1;
      return { id: a.id, data: a.date, nome: a.name, tipo: a.type, km: a.dist_km, minuti: a.moving_min, passo: fmtPace(a.pace_s), fc_media: a.avg_hr, fc_max: a.max_hr, rpe: rpeOf(a, hrp), zone_pct: z.map((v) => Math.round((v / tot) * 100)), deriva_pct: a.decoupling ?? null, split_km: (a.splits || []).slice(0, 45).map((s) => `${fmtPace(s.p)}@${s.hr || '-'}`), nota: a.desc || null, pianificata: sessLine(effective(a.date, c.pIdx, c.overrides)), test: effective(a.date, c.pIdx, c.overrides)?.test || null };
    }),
    checkin_da_commentare: ci && !c.feed.some((f) => f.kind === 'checkin' && f.refDate === today && f.source === 'claude') ? { ...ci, adattamento_regole: checkinFeed ? `${checkinFeed.headline}: ${checkinFeed.summary}` : null } : null,
    ...(await briefingExtras(env, c)),
    domande_in_attesa: c.inbox.map((q) => ({ question_id: q.id, testo: q.q, ricevuta: new Date(q.ts).toISOString() })),
    andamento_checkin_14g: checkinTrend(c.checkins, today, 14),
    ultime_uscite: c.acts.filter((a) => a.date >= addDays(sinceRev, -7)).slice(-20).map((a) => actLine(a, hrp)),
    forza_e_mobilita_14g: strength14,
    settimane: wk,
    storico_feedback: c.feed.slice(0, 15).map((f) => ({ data: new Date(f.ts).toISOString().slice(0, 10), tipo: f.kind, fonte: f.source, titolo: f.headline, applicata: !!f.applied, valutazione: f.rating || null, ...(f.ratingNote ? { nota: f.ratingNote } : {}) })),
    piano_prossimi_28_giorni: plan28,
  };
}

// ---------- Tool: commenti del coach ----------
export async function postFeedback(env, { items = [] } = {}) {
  const c = await load(env);
  const allowed = new Set(Array.from({ length: 7 }, (_, i) => addDays(c.today, i)));
  const out = [];
  let acts = null, inbox = c.inbox;
  for (const it of (Array.isArray(items) ? items : []).slice(0, 12)) {
    const kind = ['activity', 'checkin', 'answer', 'note'].includes(it.kind) ? it.kind : 'note';
    const fb = sanitizeFeedback(it, allowed);
    const extra = {};
    const det = clean(it.dettaglio ?? it.detail, 5000); if (det) extra.detail = det;
    if (kind === 'activity') {
      acts ||= await get(env, 'activities', []);
      const a = acts.find((x) => String(x.id) === String(it.activity_id));
      if (!a) { out.push({ error: `uscita ${it.activity_id} non trovata` }); continue; }
      extra.ref = a.id; extra.refDate = a.date;
    }
    if (kind === 'checkin') extra.refDate = c.today;
    if (kind === 'answer') {
      const q = inbox.find((x) => x.id === it.question_id);
      if (!q) { out.push({ error: `domanda ${it.question_id} non trovata` }); continue; }
      extra.question = q.q.slice(0, 300); extra.questionId = q.id;
      inbox = inbox.filter((x) => x.id !== q.id);
      const pend = c.feed.find((f) => f.questionId === q.id && f.pending);
      if (pend) await patchFeed(env, pend.id, { superseded: true, pending: false });
    }
    const e = await pushFeed(env, { kind, source: 'claude', ...extra, ...fb });
    if (kind === 'activity') {
      const a = acts.find((x) => String(x.id) === String(extra.ref)); a.coached = e.id;
      if (it.test_result && typeof it.test_result === 'object') { const t = await recordTest(env, { ...it.test_result, date: a.date, activity_id: a.id, source: 'jose' }); if (t.error) out.push({ error: `test: ${t.error}` }); }
    }
    if (fb.verdict === 'warning') { await patchFeed(env, e.id, { important: true }); await important(env, fb.headline, fb.summary, 'coach'); }
    out.push({ ok: true, id: e.id, kind });
  }
  if (acts) await put(env, 'activities', acts);
  if (inbox !== c.inbox) await put(env, 'inbox', inbox);
  return { saved: out.filter((x) => x.ok).length, results: out };
}

// ---------- Tool: domande del check-up ----------
export async function askQuestions(env, { intro = '', questions = [] } = {}) {
  const c = await load(env), trig = trigger(c);
  if (trig.stage !== 'ask') return { error: `Ora non serve un check-up (stato: ${trig.stage})` };
  const qs = (Array.isArray(questions) ? questions : []).slice(0, 6).map((q, i) => {
    const type = ['scale', 'choice', 'text'].includes(q?.type) ? q.type : 'text';
    const options = type === 'choice' ? (Array.isArray(q.options) ? q.options : []).map((o) => clean(o, 40)).filter(Boolean).slice(0, 6) : undefined;
    return { id: clean(q?.id, 20) || `q${i + 1}`, text: clean(q?.text, 200), type: type === 'choice' && !options?.length ? 'text' : type, ...(options?.length ? { options } : {}) };
  }).filter((q) => q.text);
  if (qs.length < 2) return { error: 'Servono almeno 2 domande' };
  const review = { ...c.review, status: 'questions', intro: clean(intro, 400), reasons: trig.reasons, questions: qs, askedAt: Date.now(), answers: {}, answeredAt: null };
  await put(env, 'review', review);
  const e = await pushFeed(env, { kind: 'checkup_q', source: 'claude', headline: 'José vuole fare il punto', verdict: 'info', summary: `${review.intro || trig.reasons.map((r) => r.label).join(' · ')} Rispondi alle domande nella dashboard (2 minuti).`, kpis: [], adjustments: [], tips: [], important: true });
  await important(env, 'José vuole fare il punto', `${qs.length} domande veloci nella dashboard (2 minuti).`, 'oggi');
  return { ok: true, questions: qs.length, feed: e.id };
}
export async function saveAnswers(env, answers) {
  const review = await get(env, 'review', {});
  if (review.status !== 'questions') return { error: 'nessuna domanda aperta' };
  const out = {};
  for (const q of review.questions || []) {
    const v = answers?.[q.id];
    if (v == null || v === '') continue;
    out[q.id] = q.type === 'scale' ? Math.max(1, Math.min(5, Math.round(+v) || 3)) : q.type === 'choice' ? (q.options.includes(v) ? v : clean(v, 40)) : clean(v, 400);
  }
  await put(env, 'review', { ...review, answers: out, answeredAt: Date.now() });
  return { ok: true };
}

// ---------- Tool: applica il piano ricalibrato ----------
export async function applyPlan(env, { summary = '', why = '', sessions = [], memory = null, runs_per_week = null } = {}) {
  const c = await load(env), trig = trigger(c);
  if (!['apply', 'apply_no_answers', 'ask'].includes(trig.stage) && !c.review.requested) return { error: `Ora non c'è un check-up da applicare (stato: ${trig.stage})` };
  const res = validatePlan(sessions, { today: c.today, plan: c.plan, overrides: c.overrides, acts: c.acts, checkins: c.checkins, tripSet: c.tripSet, settings: c.settings, pauses: c.pauses });
  if (!res.sessions.length) return { error: 'Nessuna sessione valida nel piano proposto', corrections: res.corrections };
  // snapshot per "Annulla"
  const snapId = crypto.randomUUID().slice(0, 8);
  const snaps = await get(env, 'plan_snapshots', []);
  snaps.push({ id: snapId, ts: Date.now(), plan: c.plan, overrides: c.overrides0, from: res.from, to: res.to });
  await put(env, 'plan_snapshots', snaps.slice(-5));
  // differenze rispetto a quanto c'era (piano + override + pause)
  const before = Object.fromEntries(res.sessions.map((s) => [s.date, effective(s.date, c.pIdx, c.overrides)]));
  const diff = planDiff(before, res.sessions);
  // nuovo piano: sostituisce i giorni proposti, tiene gli override manuali recenti
  const byDate = Object.fromEntries(res.sessions.map((s) => [s.date, s]));
  const plan = c.plan.map((p) => byDate[p.date] || p);
  for (const s of res.sessions) if (!c.pIdx[s.date]) plan.push(s);
  plan.sort((a, b) => a.date.localeCompare(b.date));
  const ov = { ...c.overrides0 }, keptManual = [];
  for (const d of Object.keys(byDate)) {
    const o = ov[d]; if (!o) continue;
    if (o.manual && o.ts && Date.now() - o.ts < 7 * 864e5) keptManual.push(d); else delete ov[d];
  }
  await put(env, 'plan', plan); await put(env, 'overrides', ov);
  // corse a settimana (limite: +1 per check-up)
  let rpwNote = null, rpw = c.settings.runsPerWeek || 3;
  if (runs_per_week != null) {
    const g = guardRunsPerWeek(rpw, runs_per_week, { acts: c.acts, checkins: c.checkins, plan: c.plan, overrides: c.overrides, today: c.today, m: c.m });
    rpwNote = g.note;
    if (g.value !== rpw) {
      const raw = await get(env, 'settings', {});
      await put(env, 'settings', { ...raw, runsPerWeek: g.value, rpwHistory: [...(raw.rpwHistory || []), { date: c.today, from: rpw, to: g.value, why: clean(why, 200) }].slice(-20) });
      rpw = g.value;
    }
  }
  const facts = memory ? await updateMemory(env, memory) : null;
  const ph = phaseAt(c.today, c.settings);
  await put(env, 'review', { status: 'idle', lastReviewAt: Date.now(), lastPhase: ph.id, requested: false, lastSummary: clean(summary, 400), lastQA: c.review.questions ? { domande: c.review.questions, risposte: c.review.answers || null } : c.review.lastQA || null });
  const corrections = [...res.corrections, ...(rpwNote ? [rpwNote] : []), ...(keptManual.length ? [`Tenute le tue modifiche manuali del ${keptManual.join(', ')}`] : [])];
  const e = await pushFeed(env, { kind: 'review', source: 'claude', headline: clean(summary, 120) || 'Piano ricalibrato', verdict: 'info', summary: clean(why, 900), diff: diff.slice(0, 40), corrections, snapshotId: snapId, undoUntil: Date.now() + 7 * 864e5, runsPerWeek: rpw, kpis: [], adjustments: [], tips: [], important: true });
  await important(env, 'Piano ricalibrato', `${clean(summary, 200)}\n\n${diff.slice(0, 3).map((x) => `• ${x.date.slice(5)}: ${x.before} → ${x.after}`).join('\n')}${diff.length > 3 ? `\n…e altre ${diff.length - 3} modifiche` : ''}`, 'coach');
  let garmin = null;
  try { garmin = await syncGarmin(env, 'check-up'); } catch (err) { garmin = { error: err.message }; }
  return { ok: true, applied: res.sessions.length, from: res.from, to: res.to, changes: diff.length, corrections, runs_per_week: rpw, memory: facts ? facts.length : undefined, garmin: garmin?.error ? `non inviato: ${garmin.error}` : garmin?.skipped || 'inviato' };
}

export async function undoReview(env, snapshotId) {
  const snaps = await get(env, 'plan_snapshots', []), s = snaps.find((x) => x.id === snapshotId);
  if (!s) return { error: 'versione precedente non trovata' };
  if (Date.now() - s.ts > 7 * 864e5) return { error: 'si può annullare solo entro 7 giorni' };
  await put(env, 'plan', s.plan); await put(env, 'overrides', s.overrides);
  const card = (await getFeed(env)).find((f) => f.snapshotId === snapshotId);
  if (card) await patchFeed(env, card.id, { undone: true });
  await pushFeed(env, { kind: 'system', source: 'rules', headline: 'Ricalibrazione annullata', verdict: 'info', summary: 'Il piano è tornato com\'era prima del check-up.', kpis: [], adjustments: [], tips: [] });
  try { await syncGarmin(env, 'annulla'); } catch (_) { /* non bloccante */ }
  return { ok: true };
}
