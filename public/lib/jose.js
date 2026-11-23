// ============================================================================
// José — logica condivisa (Worker + dashboard), senza dipendenze e senza I/O:
// segnali per i messaggi spontanei, badge, test e previsione maratona,
// opzioni di "Non riesco", scarpe, meteo, numeri del report settimanale.
// ============================================================================
import {
  addDays, diffDays, dow, mondayOf, effective, isRun, zoneSeconds, weekView, tripOn, phaseAt, runMinutes, easySteps,
  RUN_KINDS, DOW_IT_LONG, fmtDate, fmtPace, clamp,
} from './engine.js';

// ---------- Luoghi (dotazioni per città, riusate alle trasferte successive) ----------
export const cityKey = (c) => String(c || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
export const AMENITIES = { treadmill: 'tapis roulant', gym: 'palestra', outdoor: 'parco o lungofiume vicino', early_breakfast: 'colazione presto' };
export function placeText(p) {
  if (!p) return null;
  const yes = Object.keys(AMENITIES).filter((k) => p[k] === true).map((k) => AMENITIES[k]);
  const no = Object.keys(AMENITIES).filter((k) => p[k] === false).map((k) => AMENITIES[k]);
  return `${p.hotel ? p.hotel + ': ' : ''}${yes.length ? yes.join(', ') : 'solo camera'}${no.length ? ` (no: ${no.join(', ')})` : ''}${p.note ? ' · ' + p.note : ''}`;
}

// ---------- Quando ripassa José (due attività programmate al giorno) ----------
export function nextRun(hm, s = {}) {
  const am = s.runMorning || '07:00', pm = s.runEvening || '21:00';
  if (hm < am) return { quando: 'stamattina', ora: am };
  if (hm < pm) return { quando: 'stasera', ora: pm };
  return { quando: 'domattina', ora: am };
}
// Stato di José dall'ultima chiamata del connettore
export function joseStatus(last, now = Date.now()) {
  if (!last) return { ok: false, mai: true, testo: 'José non è ancora passato: collega il connettore e crea le due attività programmate' };
  const h = (now - last) / 3.6e6;
  const f = (o) => new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', ...o }).format(new Date(last));
  const day = (t) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(new Date(t));
  const hour = +f({ hour: '2-digit', hour12: false }).slice(0, 2), d = diffDays(day(last), day(now));
  const part = hour < 12 ? 'mattina' : hour < 18 ? 'pomeriggio' : 'sera';
  const when = d === 0 ? (part === 'mattina' ? 'stamattina' : part === 'sera' ? 'stasera' : 'oggi pomeriggio') : d === 1 ? `ieri ${part}` : `${d} giorni fa`;
  if (h > 36) return { ok: false, ore: Math.round(h), testo: `José non si fa vivo da ${Math.round(h)} ore: controlla le attività programmate` };
  return { ok: true, ore: Math.round(h), testo: `attivo · ultima visita ${when} ${f({ hour: '2-digit', minute: '2-digit' })}` };
}

// ---------- Meteo (dati Open-Meteo già ridotti dal Worker alla fascia oraria preferita) ----------
export function weatherVerdict(d, coldC = 5) {
  if (!d) return null;
  const motivi = [];
  if (d.feels != null && d.feels <= coldC) motivi.push(`percepiti ${Math.round(d.feels)} °C`);
  if ((d.rain_prob ?? 0) >= 70 || (d.rain_mm ?? 0) >= 1) motivi.push(`pioggia ${d.rain_prob ?? '?'}%`);
  if ((d.wind ?? 0) >= 35) motivi.push(`vento ${Math.round(d.wind)} km/h`);
  const better = d.best && d.best.hour !== d.hour && d.best.feels - (d.feels ?? 0) >= 3 && (d.best.rain_prob ?? 0) < 50;
  let consiglio = '';
  if (motivi.length) {
    const cold = d.feels != null && d.feels <= coldC, wet = (d.rain_prob ?? 0) >= 70 || (d.rain_mm ?? 0) >= 1;
    consiglio = better ? `Meglio alle ${String(d.best.hour).padStart(2, '0')}:00 (${Math.round(d.best.feels)} °C percepiti).`
      : cold && wet ? 'Freddo e pioggia: tapis roulant se c\'è, altrimenti scambia con il giorno dopo.'
        : cold ? 'A strati: maglia termica, antivento, guanti e fascia. I primi 10\' al coperto o più lenti.'
          : wet ? 'Antipioggia leggero e cappellino, oppure tapis roulant.' : 'Giro riparato dal vento, andata controvento e ritorno a favore.';
  }
  return { bad: motivi.length > 0, motivi, consiglio };
}

// ---------- Uscita facile corsa troppo forte: quota di tempo sopra Z2 ----------
export function aboveZ2Share(a, hrp) {
  const z = zoneSeconds(a, hrp), tot = z.reduce((x, y) => x + y, 0);
  return tot ? (z[2] + z[3] + z[4]) / tot : null;
}

// ---------- Settimana: numeri per report, badge e segnali ----------
const isPlannedRun = (p) => !!p && RUN_KINDS.includes(p.kind) && !p.optional && p.min > 0;
export function weekNumbers(mon, ctx) {
  const days = weekView(mon, ctx);
  const sess = days.filter((d) => isPlannedRun(d.plan) && d.date <= ctx.today);
  const n = (st) => sess.filter((d) => d.status === st).length;
  const planMin = days.reduce((t, d) => t + (isPlannedRun(d.plan) ? runMinutes(d.plan) : 0), 0);
  const str = days.filter((d) => d.str && d.date <= ctx.today && !d.str.optional);
  return {
    settimana: mon, corse_pianificate: days.filter((d) => isPlannedRun(d.plan)).length, corse_fatte: n('done'), parziali: n('partial'), saltate: n('missed'),
    km: Math.round(days.reduce((t, d) => t + d.km, 0) * 10) / 10, minuti_corsa: Math.round(days.reduce((t, d) => t + d.runMin, 0)), minuti_pianificati: Math.round(planMin),
    forza_fatta: str.filter((d) => d.str.done).length, forza_prevista: str.length,
    costanza_pct: sess.length ? Math.round((n('done') / sess.length) * 100) : null,
    completa: sess.length > 0 && sess.every((d) => d.status === 'done') && !days.some((d) => d.status === 'pause'),
  };
}

// ---------- Badge ----------
export const BADGES = [
  { id: 'week1', nome: 'Prima settimana completa', desc: 'Tutte le corse previste, dal lunedì alla domenica' },
  ...[10, 15, 20, 25, 30].map((k) => ({ id: `long${k}`, nome: `Primo lungo da ${k} km`, desc: `Una corsa di almeno ${k} km` })),
  { id: 'month100', nome: '100 km in un mese', desc: '100 km nello stesso mese di calendario' },
  ...[4, 8, 12].map((k) => ({ id: `streak${k}`, nome: `${k} settimane di fila`, desc: `${k} settimane complete consecutive` })),
  { id: 'test1', nome: 'Primo test', desc: 'Il primo test cronometrato' },
  { id: 'trip1', nome: 'Corsa in trasferta', desc: 'Il primo allenamento fatto fuori casa per lavoro' },
  { id: 'km1000', nome: '1000 km', desc: '1000 km totali dall\'inizio della preparazione' },
];
// Restituisce { id: data in cui è stato raggiunto }. Conta dall'inizio della preparazione.
export function computeBadges({ acts = [], pIdx, overrides, tripSet = new Map(), today, settings, tests = [] }) {
  const out = {}, from = settings.planStart;
  const runs = acts.filter((a) => isRun(a) && a.date >= from && a.date <= today).sort((a, b) => a.date.localeCompare(b.date));
  let tot = 0; const month = {};
  for (const a of runs) {
    const km = a.dist_km || 0;
    for (const k of [10, 15, 20, 25, 30]) if (km >= k) out[`long${k}`] ||= a.date;
    tot += km; if (tot >= 1000) out.km1000 ||= a.date;
    const mo = a.date.slice(0, 7); month[mo] = (month[mo] || 0) + km; if (month[mo] >= 100) out.month100 ||= a.date;
    if (tripSet.has(a.date)) out.trip1 ||= a.date;
  }
  if (tests.length) out.test1 = [...tests].sort((a, b) => a.date.localeCompare(b.date))[0].date;
  let streak = 0;
  const ctx = { pIdx, overrides, acts, tripSet, today };
  for (let mon = mondayOf(from); addDays(mon, 6) < today; mon = addDays(mon, 7)) {
    const w = weekNumbers(mon, ctx);
    if (!w.corse_pianificate) continue; // settimane vuote (pausa, pre-partenza): non contano e non interrompono
    if (!w.completa) { streak = 0; continue; }
    streak++; const sun = addDays(mon, 6);
    out.week1 ||= sun;
    for (const k of [4, 8, 12]) if (streak >= k) out[`streak${k}`] ||= sun;
  }
  return out;
}

// ---------- Test periodici e previsione maratona ----------
export const MARATHON_KM = 42.195;
export const TEST_TYPES = { '5k': 'Test 5 km', '30min': 'Test 30\' a sensazione' };
// Riegel: T2 = T1 × (D2/D1)^e. L'esponente classico 1,06 è ottimista per una prima maratona:
// valore centrale 1,10, forchetta 1,06-1,15.
export function predict(distKm, timeS) {
  if (!(distKm > 0) || !(timeS > 0)) return null;
  const f = (e) => Math.round(timeS * Math.pow(MARATHON_KM / distKm, e));
  const sec = f(1.10);
  return { sec, lo: f(1.06), hi: f(1.15), passo_s: Math.round(sec / MARATHON_KM) };
}
export const fmtHMS = (s) => { s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return `${h}h${String(m).padStart(2, '0')}`; };
export const fmtClock = (s) => { s = Math.round(s); const m = Math.floor(s / 60); return `${m}:${String(s % 60).padStart(2, '0')}`; };
// Zone di passo dal test (passo equivalente sui 5 km)
export function paceZones(distKm, timeS) {
  if (!(distKm > 0) || !(timeS > 0)) return null;
  const p5 = (timeS * Math.pow(5 / distKm, 1.06)) / 5, r = (k) => Math.round(p5 * k);
  return [
    { nome: 'Facile', da: r(1.40), a: r(1.25) }, { nome: 'Medio', da: r(1.18), a: r(1.12) },
    { nome: 'Soglia', da: r(1.09), a: r(1.05) }, { nome: 'Veloce (5 km)', da: r(1.0), a: r(0.97) },
  ];
}
// Risultato del test ricavato dall'uscita (parziali al km), da confermare in dashboard
export function extractTest(a, type) {
  if (!a || !isRun(a)) return null;
  const sp = (a.splits || []).map((s) => s.p).filter((p) => p > 0);
  const hr = { hr_avg: a.avg_hr || null, hr_max: a.max_hr || null };
  if (type === '5k') {
    if (sp.length >= 5) { let best = Infinity; for (let i = 0; i + 5 <= sp.length; i++) best = Math.min(best, sp.slice(i, i + 5).reduce((x, y) => x + y, 0)); return { dist_km: 5, time_s: Math.round(best), ...hr }; }
    return a.dist_km >= 4.5 && a.pace_s ? { dist_km: 5, time_s: Math.round(a.pace_s * 5), approx: true, ...hr } : null;
  }
  if (sp.length >= 3) {
    let best = 0;
    for (let i = 0; i < sp.length; i++) { let t = 0, km = 0; for (let j = i; j < sp.length && t < 1800; j++) { const take = Math.min(sp[j], 1800 - t); km += take / sp[j]; t += take; } if (t >= 1800) best = Math.max(best, km); }
    if (best) return { dist_km: Math.round(best * 100) / 100, time_s: 1800, ...hr };
  }
  return a.moving_min >= 28 && a.pace_s ? { dist_km: Math.round((1800 / a.pace_s) * 100) / 100, time_s: 1800, approx: true, ...hr } : null;
}
// Un test ogni 6-8 settimane, non nel condizionamento iniziale né nello scarico
export function testDue(tests = [], today, settings) {
  const ph = phaseAt(today, settings);
  const last = [...tests].sort((a, b) => a.date.localeCompare(b.date)).pop() || null;
  const weeks = Math.floor(diffDays(last?.date || settings.planStart, today) / 7);
  const ok = ['base', 'build', 'spec'].includes(ph.id);
  return { ultimo: last, settimane_dall_ultimo: last ? weeks : null, da_pianificare: ok && weeks >= 6, in_ritardo: ok && weeks >= 8 };
}
// Piano di passo per la gara: fasce con margine prudente (dal valore centrale alla parte lenta della forchetta)
export function racePlan(pred) {
  if (!pred) return null;
  const p = pred.passo_s, slow = Math.round(pred.hi / MARATHON_KM);
  return [
    { da: 0, a: 10, lo: p + 10, hi: slow + 10, nota: 'Parti piano: deve sembrarti troppo facile.' },
    { da: 10, a: 30, lo: p, hi: slow, nota: 'Ritmo costante, gel e acqua secondo il piano provato nei lunghi.' },
    { da: 30, a: 42.2, lo: p, hi: slow + 15, nota: 'A sensazione: tieni se ne hai, altrimenti cala senza fermarti. L\'obiettivo è finirla.' },
  ];
}

// ---------- "Non riesco": due opzioni valide (più "la salto") nel rispetto dei limiti di sicurezza ----------
const restOf = (date, desc) => ({ date, dow: dow(date), kind: 'rest', title: 'Riposo', min: 0, rpe: '-', zone: '-', desc, hotel: true, strength: null, optional: false });
export function skipOptions(date, { pIdx, overrides, tripSet = new Map(), settings }) {
  const s = effective(date, pIdx, overrides);
  if (!s || !RUN_KINDS.includes(s.kind) || !s.min) return null;
  const at = (d) => (d === date ? null : effective(d, pIdx, overrides));
  const free = (d) => { const e = at(d); return d < settings.raceDate && (!e || e.kind === 'rest' || (e.optional && e.kind !== 'pause')); };
  const hard = (e) => !!e && (e.kind === 'quality' || e.kind === 'long' || e.kind === 'race');
  const restLeft = (d) => { const mon = mondayOf(d); let n = 0; for (let i = 0; i < 7; i++) { const x = addDays(mon, i); if (x !== d && (x === date || !at(x) || at(x).kind === 'rest')) n++; } return n >= 1; };
  const name = (d) => (d === addDays(date, 1) ? 'domani' : `${DOW_IT_LONG[dow(d)].toLowerCase()} ${fmtDate(d)}`);
  const opts = [];
  for (let i = 1; i <= 6; i++) {
    const d = addDays(date, i), sameWeek = mondayOf(d) === mondayOf(date);
    if (!sameWeek && i > 2) break;
    if (!free(d) || !restLeft(d)) continue;
    if (s.kind === 'long' && tripSet.has(d)) continue;
    if ((s.kind === 'quality' || s.kind === 'long') && (hard(at(addDays(d, -1))) || hard(at(addDays(d, 1))))) continue;
    const min = sameWeek ? s.min : Math.max(20, Math.round((s.min * 0.8) / 5) * 5);
    const sess = { ...s, date: d, dow: dow(d), min, hotel: s.hotel || tripSet.has(d), ...(min !== s.min ? { steps: s.kind === 'easy' || s.kind === 'long' ? easySteps(min) : undefined } : {}) };
    opts.push({ k: 'move', to: d, label: `Spostala a ${name(d)}`, sub: sameWeek ? `${s.title}, ${s.min}' interi` : `${s.title}, ${min}' (-20%: è già la settimana nuova)`,
      patch: { [date]: restOf(date, `Sessione spostata a ${name(d)}.`), [d]: sess } });
    break;
  }
  const tmr = addDays(date, 1), sm = Math.min(25, s.min);
  const short = (d, min) => ({ ...s, date: d, dow: dow(d), kind: 'easy', title: 'Facile breve', min, rpe: '3', zone: 'Z1-Z2', desc: `Versione corta al posto di "${s.title}": ${min}' facili, niente variazioni.`, hotel: true, strength: null, optional: false, steps: easySteps(min), strides: false });
  if (free(tmr) && restLeft(tmr)) opts.push({ k: 'short', to: tmr, label: `Accorciala a ${sm}' domani`, sub: 'Facile in Z1-Z2, oggi riposo', patch: { [date]: restOf(date, `Sessione accorciata e spostata a domani.`), [tmr]: short(tmr, sm) } });
  else opts.push({ k: 'short', to: date, label: `Versione minima oggi: ${Math.min(20, s.min)}'`, sub: 'Facile in Z1-Z2, anche a fine giornata', patch: { [date]: short(date, Math.min(20, s.min)) } });
  opts.push({ k: 'skip', to: null, label: 'La salto', sub: 'Resta segnata come saltata: José ne terrà conto', patch: { [date]: restOf(date, `"${s.title}" saltata.`) } });
  return { session: s, options: opts };
}

// ---------- Scarpe ----------
export function shoeOf(a, shoes) {
  const id = shoes?.assign?.[a.id];
  if (id) return id === 'none' ? null : id;
  const d = (shoes?.list || []).find((x) => x.def && !x.retired && a.date >= (x.start || '0000'));
  return d ? d.id : null;
}
export function shoeKm(shoes, acts = []) {
  const km = {};
  for (const a of acts) if (isRun(a)) { const id = shoeOf(a, shoes); if (id) km[id] = (km[id] || 0) + (a.dist_km || 0); }
  return (shoes?.list || []).map((x) => { const tot = Math.round(((+x.km0 || 0) + (km[x.id] || 0)) * 10) / 10, lim = +x.limit || 600; return { ...x, km: tot, limit: lim, pct: clamp(Math.round((tot / lim) * 100), 0, 999), alert: tot >= lim, near: tot >= lim * 0.85 && tot < lim }; });
}

// ---------- Segnali: il Worker li calcola, José decide se scrivere (max 1 messaggio spontaneo per giro) ----------
export function signals({ today, acts = [], pIdx, overrides, checkins = {}, trips, m, settings, meteo, skips = [], newBadges = [], shoes, tests = [], pause, places = {} }) {
  const out = [], add = (id, tipo, testo, extra = {}) => out.push({ id, tipo, testo, ...extra });
  if (pause) return out;
  const started = today >= settings.planStart;
  if (started) {
    const dates = Object.keys(checkins).filter((d) => d <= today).sort(), last = dates.pop() || null;
    const gap = diffDays(last && last > settings.planStart ? last : addDays(settings.planStart, -1), today);
    if (gap >= 3) add(`nocheckin:${last || 'mai'}`, 'nessun_checkin', `Nessun check-in da ${gap} giorni${last ? ` (ultimo ${last})` : ''}`);
  }
  for (let i = 3; i >= 1; i--) {
    const d = addDays(today, -i), p = effective(d, pIdx, overrides);
    if (!isPlannedRun(p) || d < settings.planStart) continue;
    const done = acts.filter((a) => a.date === d && isRun(a)).reduce((t, a) => t + (a.moving_min || 0), 0);
    if (done < p.min * 0.4 && !skips.some((k) => k.date === d)) add(`missed:${d}`, 'sessione_saltata', `${d}: "${p.title}" ${p.min}' pianificata e non fatta, senza avvisare`);
  }
  for (const a of acts.filter((x) => isRun(x) && x.date >= addDays(today, -3) && x.date <= today)) {
    const p = effective(a.date, pIdx, overrides), share = aboveZ2Share(a, m.hrp);
    if (share != null && share > 0.2 && (!p || ['easy', 'long', 'runwalk'].includes(p.kind)) && (a.moving_min || 0) >= 15)
      add(`hard:${a.id}`, 'facile_troppo_forte', `${a.date}: uscita facile con ${Math.round(share * 100)}% del tempo sopra Z2 (FC media ${a.avg_hr || '?'})`, { activity_id: String(a.id) });
  }
  const mon = mondayOf(today);
  let planMin = 0; for (let i = 0; i < 7; i++) { const p = effective(addDays(mon, i), pIdx, overrides); if (isPlannedRun(p)) planMin += runMinutes(p); }
  const doneMin = acts.filter((a) => isRun(a) && a.date >= mon && a.date <= today).reduce((t, a) => t + (a.moving_min || 0), 0);
  if (planMin > 0 && doneMin > planMin * 1.1) add(`volume:${mon}`, 'volume_oltre_piano', `Settimana a ${Math.round(doneMin)}' di corsa contro ${Math.round(planMin)}' pianificati (+${Math.round((doneMin / planMin - 1) * 100)}%)`);
  const ci = Object.values(checkins).filter((c) => c.date <= today && c.date >= addDays(today, -7)).sort((a, b) => a.date.localeCompare(b.date)).slice(-2);
  if (ci.length === 2 && ci.every((c) => (c.pain?.level || 0) >= 5)) add(`pain:${ci[1].date}`, 'fastidio_ripetuto', `Fastidio ≥5 in due check-in di fila (${ci.map((c) => `${c.pain.area || '?'} ${c.pain.level}/10`).join(', ')}): protocollo di sicurezza, niente sgridate`, { sicurezza: true });
  const tmr = addDays(today, 1), tr = tripOn(trips, tmr);
  if (tr && tr.type !== 'vacation' && !tr.facilities && !places[cityKey(tr.city || tr.title)]) add(`trip:${tr.key}`, 'trasferta_dotazioni_ignote', `Domani trasferta a ${tr.city || tr.title}: dotazioni dell'hotel ignote`, { citta: tr.city || tr.title });
  const wd = meteo?.days?.[tmr], wv = weatherVerdict(wd, settings.coldFeelsC ?? 5), pt = effective(tmr, pIdx, overrides);
  if (wv?.bad && pt && RUN_KINDS.includes(pt.kind)) add(`meteo:${tmr}`, 'meteo_avverso', `Domani a ${wd.city} alle ${wd.hour}:00: ${wv.motivi.join(', ')}. Sessione: ${pt.title} ${pt.min}'`, { consiglio_regole: wv.consiglio });
  for (const b of newBadges) add(`badge:${b.id}`, 'badge_sbloccato', `Badge sbloccato: ${b.nome}`);
  for (const k of skips.filter((x) => x.date >= addDays(today, -2))) add(`skip:${k.date}`, 'non_riesco', `${k.date}: ha toccato "Non riesco" su "${k.title}" e ha scelto: ${k.label}. Negli ultimi 28 giorni: ${skips.filter((x) => x.date >= addDays(today, -28)).length} volte`);
  for (const x of shoeKm(shoes, acts)) if (x.alert && !x.retired) add(`shoe:${x.id}:${Math.floor(x.km / 50)}`, 'scarpe_a_fine_vita', `${x.model}: ${Math.round(x.km)} km (soglia ${x.limit}). Suggerisci di ruotare o cambiare`);
  const td = testDue(tests, today, settings);
  if (td.da_pianificare) add(`test:${mondayOf(today)}`, 'test_da_pianificare', `${td.ultimo ? td.settimane_dall_ultimo + ' settimane dall\'ultimo test' : 'Nessun test ancora fatto'}: mettine uno nel piano al prossimo check-up`);
  return out;
}

// ---------- Area gara: checklist valigia predefinita (modificabile) ----------
export const PACK_LIST = [
  ['pettorale', 'Conferma iscrizione e documento per il ritiro pettorale'], ['scarpe', 'Scarpe da gara già rodate (almeno 50 km)'], ['calze', 'Calze provate nei lunghi'],
  ['gara', 'Completo da gara già usato in un lungo'], ['strati', 'Strati per il freddo: termica, guanti, fascia o berretto'], ['usa', 'Felpa vecchia da buttare alla partenza'],
  ['gel', 'Gel: gli stessi provati nei lunghi, più uno di scorta'], ['cintura', 'Cintura o tasche portagel'], ['orologio', 'Garmin e cavo di ricarica'],
  ['vaselina', 'Vaselina o crema antisfregamento, cerotti'], ['colazione', 'Colazione di gara portata da casa, se serve'], ['dopo', 'Cambio asciutto e caldo per il dopo gara'],
];
export const sessionLabel = (s) => (s ? `${s.title}${s.min ? ` ${s.min}'` : ''}` : '—');
export { fmtPace };

// ---------- Demo: dati di esempio per le sezioni di José ----------
export function demoExtras(d) {
  const today = d.serverToday, H = 3.6e6, now = Date.now();
  const test = (date, time_s, hr) => ({ id: 't' + date, date, type: '5k', dist_km: 5, time_s, passo_s: Math.round(time_s / 5), hr_avg: hr, hr_max: hr + 9, source: 'auto', previsione: predict(5, time_s), zone_passo: paceZones(5, time_s), nota_fc: null });
  const ctx = { pIdx: Object.fromEntries(d.plan.map((p) => [p.date, p])), overrides: {}, acts: d.activities, tripSet: new Map(), today };
  const lastMon = addDays(mondayOf(today), -7);
  d.feed.forEach((f) => { if (f.source === 'ai') f.source = 'claude'; });
  if (d.feed[1]) d.feed[1].detail = 'Passo medio 7:02/km, regolare: parziali tra 6:55 e 7:10.\nFC media 139 (Z2), massima 151. Tempo nelle zone: Z1 12%, Z2 72%, Z3 16%.\nDeriva cardiaca 4,1%: sotto il 5%, la resistenza aerobica tiene.\nPianificato: lungo facile 1h10 in Z2. Fatto: 1h12. In linea.\nCosa cambia: niente. Il prossimo lungo sale di 10\'.';
  return { ...d,
    chat: [
      { id: 'c1', ts: now - H * 30, from: 'jose', kind: 'scolding', text: 'Martedì: 40\' "facili" con il 31% del tempo sopra Z2. Non è facile, è medio. Così il lungo di domenica lo paghi. Giovedì stai sotto i 142 battiti, anche se ti sembra di camminare.' },
      { id: 'c2', ts: now - H * 27, from: 'luca', text: 'Hai ragione, ero in ritardo e ho tirato. Giovedì sono a Verona, non so se l\'hotel ha il tapis roulant.', answered: true },
      { id: 'c3', ts: now - H * 16, from: 'jose', kind: 'reply', replyTo: 'c2', text: 'Il ritardo non accorcia la corsa, la rovina. A Verona: chiedi alla reception se c\'è il tapis roulant e se la colazione apre prima delle 7. Senza tapis, forza B in camera e il fartlek lo fai venerdì a casa.', rating: 'up' },
      { id: 'c4', ts: now - H * 9, from: 'jose', kind: 'praise', text: 'Tre settimane piene, nessuna sessione saltata. Così si costruisce.' },
      { id: 'c5', ts: now - H * 1, from: 'luca', text: 'Sabato posso fare il lungo in collina?', answered: false },
    ],
    meteo: { ts: now, today, days: { [today]: { city: 'Milano', hour: 7, temp: 5, feels: 2, rain_prob: 10, rain_mm: 0, wind: 9, best: { hour: 13, feels: 9, rain_prob: 5 } }, [addDays(today, 1)]: { city: 'Milano', hour: 7, temp: 8, feels: 6, rain_prob: 20, rain_mm: 0, wind: 12, best: { hour: 7, feels: 6, rain_prob: 20 } } } },
    tests: [test(addDays(today, -52), 2010, 168), test(addDays(today, -10), 1905, 166)],
    shoes: { list: [{ id: 's1', model: 'Brooks Ghost 16', start: '2026-11-20', km0: 310, limit: 600, def: true }, { id: 's2', model: 'Saucony Ride 17', start: '2027-02-01', km0: 0, limit: 600, def: false }], assign: {} },
    reports: { [lastMon]: { week: lastMon, ts: now - H * 50, numeri: weekNumbers(lastMon, ctx), voto: 7, titolo: 'Settimana solida, un facile corso troppo forte', commento: 'Volume centrato e lungo fatto bene. Il voto non è 8 per martedì: un facile a ritmo medio non è un regalo che ti fai, è fatica che ti porti dietro.', bene: ['Lungo di domenica: deriva 4,1%, tutta Z2', 'Forza B fatta in hotel'], male: ['Martedì: 31% del tempo sopra Z2 su un\'uscita facile', 'Check-in saltato due giorni'], focus: 'Facili davvero facili: sotto i 142 battiti', focus_perche: 'La base aerobica si costruisce lì. Il ritmo arriva dopo.' } },
    skips: [], race: { hotel: '', notes: {}, pack: { scarpe: true } }, jose: { last: now - H * 3 }, voice: true,
  };
}
