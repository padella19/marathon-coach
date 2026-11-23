// ============================================================================
// Marathon Coach — motore condiviso (usato sia dal Worker sia dalla dashboard)
// Metriche di carico, zone FC, generatore piano, adattamento giornaliero,
// nutrizione, libreria forza, dati demo. Nessuna dipendenza esterna.
// ============================================================================

// ---------- Date (sempre stringhe 'YYYY-MM-DD', fuso Europe/Rome) ----------
export const TZ = 'Europe/Rome';
export const todayISO = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
export const D = (s) => new Date(s + 'T00:00:00Z');
export const iso = (d) => d.toISOString().slice(0, 10);
export const addDays = (s, n) => { const d = D(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
export const dow = (s) => D(s).getUTCDay(); // 0 = domenica
export const mondayOf = (s) => addDays(s, -((dow(s) + 6) % 7));
export const diffDays = (a, b) => Math.round((D(b) - D(a)) / 864e5);
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const DOW_IT = ['Dom', 'Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab'];
export const DOW_IT_LONG = ['Domenica', 'Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì', 'Sabato'];
const MONTHS_IT = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
export const fmtDate = (s) => { const d = D(s); return `${d.getUTCDate()} ${MONTHS_IT[d.getUTCMonth()]}`; };
const r5 = (v) => (v <= 0 ? 0 : Math.max(5, Math.round(v / 5) * 5));

export const fmtPace = (sec) => {
  if (!sec || !isFinite(sec)) return '—';
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}/km`;
};
export const fmtMin = (min) => {
  if (!min) return '—';
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return h ? `${h}h${String(m).padStart(2, '0')}` : `${m}'`;
};

// ---------- Impostazioni di default ----------
export const DEFAULT_SETTINGS = {
  name: 'Luca',
  age: null,
  weightKg: null,
  hrMax: null,
  hrRest: 60,
  longRunDay: 0,           // 0 = domenica, 6 = sabato
  tripDays: [2, 3, 4],     // trasferte tipiche mar-mer-gio
  offDates: ['2027-01-01'],
  planStart: '2026-12-10',
  raceDate: '2027-10-31',
  raceName: 'Maratona di Francoforte',
  icalUrls: '',            // URL iCal segreti dei calendari trasferte (uno per riga)
  planSource: 'generated',
  runsPerWeek: 3,          // decide il coach (3-5)
  homeCity: 'Milano',      // meteo quando non sei in trasferta
  runHour: 7,              // fascia oraria preferita per correre (meteo)
  coldFeelsC: 5,           // soglia di attenzione del freddo percepito (°C)
  runMorning: '07:00',     // orari delle due attività programmate di José
  runEvening: '21:00',
};

// ---------- Attività ----------
const RUN_TYPES = new Set(['Run', 'TrailRun', 'VirtualRun']);
export const isRun = (a) => RUN_TYPES.has(a.type);

// ---------- Frequenza cardiaca ----------
// Limiti della preparazione: sotto le 36 settimane le fasi del piano non stanno in piedi
export const PLAN_MIN_WEEKS = 36, PLAN_MAX_WEEKS = 70;
export const planWeeks = (planStart, raceDate) => Math.floor(diffDays(planStart, raceDate) / 7);

export function hrProfile(s, acts = []) {
  // Zone della corsa lette da intervals.icu (le stesse dell'orologio): hanno la precedenza
  const iz = s.hrZones;
  if (iz && Array.isArray(iz.zones) && iz.zones.length === 5) return { max: iz.max || iz.zones[4].hi, rest: s.hrRest || 60, src: 'intervals.icu', zones: iz.zones };
  let max = s.hrMax, src = 'impostata';
  const obs = acts.reduce((m, a) => Math.max(m, a.max_hr || 0), 0);
  if (!max && s.age) { max = Math.round(208 - 0.7 * s.age); src = 'stimata da età'; }
  if (!max && obs >= 165) { max = obs; src = 'max registrata'; }
  if (!max) { max = 185; src = 'provvisoria'; }
  if (src !== 'impostata' && obs > max) { max = obs; src = 'max registrata'; }
  const rest = s.hrRest || 60, hrr = max - rest;
  const pct = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
  const zones = [1, 2, 3, 4, 5].map((z) => ({ z, lo: Math.round(rest + hrr * pct[z - 1]), hi: Math.round(rest + hrr * pct[z]) }));
  return { max, rest, src, zones };
}
export const zoneOf = (hr, hrp) => {
  if (!hr) return 0;
  for (const z of hrp.zones) if (hr < z.hi) return z.z;
  return 5;
};
export const ZONE_NAMES = ['Z1 Recupero', 'Z2 Aerobico', 'Z3 Medio', 'Z4 Soglia', 'Z5 Massimale'];

export function estimateRPE(hr, hrp) {
  if (!hr) return null;
  const p = ((hr - hrp.rest) / (hrp.max - hrp.rest)) * 100;
  return clamp(Math.round((p - 40) / 6.5), 1, 10);
}
export function rpeOf(a, hrp) {
  if (a.rpe) return { v: a.rpe, src: a.rpe_src || 'manuale', est: false };
  const e = estimateRPE(a.avg_hr, hrp);
  if (e) return { v: e, src: 'stima FC', est: true };
  return { v: isRun(a) ? 4 : 3, src: 'default', est: true };
}
// ---------- Forza, mobilità e attività senza orologio ----------
// La forza pesa nel carico, ma meno della corsa (niente impatto): forza ×0,5, mobilità ×0,25
export const STRENGTH_LOAD_FACTOR = 0.5, MOBILITY_LOAD_FACTOR = 0.25;
const STRENGTH_TYPES = new Set(['WeightTraining', 'Workout', 'Crossfit', 'HighIntensityIntervalTraining', 'StrengthTraining']);
const MOBILITY_TYPES = new Set(['Yoga', 'Pilates', 'Mobility', 'Stretching']);
export const isStrengthAct = (a) => STRENGTH_TYPES.has(a?.type);
export const isMobilityAct = (a) => MOBILITY_TYPES.has(a?.type);
export const routineKind = (r) => (r === 'D' || r === 'E' ? 'mobility' : 'strength');

// Carico di sessione (Foster sRPE): minuti × RPE (ridotto per forza e mobilità)
export const loadOf = (a, hrp) => {
  const f = isStrengthAct(a) ? STRENGTH_LOAD_FACTOR : isMobilityAct(a) ? MOBILITY_LOAD_FACTOR : 1;
  return Math.round((a.moving_min || 0) * rpeOf(a, hrp).v * f);
};

// Esercizi segnati a mano con "Fatto" → attività equivalenti (se nello stesso giorno c'è già
// un'attività dello stesso tipo arrivata dal Garmin, vale quella e il "Fatto" non si somma)
export function logActivities(logs = [], acts = []) {
  const out = [];
  for (const l of logs) {
    if (!l?.date) continue;
    const mob = l.kind === 'mobility';
    if (acts.some((a) => a.date === l.date && (mob ? isMobilityAct(a) : isStrengthAct(a)))) continue;
    out.push({ id: `log-${l.date}-${l.kind}`, src: 'log', date: l.date, start: l.date + 'T12:00:00', type: mob ? 'Mobility' : 'WeightTraining', name: l.routine ? `Routine ${l.routine} · ${STRENGTH[l.routine]?.name || ''}`.trim() : mob ? 'Mobilità' : 'Forza', moving_min: +l.min || 0, dist_km: 0, rpe: l.rpe || null, rpe_src: l.rpe ? 'manuale' : null, routine: l.routine || null });
  }
  return out;
}
// Cosa chiede una sessione in fatto di forza/mobilità (sessione di forza o routine dopo la corsa)
export function strengthNeed(sess) {
  if (!sess || sess.kind === 'pause') return null;
  if (sess.kind === 'strength') { const r = sess.strength || 'B'; return { routine: r, kind: routineKind(r), optional: !!sess.optional, main: true }; }
  if (sess.strength) return { routine: sess.strength, kind: routineKind(sess.strength), optional: sess.kind === 'rest' || sess.strength === 'D' || !!sess.optional, main: false };
  return null;
}
export const strengthDoneOn = (date, kind, acts) => acts.some((a) => a.date === date && (kind === 'mobility' ? isMobilityAct(a) || isStrengthAct(a) : isStrengthAct(a)));

// Istogramma FC a bucket da 3 bpm → {centro_bucket: secondi}
export const hrBucket = (hr) => Math.floor(hr / 3) * 3 + 1;
export function histFromStreams(time, hr) {
  const h = {};
  for (let i = 1; i < time.length; i++) {
    const dt = time[i] - time[i - 1];
    if (dt <= 0 || dt > 10 || !hr[i - 1]) continue;
    const b = hrBucket(hr[i - 1]);
    h[b] = (h[b] || 0) + dt;
  }
  return h;
}
// Deriva cardiaca (Pa:HR) — % di peggioramento dell'efficienza tra 1ª e 2ª metà
export function decouplingFromStreams(time, hr, vel) {
  if (!time || !hr || !vel || time.length < 60) return null;
  const total = time[time.length - 1];
  if (total < 40 * 60) return null;
  const start = 10 * 60, mid = start + (total - start) / 2;
  const acc = [{ v: 0, h: 0, n: 0 }, { v: 0, h: 0, n: 0 }];
  for (let i = 0; i < time.length; i++) {
    if (time[i] < start || !hr[i] || !vel[i] || vel[i] < 0.5) continue;
    const k = time[i] < mid ? 0 : 1;
    acc[k].v += vel[i]; acc[k].h += hr[i]; acc[k].n++;
  }
  if (acc[0].n < 30 || acc[1].n < 30) return null;
  const ef1 = acc[0].v / acc[0].h, ef2 = acc[1].v / acc[1].h;
  return Math.round(((ef1 - ef2) / ef1) * 1000) / 10;
}
export function zoneSeconds(a, hrp) {
  const z = [0, 0, 0, 0, 0];
  // Tempo nelle zone calcolato da intervals.icu: vale solo se anche le zone sono le sue
  if (Array.isArray(a.zone_secs) && a.zone_secs.length === 5 && hrp?.src === 'intervals.icu') return a.zone_secs.slice();
  if (a.hist) {
    for (const [b, sec] of Object.entries(a.hist)) z[Math.max(1, zoneOf(+b, hrp)) - 1] += sec;
  } else if (a.avg_hr) {
    z[Math.max(1, zoneOf(a.avg_hr, hrp)) - 1] += (a.moving_min || 0) * 60;
  }
  return z;
}

// ---------- Metriche di carico ----------
export function acwrBand(v, calibrating) {
  if (calibrating || v == null) return { k: 'cal', label: 'In calibrazione', tone: 'muted' };
  if (v < 0.8) return { k: 'low', label: 'Sottocarico', tone: 'info' };
  if (v <= 1.3) return { k: 'ok', label: 'Zona ottimale', tone: 'good' };
  if (v <= 1.5) return { k: 'warn', label: 'Attenzione', tone: 'warn' };
  return { k: 'high', label: 'Rischio sovraccarico', tone: 'bad' };
}

export function computeMetrics(acts, s, today) {
  const hrp = hrProfile(s, acts);
  const sorted = acts.filter((a) => a.date <= today).sort((a, b) => (a.start || a.date).localeCompare(b.start || b.date));
  const first = sorted.length ? sorted[0].date : today;
  const span = diffDays(first, today);
  const start = addDays(today, -clamp(span, 56, 420));
  const byDay = {};
  for (const a of sorted) (byDay[a.date] ||= []).push(a);

  // EWMA (Williams 2017): acuto 7g, cronico 28g · ATL/CTL 7/42 per la "forma"
  const la = 2 / (7 + 1), lc = 2 / (28 + 1), ka = 1 - Math.exp(-1 / 7), kc = 1 - Math.exp(-1 / 42);
  let ea = 0, ec = 0, atl = 0, ctl = 0;
  const series = [];
  for (let d = start; d <= today; d = addDays(d, 1)) {
    const L = (byDay[d] || []).reduce((t, a) => t + loadOf(a, hrp), 0);
    ea = L * la + (1 - la) * ea;
    ec = L * lc + (1 - lc) * ec;
    atl += (L - atl) * ka;
    ctl += (L - ctl) * kc;
    series.push({ date: d, load: L, acute: ea, chronic: ec, acwr: ec > 1 ? ea / ec : null, atl, ctl, form: ctl > 1 ? ((ctl - atl) / ctl) * 100 : null });
  }
  const last = series[series.length - 1];
  const calibrating = sorted.length < 6 || span < 21;

  // Monotonia e strain (Foster) sugli ultimi 7 giorni
  const l7 = series.slice(-7).map((x) => x.load);
  const mean = l7.reduce((a, b) => a + b, 0) / 7;
  const sd = Math.sqrt(l7.reduce((a, b) => a + (b - mean) ** 2, 0) / 7);
  const monotony = mean === 0 ? 0 : sd === 0 ? 4 : Math.min(4, mean / sd);
  const strain = Math.round(mean * 7 * monotony);

  // Aggregati settimanali
  const weeksMap = {};
  const curMon = mondayOf(today);
  for (let w = mondayOf(first); w <= curMon; w = addDays(w, 7))
    weeksMap[w] = { week: w, km: 0, runs: 0, min: 0, load: 0, longKm: 0, longMin: 0, z: [0, 0, 0, 0, 0] };
  for (const a of sorted) {
    const W = weeksMap[mondayOf(a.date)];
    if (!W) continue;
    W.load += loadOf(a, hrp);
    W.min += a.moving_min || 0;
    if (isRun(a)) {
      W.km += a.dist_km || 0; W.runs++;
      W.longKm = Math.max(W.longKm, a.dist_km || 0);
      W.longMin = Math.max(W.longMin, a.moving_min || 0);
      zoneSeconds(a, hrp).forEach((v, i) => (W.z[i] += v));
    }
  }
  const weeks = Object.values(weeksMap).sort((a, b) => a.week.localeCompare(b.week));
  const week = weeksMap[curMon] || { km: 0, runs: 0, min: 0, load: 0, z: [0, 0, 0, 0, 0] };
  const prevWeek = weeksMap[addDays(curMon, -7)] || null;
  const kmDelta = prevWeek && prevWeek.km > 0 ? ((week.km - prevWeek.km) / prevWeek.km) * 100 : null;

  // Polarizzazione 28 giorni
  const runs28 = sorted.filter((a) => isRun(a) && a.date > addDays(today, -28));
  const z28 = [0, 0, 0, 0, 0];
  runs28.forEach((a) => zoneSeconds(a, hrp).forEach((v, i) => (z28[i] += v)));
  const zt = z28.reduce((a, b) => a + b, 0);
  const polar = zt ? ((z28[0] + z28[1]) / zt) * 100 : null;

  // Efficienza aerobica (EF = metri/min per battito) sulle corse facili
  const efSeries = sorted
    .filter((a) => isRun(a) && a.avg_hr && a.speed && a.moving_min >= 20 && zoneOf(a.avg_hr, hrp) <= 2)
    .map((a) => ({ date: a.date, ef: Math.round(((a.speed * 60) / a.avg_hr) * 1000) / 1000 }));
  const avg = (arr) => (arr.length ? arr.reduce((t, x) => t + x.ef, 0) / arr.length : null);
  const efNow = avg(efSeries.filter((x) => x.date > addDays(today, -28)));
  const efPrev = avg(efSeries.filter((x) => x.date <= addDays(today, -28) && x.date > addDays(today, -56)));
  const efTrend = efNow && efPrev ? ((efNow - efPrev) / efPrev) * 100 : null;

  const longest28 = runs28.reduce((m, a) => (a.moving_min > (m?.moving_min || 0) ? a : m), null);
  const easyRuns = sorted.filter((a) => isRun(a) && a.pace_s && a.avg_hr && zoneOf(a.avg_hr, hrp) <= 2).slice(-8);
  const easyPace = easyRuns.length ? easyRuns.reduce((t, a) => t + a.pace_s, 0) / easyRuns.length : 420;

  return {
    hrp, series, weeks, week, prevWeek, kmDelta, calibrating,
    acwr: last?.acwr ?? null, acute: last?.acute || 0, chronic: last?.chronic || 0,
    atl: last?.atl || 0, ctl: last?.ctl || 0, form: last?.form ?? null,
    monotony: Math.round(monotony * 100) / 100, strain,
    polar, z28, efSeries, efNow, efTrend, longest28, easyPace,
    scatter: sorted.filter((a) => isRun(a) && a.pace_s && a.avg_hr).map((a) => ({ x: a.pace_s, y: a.avg_hr, date: a.date, name: a.name })),
    acts: sorted,
  };
}

// ---------- Fasi del piano ----------
export const PHASE_FOCUS = {
  pre: 'Prima del via: scarpe giuste, Garmin collegato a Intervals.icu, 2-3 camminate veloci a settimana. Nessuna fretta.',
  cond: 'Abituare tendini, ossa e articolazioni: alternanza corsa/cammino fino a 30\' continui. Il passo non conta, conta la costanza.',
  base: 'Motore aerobico: tanto volume facile in Z2, allunghi per la tecnica e un lavoro "a sensazione" a settimana.',
  build: 'Si costruisce: lungo verso le 2h15, progressivi, salite e tempo run. Forza 2 volte a settimana.',
  spec: 'Specifico maratona: lunghi fino a 3h, blocchi a ritmo gara, prove di integrazione identiche alla gara.',
  taper: 'Scarico: volume giù, qualche richiamo a ritmo gara, sonno e carboidrati. La fatica che togli ora la ritrovi il 31.',
  post: 'Recupero post-gara: 7-10 giorni di riposo attivo, poi si decide il prossimo obiettivo.',
};

export function planFrame(s) {
  const w0 = mondayOf(s.planStart);
  const total = Math.round(diffDays(w0, mondayOf(s.raceDate)) / 7);
  const ph = [
    { id: 'cond', name: 'Condizionamento', from: 0, to: 5 },
    { id: 'base', name: 'Base aerobica', from: 6, to: total - 29 },
    { id: 'build', name: 'Costruzione', from: total - 28, to: total - 15 },
    { id: 'spec', name: 'Specifico maratona', from: total - 14, to: total - 3 },
    { id: 'taper', name: 'Scarico', from: total - 2, to: total },
  ];
  return { w0, total, ph };
}
function phaseForWeek(w, f) {
  const p = f.ph.find((x) => w >= x.from && w <= x.to) || f.ph[0];
  const local = w - p.from, len = p.to - p.from + 1;
  const rec = ['base', 'build', 'spec'].includes(p.id) && local % 4 === 3 && !(p.id === 'spec' && local === len - 1);
  return { ...p, local, len, rec };
}
export function phaseAt(date, s) {
  const f = planFrame(s);
  if (date < s.planStart) return { id: 'pre', name: 'Pre-partenza', week: 0, total: f.total + 1, focus: PHASE_FOCUS.pre, rec: false };
  if (date > s.raceDate) return { id: 'post', name: 'Post-gara', week: f.total + 1, total: f.total + 1, focus: PHASE_FOCUS.post, rec: false };
  const w = Math.floor(diffDays(f.w0, date) / 7);
  const p = phaseForWeek(w, f);
  return { ...p, week: w + 1, total: f.total + 1, focus: PHASE_FOCUS[p.id] };
}

// ---------- Libreria sessioni (anti-noia) ----------
const EASY = [
  { t: 'Corsa facile Z2', d: 'Ritmo conversazione. Se la FC esce da Z2, rallenta o cammina 30".' },
  { t: 'Corsa a sensazione nel verde', d: 'Parco o sterrato, niente occhi sul passo: solo respiro e FC.' },
  { t: 'Rigenerante Z1', d: 'Più lenta di quanto pensi. Obiettivo: finire più fresco di come hai iniziato.' },
  { t: 'Facile + allunghi', d: 'Corsa facile, poi 6×20" allunghi in progressione (RPE 7) con 1\' di cammino.' },
];
const Q = {
  base: [
    { t: 'Fartlek a sensazione', d: '10\' facili + 8×(1\' brillante RPE 6-7 / 2\' facile) + 5\' sciolti.' },
    { t: 'Progressivo dolce', d: 'Parti in Z1, ogni 10\' alza un filo. Ultimi 5\' a RPE 6.' },
    { t: 'Fartlek piramidale', d: '10\' facili + 1-2-3-2-1\' brillanti (RPE 6-7), recupero pari al tempo + 5\'.' },
    { t: 'Collinare a sforzo costante', d: 'Percorso ondulato: in salita accorci il passo, non forzi. Tapis roulant: 6×2\' a pendenza 4%.' },
  ],
  build: [
    { t: 'Salite brevi', d: '15\' facili + 8×45" in salita a RPE 7, recupero tornando giù + 10\'. Tapis roulant: 8×45" al 6-7%.' },
    { t: 'Tempo run spezzato', d: '15\' facili + 3×8\' a RPE 7 (rec 2\' facili) + 10\'.' },
    { t: 'Fartlek 30/30', d: '10\' facili + 3 serie da 8×(30" svelto / 30" facile), 3\' tra le serie + 10\'. Perfetto su tapis roulant.' },
    { t: 'Progressivo a 3 step', d: '15\' Z2 → 15\' Z3 → 10\' a RPE 7 + 5\' defaticamento.' },
    { t: 'Fartlek libero', d: 'Cambi di ritmo a piacere sul terreno: lampioni, curve, cavalcavia. 6-10 cambi da 30"-2\'.' },
  ],
  spec: [
    { t: 'Blocchi a ritmo gara', d: '15\' facili + 3×12\' a ritmo maratona (RPE 5-6), rec 3\' facili + 10\'.' },
    { t: 'Medio con finale a ritmo gara', d: 'Corsa continua, ultimi 20-25\' a ritmo maratona.' },
    { t: 'Tempo + ritmo gara', d: '15\' facili + 2×10\' a RPE 7 + 15\' a ritmo gara + 5\'.' },
    { t: 'Fartlek misto', d: '15\' + 6×(3\' RPE 7 / 2\' ritmo gara) + 10\'.' },
  ],
  taper: [
    { t: 'Richiamo ritmo gara', d: '10\' facili + 3×5\' a ritmo maratona (rec 2\') + 10\'.' },
    { t: 'Facile + allunghi', d: 'Corsa facile + 4×20" allunghi sciolti.' },
    { t: 'Attivazione pre-gara', d: '15-20\' facilissimi + 3×20" allunghi. Gambe sveglie, niente di più.' },
  ],
};
const LONG = {
  base: [
    { t: 'Lungo facile', d: 'Tutto in Z2. Concesso 1\' di cammino ogni 20\' se la FC deriva.' },
    { t: 'Lungo su percorso nuovo', d: 'Cambia giro: argine, parco, sterrato. Stesso sforzo, testa libera.' },
  ],
  build: [
    { t: 'Lungo facile', d: 'Z2 costante. Acqua ogni 20\', primo gel di prova dopo 60\'.' },
    { t: 'Lungo progressivo', d: 'Z2, ultimi 15\' in Z3 senza superare RPE 6.' },
    { t: 'Lungo collinare', d: 'Percorso ondulato a sforzo costante. Gel test dopo 60\'.' },
  ],
  spec: [
    { t: 'Lungo con finale a ritmo gara', d: 'Z2, ultimi 25-30\' a ritmo maratona. Integrazione come in gara.' },
    { t: 'Lungo + prova gara', d: 'Tutto Z2. Colazione, gel, borraccia: esattamente come il giorno della maratona.' },
    { t: 'Lungo a blocchi', d: 'Z2 con 3×15\' a ritmo gara inseriti dopo i primi 45\'.' },
  ],
};
const RW = [[1, 2, 8], [2, 1, 8], [4, 1, 6], [3, 1, 6], [7, 1, 4], [12, 1, 2]];
const SPEC_LONG = [130, 140, 150, 110, 155, 165, 170, 120, 175, 180, 140, 170];
const pick = (arr, i) => arr[((i % arr.length) + arr.length) % arr.length];

export const STRENGTH = {
  A: { name: 'Core in camera', min: 15, ex: [
    ['Plank', '3×30-45"', 'Glutei stretti, bacino neutro'],
    ['Side plank', '3×20-30" per lato', 'Anca alta, spalla sopra il gomito'],
    ['Dead bug', '3×10', 'Lombare incollata al pavimento'],
    ['Bird dog', '3×10 per lato', 'Lento, bacino fermo'],
    ['Ponte glutei', '3×12', 'Spingi coi talloni, 2" in alto'],
  ] },
  B: { name: 'Gambe & stabilità', min: 20, ex: [
    ['Squat a corpo libero', '3×15', 'Ginocchia in linea con i piedi'],
    ['Affondo indietro', '3×10 per gamba', 'Busto dritto'],
    ['Step-up su sedia/letto', '3×10 per gamba', 'Spingi con la gamba sopra'],
    ['Stacco monopodalico', '3×8 per gamba', 'Schiena lunga, anca indietro'],
    ['Calf raise monopodalico', '3×15', 'Discesa lenta in 3"'],
  ] },
  C: { name: 'Piede, caviglia & anca', min: 12, ex: [
    ['Equilibrio su un piede', '3×30"', 'Occhi chiusi quando è facile'],
    ['Calf raise eccentrico', '3×12', 'Sali su due, scendi su uno'],
    ['Clamshell', '3×15 per lato', 'Bacino fermo'],
    ['Abduzione da sdraiato', '3×12 per lato', 'Punta del piede avanti'],
    ['Tallone-punta', '2×20 passi', 'Postura alta'],
  ] },
  D: { name: 'Mobilità post-viaggio', min: 10, ex: [
    ['Flessori anca in affondo', '2×45" per lato', 'Bacino in retroversione'],
    ['Piriforme (figura 4)', '2×45" per lato', 'Respira lento'],
    ['Cat-cow', '10 ripetizioni', 'Colonna segmento per segmento'],
    ['Rotazioni toraciche', '8 per lato', 'Da quadrupedia'],
    ['Polpacci al muro', '2×45" per lato', 'Tallone giù'],
  ] },
  E: { name: 'Mobilità dopo la corsa', min: 5, ex: [
  ['Polpacci al muro', '30" per lato', 'Tallone giù, ginocchio teso poi piegato'],
  ['Flessori anca in affondo', '30" per lato', 'Bacino in avanti, busto alto'],
  ['Femorali da in piedi', '30" per lato', 'Schiena lunga, niente molleggi'],
  ['Glutei (figura 4 in piedi)', '30" per lato', 'Appoggiati al muro se serve'],
  ['Oscillazioni delle gambe', '10 per lato', 'Avanti-indietro, sciolte'],
] },
};

function S(date, kind, title, min, rpe, zone, desc, extra = {}) {
  return { date, dow: dow(date), kind, title, min, rpe, zone, desc, hotel: true, strength: null, optional: false, ...extra };
}
function rwSession(date, L, long) {
  const [r, c, n] = RW[Math.min(L, 5)];
  if (long && L >= 5) return S(date, 'runwalk', 'Primi 30\' continui', 40, '3-4', 'Z1-Z2', '5\' cammino + 30\' corsa continua facilissima + 5\' cammino. Primo traguardo vero.', { hotel: false, steps: [{ type: 'warmup', min: 5, zone: 'Z1', note: 'Cammino' }, { type: 'run', min: 30, zone: 'Z2' }, { type: 'cooldown', min: 5, zone: 'Z1', note: 'Cammino' }] });
  const reps = long ? n + 1 : n;
  return S(date, 'runwalk', `Corsa/cammino ${r}'/${c}'`, 10 + reps * (r + c), '3-4', 'Z1-Z2',
    `5' camminata svelta + ${reps}×(${r}' corsa facile / ${c}' cammino) + 5' camminata. Devi poter parlare.`,
    { steps: [{ type: 'warmup', min: 5, zone: 'Z1', note: 'Cammino svelto' }, { type: 'repeat', reps, steps: [{ type: 'run', min: r, zone: 'Z2' }, { type: 'walk', min: c, zone: 'Z1' }] }, { type: 'cooldown', min: 5, zone: 'Z1', note: 'Cammino' }] });
}
function durations(P) {
  const lin = (a, b) => a + (b - a) * (P.len > 1 ? P.local / (P.len - 1) : 0);
  let easy = 0, q = 0, long = 0;
  if (P.id === 'base') { easy = lin(30, 45); q = lin(35, 50); long = lin(50, 90); }
  if (P.id === 'build') { easy = lin(40, 55); q = lin(45, 60); long = lin(90, 135); }
  if (P.id === 'spec') { easy = lin(45, 55); q = lin(55, 70); long = SPEC_LONG[P.local] ?? 150; }
  if (P.id === 'taper') { easy = [45, 35, 25][P.local] ?? 25; q = [45, 40, 30][P.local] ?? 30; long = [120, 85, 0][P.local] ?? 0; }
  const f = P.rec ? 0.75 : 1;
  return { easy: r5(easy * f), q: r5(q * f), long: P.id === 'spec' ? long : r5(long * f) };
}
const ROLE = { 1: 'mon', 2: 'tue', 3: 'wed', 4: 'thu', 5: 'fri', 6: 'sat', 0: 'sun' };

function buildDay(date, w, P, s) {
  let role = ROLE[dow(date)];
  if (s.longRunDay === 6) { if (role === 'sat') role = 'sun'; else if (role === 'sun') role = 'sat'; }
  const M = durations(P), id = P.id;
  if (date === s.raceDate) return S(date, 'race', s.raceName, 0, '5-6', 'Z2-Z3', 'Primi 10 km che sembrano troppo facili. Integrazione ogni 30-40\', acqua a ogni ristoro.', { hotel: false });
  if ((s.offDates || []).includes(date)) return S(date, 'rest', 'Giorno off', 0, '-', '-', 'Riposo totale.');
  const easy = (min, i, extra) => { const e = pick(EASY, i); return S(date, 'easy', e.t, min, '3-4', 'Z1-Z2', e.d, { strides: e.t.includes('allunghi'), ...extra }); };

  switch (role) {
    case 'mon':
      return S(date, 'rest', 'Riposo', 0, '-', '-', 'Recupero. Opzionale: 10\' di mobilità (routine D).', { strength: 'D' });
    case 'tue':
      if (id === 'cond') return { ...rwSession(date, P.local, false), strength: 'A' };
      return easy(M.easy, w, { strength: 'A' });
    case 'wed':
      if (id === 'taper') return S(date, 'rest', 'Riposo', 0, '-', '-', 'Scarico: riposo vero. Cammina e idratati.');
      if (id === 'spec' && !P.rec) return easy(30, w + 2, { strength: 'C', optional: true });
      return S(date, 'strength', STRENGTH.B.name, 20, '5-6', '-', 'Routine B a corpo libero in camera: 2-3 giri.', { strength: 'B' });
    case 'thu': {
      if (id === 'cond') return rwSession(date, P.local, false);
      if (P.rec) return easy(M.easy, w + 3, { strides: true, title: 'Facile + allunghi' });
      const q = pick(Q[id], w);
      return S(date, 'quality', q.t, M.q, id === 'spec' ? '5-7' : '6-7', 'Z2-Z4', q.d, { strength: id === 'build' ? 'C' : null });
    }
    case 'fri':
      if ((s.runsPerWeek || 4) >= 5 && id !== 'cond' && id !== 'taper') return easy(Math.max(30, M.easy - 10), w + 1);
      if ((id === 'build' || id === 'spec') && !P.rec && (s.runsPerWeek || 4) >= 4) return easy(30, w + 1, { optional: true });
      return S(date, 'rest', 'Riposo', 0, '-', '-', 'Gambe ferme in vista del weekend.');
    case 'sat':
      if ((s.runsPerWeek || 4) <= 3 && id !== 'cond' && id !== 'taper') return S(date, 'rest', 'Riposo attivo', 0, '-', '-', 'Camminata o routine C (piede-caviglia), niente corsa: oggi le corse della settimana sono 3.', { strength: 'C', optional: true });
      if (id === 'cond') return S(date, 'easy', 'Camminata svelta + piede-caviglia', 35, '2-3', 'Z1', '35-40\' di camminata svelta, poi routine C.', { strength: 'C', optional: true, walk: true, steps: [{ type: 'walk', min: 35, zone: 'Z1', note: 'Camminata svelta' }] });
      if (id === 'taper') return P.local === 2
        ? S(date, 'easy', 'Attivazione pre-gara', 20, '3', 'Z1-Z2', '15-20\' facilissimi + 3×20" allunghi.', { hotel: true })
        : easy(M.easy, w, { strides: true });
      if (id === 'spec') return easy(40, w + 1);
      return easy(M.easy, w + 3, { strides: true, title: 'Facile + allunghi', desc: 'Corsa facile, poi 6×20" allunghi in progressione (RPE 7) con 1\' di cammino.' });
    case 'sun': {
      if (id === 'cond') return rwSession(date, P.local, true);
      if (id === 'taper') return S(date, 'long', P.local === 0 ? 'Ultimo lungo' : 'Lungo di richiamo', M.long, '3-4', 'Z2', 'Facile, con 10\' a ritmo gara a metà. Integrazione come in gara.', { hotel: false });
      const L = P.rec ? { t: 'Lungo facile (scarico)', d: 'Settimana di recupero: tutto Z2, niente variazioni.' } : pick(LONG[id], Math.floor(w / 1));
      return S(date, 'long', L.t, M.long, id === 'spec' ? '4-6' : '3-5', 'Z2', L.d, { hotel: false });
    }
  }
}

export function generatePlan(s) {
  const f = planFrame(s), out = [];
  for (let w = 0; w <= f.total; w++) {
    const P = phaseForWeek(w, f);
    for (let d = 0; d < 7; d++) {
      const date = addDays(f.w0, w * 7 + d);
      if (date < s.planStart || date > s.raceDate) continue;
      const sess = buildDay(date, w, P, s);
      sess.phase = P.id; sess.week = w + 1;
      if (!sess.steps) { const stp = stepsFor(sess); if (stp) sess.steps = stp; }
      if (sess.steps && Math.abs(stepsMinutes(sess.steps) - sess.min) > 2) Object.assign(sess, scaleSteps(sess));
      out.push(sess);
    }
  }
  return out;
}

// ---------- Trasferte e vacanze ----------
export const isVacationTitle = (t) => /vacanz|ferie|holiday|vacation/i.test(String(t || ''));
export const tripKey = (t) => `${t.start}|${String(t.city || t.title || '').toLowerCase().trim()}`;
// Tutte le trasferte (manuali + calendario), SEMPRE in ordine di data e senza doppioni
// (stesso giorno, stessa città: es. lo stesso evento presente in due calendari)
export function allTrips(trips) {
  const seen = new Set(), out = [];
  const list = [...(trips?.manual || []).map((t) => ({ ...t, source: 'manual' })), ...(trips?.ical || [])].filter((t) => t && t.start);
  for (const t of list) {
    const key = tripKey(t), oldKey = t.title ? `${t.start}|${String(t.title).toLowerCase().trim()}` : key;
    const dup = `${t.start}|${t.end || t.start}|${placeKey(t.city || t.title)}`;
    if (seen.has(dup)) continue;
    seen.add(dup);
    out.push({ ...t, type: t.type || (isVacationTitle(t.title) ? 'vacation' : 'work'), key,
      facilities: t.facilities || trips?.facilities?.[key]?.f || trips?.facilities?.[oldKey]?.f || placeFacilities(trips?.places?.[placeKey(t.city || t.title)]) || null });
  }
  return out.sort((a, b) => a.start.localeCompare(b.start) || (a.end || a.start).localeCompare(b.end || b.start));
}
// Nome da mostrare: la città; il titolo del calendario solo come dettaglio se aggiunge qualcosa
export const tripName = (t) => (t && (t.city || t.title)) || 'Trasferta';
// Dettaglio: la sede (prima parte del campo Luogo), altrimenti il titolo dell'evento
export const tripDetail = (t) => {
  if (!t || !t.city) return '';
  const loc = String(t.location || '').split(/[,\n]/)[0].trim();
  const d = loc && placeKey(loc) !== placeKey(t.city) ? loc : t.title && placeKey(t.title) !== placeKey(t.city) ? t.title : '';
  return d;
};

// ---------- Città di una trasferta dal calendario ----------
// Candidati da provare con la geocodifica, nell'ordine: città nell'indirizzo (CAP + città),
// parti del campo Luogo, poi pezzi del titolo ("My English School Firenze Campo di Marte" → "Firenze").
const TRIP_STOP = new Set(('my english school myes scuola scuole sede sedi visita visite trasferta trasferte meeting monday tuesday wednesday thursday friday ' +
  'call riunione riunioni incontro incontri evento training formazione workshop ufficio office hotel center centro master direzione area manager ' +
  'vacanza vacanze ferie holiday holidays vacation viaggio con a ad al alla allo ai agli alle da dal dalla di del della dello dei degli delle in nel nella presso the of at and e per su tra fra').split(' '));
const STREET = /^(via|viale|v\.le|piazza|p\.za|p\.zza|piazzale|corso|c\.so|largo|strada|vicolo|lungarno|lungomare|borgo|località|loc\.)\b/i;
export function tripPlaceCandidates(title = '', location = '') {
  const out = [], add = (s) => { s = String(s || '').replace(/\s+/g, ' ').trim(); if (s.length >= 2 && !out.some((x) => placeKey(x) === placeKey(s))) out.push(s); };
  const loc = String(location || '');
  if (loc) {
    for (const m of loc.matchAll(/\b\d{5}\s+([A-Za-zÀ-ÿ' .-]+?)(?:\s+\(?[A-Z]{2}\)?)?\s*(?:,|$)/g)) add(m[1]);
    for (let p of loc.split(/[,\n]/)) {
      p = p.trim().replace(/\s+\(?[A-Z]{2}\)?$/, '');
      if (!p || /\d/.test(p) || STREET.test(p) || /^(italia|italy|svizzera|switzerland|schweiz|españa|spain)$/i.test(p)) continue;
      ngrams(p).forEach(add);
    }
  }
  let t = String(title || '').replace(/my\s*english\s*school|\bmy\s*-?\s*es\b/gi, ' ');
  const at = t.split('@'); if (at.length > 1) t = at.slice(1).join(' ') + ' ' + at[0];
  t.split(/[-–—|/:·,()]+/).forEach((part) => ngrams(part).forEach(add));
  return out.slice(0, 12);
}
function ngrams(text) {
  const w = String(text || '').replace(/[^A-Za-zÀ-ÿ' .]/g, ' ').split(/\s+/).filter(Boolean), out = [];
  for (let i = 0; i < w.length; i++) {
    if (TRIP_STOP.has(w[i].toLowerCase())) continue;
    for (let n = Math.min(3, w.length - i); n >= 1; n--) {
      const g = w.slice(i, i + n);
      if (TRIP_STOP.has(g[g.length - 1].toLowerCase())) continue;
      if (g.join('').length >= 3) out.push(g.join(' '));
    }
  }
  return out;
}
export const FACILITIES = { room: 'Solo camera', treadmill: 'Tapis roulant', gym: 'Palestra', outdoor: 'Parco o lungofiume vicino', breakfast: 'Colazione presto' };
// Dotazioni ricordate per città (trips.places): valgono per tutte le trasferte successive nello stesso posto
export const placeKey = (c) => String(c || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
export function placeFacilities(p) {
  if (!p) return null;
  const f = [];
  if (p.treadmill) f.push('treadmill'); if (p.gym) f.push('gym'); if (p.outdoor) f.push('outdoor'); if (p.early_breakfast) f.push('breakfast');
  return f.some((x) => x !== 'breakfast') ? f : ['room', ...f];
}
// Giorni di vacanza (niente versione hotel: tempo libero in più)
export function vacationDaySet(trips) {
  const set = new Map();
  for (const t of allTrips(trips)) {
    if (t.type !== 'vacation' || !t.start) continue;
    for (let d = t.start; d <= (t.end || t.start) && diffDays(t.start, d) < 60; d = addDays(d, 1)) set.set(d, t.city || t.title || 'Vacanza');
  }
  return set;
}
// Trasferta in corso in una data, con tipo e dotazioni
export function tripOn(trips, date) {
  return allTrips(trips).find((t) => t.start && t.start <= date && date <= (t.end || t.start)) || null;
}
// Giorni di trasferta di LAVORO (le vacanze non attivano la versione hotel)
export function tripDaySet(trips) {
  const set = new Map();
  const all = allTrips(trips).filter((t) => t.type !== 'vacation');
  for (const t of all) {
    if (!t.start) continue;
    const end = t.end || t.start;
    for (let d = t.start; d <= end && diffDays(t.start, d) < 60; d = addDays(d, 1)) set.set(d, t.city || t.title || 'Trasferta');
  }
  return set;
}

// ---------- Pause (malattia, infortunio, impegni) ----------
export const PAUSE_REASONS = { illness: 'Malattia', injury: 'Infortunio o dolore', busy: 'Impegni', other: 'Altro' };
export const activePause = (pauses = [], today) => pauses.find((p) => !p.endedOn && p.from <= today) || null;
// Giorni coperti dalle pause: fino al giorno prima del rientro, o fino al rientro previsto (almeno fino a oggi se non è ancora finita)
export function pauseDaySet(pauses = [], today) {
  const set = new Map();
  for (const p of pauses) {
    if (!p?.from) continue;
    const end = p.endedOn ? addDays(p.endedOn, -1) : p.to && p.to > today ? p.to : today;
    for (let d = p.from, k = 0; d <= end && k < 180; d = addDays(d, 1), k++) set.set(d, p);
  }
  return set;
}
// Override con le pause sopra: i giorni in pausa diventano "Pausa" ovunque (non contano come saltati)
export function withPauses(overrides = {}, pauses = [], today) {
  const set = pauseDaySet(pauses, today);
  if (!set.size) return overrides;
  const o = { ...overrides };
  for (const [d, p] of set) o[d] = { date: d, kind: 'pause', title: 'Pausa', min: 0, rpe: '-', zone: '-', desc: `${PAUSE_REASONS[p.reason] || 'Pausa'}${p.note ? ': ' + p.note : ''}. Nessun allenamento previsto.`, hotel: true, strength: null, optional: false, pause: true };
  return o;
}

// ---------- Sessione effettiva (piano + override) ----------
export function planIndex(plan) { const m = {}; for (const p of plan || []) m[p.date] = p; return m; }
export const effective = (date, pIdx, overrides) => (overrides && overrides[date]) || pIdx[date] || null;

// ---------- Readiness & adattamento giornaliero ----------
export function readiness(ci, m) {
  let score = 70; const f = [];
  if (ci) {
    if (ci.sleep) { score += (ci.sleep - 3) * 8; if (ci.sleep <= 2) f.push('sonno scarso'); }
    if (ci.energy) { score += (ci.energy - 3) * 10; if (ci.energy <= 2) f.push('energia bassa'); }
    if (ci.legs) { score -= (ci.legs - 1) * 5; if (ci.legs >= 4) f.push('gambe pesanti'); }
    else if (ci.soreness) { score -= ci.soreness * 3; if (ci.soreness >= 5) f.push('indolenzimento'); }
    if (ci.day === 'heavy') { score -= 8; f.push('giornata pesante'); } else if (ci.day === 'light') score += 3;
    else if (ci.stress) score -= (ci.stress - 3) * 5;
    if (ci.travel) { score -= 8; f.push('viaggio'); }
    if (ci.pain?.level) { score -= ci.pain.level * 5; f.push(`fastidio ${ci.pain.area || ''} ${ci.pain.level}/10`.trim()); }
  }
  if (m && !m.calibrating) {
    if (m.form != null && m.form < -25) { score -= 10; f.push('fatica accumulata'); }
    if (m.form != null && m.form > 5) score += 5;
    if (m.acwr > 1.5) { score -= 15; f.push('ACWR alto'); } else if (m.acwr > 1.3) { score -= 7; f.push('ACWR in salita'); }
  }
  score = clamp(Math.round(score), 0, 100);
  return { score, factors: f, tone: score >= 65 ? 'good' : score >= 45 ? 'warn' : 'bad', checked: !!ci };
}

function toEasy(s, min) {
  return { ...s, kind: 'easy', title: 'Facile Z1-Z2 (adattata)', min, rpe: '3', zone: 'Z1-Z2', desc: 'Versione adattata: solo corsa facile, niente variazioni.', hotel: true };
}
export function adaptSession(sess, ctx) {
  const changes = []; let level = 'green';
  if (!sess) return { session: null, changes, level };
  let s = { ...sess };
  const { ci, m, trip, ready, tripSet, date } = ctx;
  const running = ['easy', 'quality', 'long', 'runwalk'].includes(s.kind);
  const pain = ci?.pain?.level || 0;

  if (pain >= 4 && running) {
    level = 'red';
    s = { ...s, kind: 'strength', title: 'Niente corsa: mobilità + core', min: 25, rpe: '3', zone: '-', desc: 'Routine D + routine A, nessun impatto. Se il dolore persiste oltre 48h o cambia il tuo appoggio, senti un medico o un fisioterapista.', strength: 'A', hotel: true };
    changes.push(`Fastidio ${pain}/10: corsa sostituita con lavoro senza impatto.`);
  } else if (pain >= 2 && running) {
    level = 'amber';
    s = toEasy(s, r5(s.min * 0.7));
    changes.push(`Fastidio ${pain}/10: -30% e solo Z1-Z2. Se aumenta durante la corsa, fermati e cammina.`);
  }
  if (running && level !== 'red') {
    if (ready.score < 40) {
      level = 'red';
      s = s.kind === 'long' ? toEasy(s, 30) : { ...s, kind: 'rest', title: 'Riposo (readiness bassa)', min: 0, desc: 'Oggi recuperi. Routine D di mobilità se ti va.', strength: 'D' };
      changes.push(`Readiness ${ready.score}/100: oggi si recupera, il piano non ne risente.`);
    } else if (ready.score < 55) {
      level = level === 'green' ? 'amber' : level;
      s = s.kind === 'quality' ? toEasy(s, r5(s.min * 0.75)) : { ...s, min: r5(s.min * 0.75) };
      changes.push(`Readiness ${ready.score}/100: volume -25%${sess.kind === 'quality' ? ', variazioni tolte' : ''}.`);
    }
    if ((ci?.legs || 0) >= 4 && s.kind === 'quality') {
      level = level === 'green' ? 'amber' : level;
      s = toEasy(s, r5(s.min * 0.8));
      changes.push(`Gambe ${ci.legs}/5: niente qualità oggi, solo facile.`);
    }
    if (m && !m.calibrating && m.acwr > 1.5) {
      level = 'red';
      s = s.kind === 'quality' ? toEasy(s, r5(s.min * 0.7)) : { ...s, min: r5(s.min * 0.7) };
      changes.push(`ACWR ${m.acwr.toFixed(2)} > 1,5: -30% per rientrare nella zona sicura.`);
    } else if (m && !m.calibrating && m.acwr > 1.3 && s.kind === 'quality') {
      level = level === 'green' ? 'amber' : level;
      changes.push(`ACWR ${m.acwr.toFixed(2)}: fai la qualità ma togli l'ultima ripetuta.`);
    }
  }
  if (trip && running && s.kind === 'long') {
    let alt = null;
    for (const k of [-1, 1, -2, 2]) { const d = addDays(date, k); if (!tripSet?.has(d) && [5, 6, 0].includes(dow(d))) { alt = d; break; } }
    changes.push(alt ? `Lungo in trasferta: spostalo a ${DOW_IT_LONG[dow(alt)].toLowerCase()} ${fmtDate(alt)}. Oggi 35' facili vicino all'hotel.` : 'Lungo in trasferta: oggi 40\' facili, il lungo slitta al primo giorno libero.');
    s = toEasy(s, alt ? 35 : 40);
    s.hotel = true; level = level === 'green' ? 'amber' : level;
  } else if (trip && running && !s.hotel) {
    changes.push('Trasferta: versione hotel, stesso stimolo su tapis roulant o parco vicino.');
    s.hotel = true;
  }
  const known = Array.isArray(ctx.facilities) && ctx.facilities.length > 0;
  if (trip && known && RUN_KINDS.includes(s.kind) && !ctx.facilities.some((x) => x === 'treadmill' || x === 'outdoor' || x === 'gym')) {
    const r = sess.kind === 'quality' || sess.kind === 'long' ? 'B' : 'A';
    s = { ...s, kind: 'strength', title: `Solo camera: forza (routine ${r})`, min: STRENGTH[r].min, rpe: '5', zone: '-', desc: `In hotel c'è solo la camera: routine ${r} a corpo libero, poi 5' di mobilità (routine E). La corsa si recupera al rientro.`, strength: r, hotel: true, steps: undefined };
    changes.push('Trasferta con sola camera: corsa sostituita con forza e mobilità.');
    level = level === 'green' ? 'amber' : level;
  }
  if (trip && RUN_KINDS.includes(s.kind)) {
    const fac = ctx.facilities || [];
    s.tripNote = fac.includes('treadmill') || fac.includes('gym') ? 'Tapis roulant in hotel: pendenza 1% per simulare la strada. La qualità si può fare.'
      : fac.includes('outdoor') ? 'Parco o percorso vicino all\'hotel: cerca un anello da 1-2 km.'
        : 'Solo camera: corsa all\'aperto vicino all\'hotel su un anello tranquillo di 1-2 km; se non si può, routine A + D in camera.';
  }
  if (m && m.monotony > 2 && running && s.kind === 'easy') changes.push('Monotonia alta: cambia percorso o terreno oggi.');
  return { session: s, changes, level };
}

// ---------- Nutrizione & idratazione ----------
// Indicazioni generali, senza diete, calorie o pesate: linee guida consolidate per gli sport di endurance
// (posizioni ACSM e ISSN). Ogni consiglio ha il suo "perché". Solo ciò che serve alla sessione del giorno.
export const FUEL_NOTE = 'Indicazioni generali da linee guida ACSM/ISSN. Per esigenze specifiche senti un nutrizionista.';
export function fueling(sess, s = {}, toRace = null) {
  const min = sess?.min || 0, k = sess?.kind;
  const F = (pre, during, post, why, extra = {}) => ({ pre, during, post, why, note: FUEL_NOTE, ...extra });
  const taper = toRace != null && toRace >= 0 && toRace <= 3 && k !== 'race';
  let f;
  if (k === 'race') f = F('Colazione già provata nei lunghi, 2-3 ore prima. Niente di nuovo.', 'Gel e acqua con lo stesso ritmo provato nei lunghi (di solito 1 gel ogni 30-40\' con acqua). Bevi a piccoli sorsi a ogni ristoro.', 'Liquidi e qualcosa con carboidrati e proteine appena riesci. Poi riposo.',
    { pre: 'Il giorno della gara si ripete ciò che l\'intestino conosce già.', during: 'Oltre le 2 ore e mezza le scorte non bastano: i carboidrati presi con regolarità ritardano il calo.', post: 'Reidratarsi e mangiare presto accelera il recupero.' });
  else if (!sess || !['easy', 'quality', 'long', 'runwalk'].includes(k)) f = F(null, null, 'Pasti normali e regolari, acqua durante la giornata.', { post: 'Nei giorni senza corsa non serve nulla di speciale: il recupero si fa anche a tavola.' });
  else if (k === 'long' && min >= 90) f = F('Colazione ricca di carboidrati 2-3 ore prima (pane, marmellata, fette biscottate, banana), poche fibre e grassi. Un bicchiere d\'acqua.', 'Dai 90\' in su si mangia correndo: circa 30-60 g di carboidrati l\'ora, in pratica 1 gel ogni 30-40\' con acqua, iniziando dopo 30-45\'. Acqua a sorsi regolari.', 'Entro un paio d\'ore un pasto completo con carboidrati e proteine, e acqua.',
    { pre: 'Si parte con le scorte piene e lo stomaco leggero.', during: 'Oltre l\'ora e mezza i carboidrati assunti durante ritardano il calo. E serve ad allenare l\'intestino: usa oggi gli stessi gel e ristori che vuoi usare in gara, mesi prima.', post: 'Carboidrati per ricaricare, proteine per riparare.' }, { gut: true });
  else if (k === 'long') f = F('Colazione o spuntino con carboidrati 2-3 ore prima.', 'Acqua a piccoli sorsi, soprattutto se fa caldo.', 'Pasto normale con carboidrati e proteine entro un paio d\'ore.', { pre: 'Sotto i 90\' bastano le scorte, se parti avendo mangiato.', during: 'Sotto l\'ora e mezza i gel non servono.', post: 'Un pasto normale basta per recuperare.' });
  else if (k === 'quality') f = F('Pasto o spuntino con carboidrati 2-3 ore prima (pane, riso, banana). Evita grassi e fibre a ridosso.', min > 60 ? 'Acqua a piccoli sorsi.' : 'Niente, salvo acqua se fa caldo.', 'Entro un paio d\'ore un pasto con carboidrati e proteine.', { pre: 'Il lavoro intenso va a carboidrati; lo stomaco pieno no.', during: 'Sotto l\'ora non serve altro che acqua.', post: 'Aiuta a ricaricare e a recuperare per la prossima sessione.' });
  else f = F('Niente di speciale. Se esci al mattino a stomaco vuoto e ti senti scarico, mezza banana o una fetta di pane.', min >= 60 ? 'Acqua se fa caldo.' : null, 'Pasto normale quando capita.', { pre: 'Sotto l\'ora a ritmo facile le scorte bastano.', during: 'Per un\'uscita facile non serve integrare.', post: 'Una corsa facile non richiede strategie di recupero.' });
  if (taper) { f.pre = `Ultimi giorni prima della gara: più carboidrati del solito a ogni pasto (pasta, riso, pane, patate), niente cibi nuovi. ${f.pre || ''}`.trim(); f.why = { ...f.why, pre: 'Il carico di carboidrati riempie le scorte per la gara; le novità sono un rischio inutile.' }; }
  return f;
}
export function fuelCalc(min, tempC = 18) {
  const h = min / 60;
  const gph = min < 75 ? 0 : min < 150 ? 45 : 75;
  const ml = tempC >= 25 ? 750 : tempC >= 15 ? 550 : 400;
  const na = tempC >= 25 ? 700 : 450;
  const startAt = 45;
  const fuelHours = Math.max(0, (min - startAt) / 60);
  return { carbs: Math.round(gph * fuelHours), gels: Math.ceil((gph * fuelHours) / 25), water: Math.round(ml * h), sodium: Math.round(na * h), gph, mlph: ml };
}
export const TAPER_TIMELINE = [
  { when: '3 settimane prima', what: 'Ultimo lungo vero. Volume settimanale -20/25%.' },
  { when: '2 settimane prima', what: 'Volume -40%, intensità invariata ma breve. Nessuna novità su scarpe e integratori.' },
  { when: 'Settimana gara', what: 'Volume -60%. Mercoledì richiamo 3×5\' a ritmo gara. Sonno 8h+.' },
  { when: 'Ultimi 2-3 giorni', what: 'Più carboidrati del solito a ogni pasto (pasta, riso, pane, patate), poche fibre e grassi, acqua regolare. Niente novità.' },
  { when: 'Mattina gara', what: 'Colazione provata nei lunghi, 2-3 ore prima. Pettorale e gel preparati la sera prima.' },
];

// ---------- Settimana: pianificato vs eseguito ----------
export function weekView(monday, ctx) {
  const { pIdx, overrides, acts, tripSet, today } = ctx;
  const days = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(monday, i);
    const plan = effective(date, pIdx, overrides);
    const done = acts.filter((a) => a.date === date);
    const runMin = done.filter(isRun).reduce((t, a) => t + a.moving_min, 0);
    const planned = plan && ['easy', 'quality', 'long', 'runwalk', 'race'].includes(plan.kind) && !plan.optional;
    const need = strengthNeed(plan);
    const strDone = need ? strengthDoneOn(date, need.kind, done) : false;
    let status = 'planned';
    if (plan?.kind === 'pause') status = 'pause';
    else if (plan?.kind === 'strength' && !runMin) status = date > today ? 'planned' : strDone ? 'done' : date === today ? 'today' : plan.optional ? 'rest' : 'missed';
    else if (date === today) status = runMin ? 'done' : 'today';
    else if (date > today) status = 'planned';
    else if (planned) status = runMin >= plan.min * 0.8 ? 'done' : runMin >= plan.min * 0.4 ? 'partial' : 'missed';
    else status = runMin ? 'extra' : 'rest';
    days.push({ date, plan, done, runMin, km: done.filter(isRun).reduce((t, a) => t + a.dist_km, 0), status, trip: tripSet.get(date) || null, vacation: ctx.vacSet?.get(date) || null, str: need ? { ...need, done: strDone } : null });
  }
  return days;
}
export function compliance(ctx, weeks = 4) {
  const { pIdx, overrides, acts, today } = ctx;
  let planned = 0, done = 0;
  for (let d = addDays(today, -weeks * 7); d < today; d = addDays(d, 1)) {
    const p = effective(d, pIdx, overrides);
    if (!p || !['easy', 'quality', 'long', 'runwalk'].includes(p.kind) || p.optional) continue;
    planned++;
    const m = acts.filter((a) => a.date === d && isRun(a)).reduce((t, a) => t + a.moving_min, 0);
    if (m >= p.min * 0.8) done++;
  }
  return planned ? Math.round((done / planned) * 100) : null;
}

// ---------- Feedback a regole (base sempre disponibile, l'AI lo arricchisce) ----------
export function ruleFeedback(a, planned, m) {
  const hrp = m.hrp, z = zoneSeconds(a, hrp), tot = z.reduce((x, y) => x + y, 0) || 1;
  const easyPct = ((z[0] + z[1]) / tot) * 100, r = rpeOf(a, hrp);
  const kpis = [
    { label: 'Distanza', value: `${a.dist_km.toFixed(1)} km`, status: 'ok' },
    { label: 'Tempo', value: fmtMin(a.moving_min), status: 'ok' },
    { label: 'Passo', value: fmtPace(a.pace_s), status: 'ok' },
    { label: 'FC media', value: a.avg_hr ? `${a.avg_hr} bpm · Z${zoneOf(a.avg_hr, hrp)}` : '—', status: 'ok' },
    { label: 'RPE', value: `${r.v}${r.est ? ' (stima)' : ''}`, status: 'ok' },
    { label: 'Carico', value: String(loadOf(a, hrp)), status: 'ok' },
  ];
  const notes = []; let verdict = 'on_track';
  if (planned && planned.min > 0) {
    const ratio = a.moving_min / planned.min;
    if (ratio < 0.7) { verdict = 'info'; notes.push(`Durata al ${Math.round(ratio * 100)}% del previsto (${planned.min}').`); }
    else if (ratio > 1.25) { verdict = 'too_hard'; notes.push(`+${Math.round((ratio - 1) * 100)}% sul previsto: il volume extra si paga nei giorni dopo.`); }
  }
  const easyType = !planned || ['easy', 'long', 'runwalk'].includes(planned.kind);
  if (easyType && a.avg_hr && isRun(a)) {
    kpis.push({ label: 'Tempo in Z1-Z2', value: `${Math.round(easyPct)}%`, status: easyPct >= 75 ? 'good' : 'bad' });
    if (easyPct < 70) { verdict = 'too_hard'; notes.push(`Solo ${Math.round(easyPct)}% in Z1-Z2 su una seduta facile: rallenta, il motore aerobico si costruisce lì.`); }
  }
  if (a.decoupling != null && a.moving_min >= 60) {
    kpis.push({ label: 'Deriva FC', value: `${a.decoupling}%`, status: a.decoupling > 5 ? 'bad' : 'good' });
    notes.push(a.decoupling > 5 ? `Deriva cardiaca ${a.decoupling}%: resistenza ancora da costruire (o caldo/idratazione).` : `Deriva cardiaca ${a.decoupling}%: controllo aerobico solido.`);
  }
  if (!m.calibrating && m.acwr > 1.3) { verdict = 'warning'; notes.push(`ACWR ${m.acwr.toFixed(2)}: carico in salita rapida, prossimi 2 giorni facili.`); }
  if (r.est) notes.push('RPE stimato dalla FC: inseriscilo per un carico più preciso.');
  const H = { on_track: 'Seduta in linea col piano', too_hard: 'Troppo forte per lo scopo della seduta', too_easy: 'Margine per spingere un filo di più', warning: 'Occhio al carico', info: 'Seduta registrata' };
  const tips = [];
  if (a.moving_min >= 75) tips.push({ type: 'nutrition', text: fueling({ kind: 'long', min: a.moving_min }).post });
  return { headline: H[verdict], verdict, summary: notes.join(' ') || 'Tutto nei parametri. Avanti così.', kpis, adjustments: [], tips };
}

// ---------- Import piano da CSV / ICS ----------
const KIND_RX = [
  [/maratona|gara|race/i, 'race'], [/riposo|rest|off/i, 'rest'], [/lung|long/i, 'long'],
  [/cammin|walk|alternanz/i, 'runwalk'], [/forza|core|strength|mobilit/i, 'strength'],
  [/fartlek|ripetut|progress|tempo|salit|ritmo|interval|soglia|blocchi/i, 'quality'],
];
const inferKind = (t) => (KIND_RX.find(([rx]) => rx.test(t)) || [, 'easy'])[1];
function parseDateAny(v) {
  v = String(v || '').trim();
  let m = v.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = v.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/);
  if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; }
  m = v.match(/^(\d{4})(\d{2})(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}
const minFrom = (t) => { const m = String(t).match(/(\d{1,3})\s*(?:'|min|’|minuti)/i); return m ? +m[1] : null; };
function splitCSV(line, sep) {
  const out = []; let cur = '', q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === sep && !q) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur); return out.map((x) => x.trim());
}
export function parsePlanCSV(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const sep = (lines[0].match(/;/g) || []).length > (lines[0].match(/,/g) || []).length ? ';' : ',';
  const head = splitCSV(lines[0], sep).map((h) => h.toLowerCase());
  const col = (rx) => head.findIndex((h) => rx.test(h));
  const ci = { date: col(/data|date|giorno/), title: col(/titolo|title|sessione|workout|allenamento|tipo|summary/), min: col(/durata|min|duration/), km: col(/km|distanz/), desc: col(/note|desc|dettagl|struttura/), rpe: col(/rpe/), fc: col(/fc|hr|zona|zone/) };
  const out = [];
  for (const l of lines.slice(1)) {
    const c = splitCSV(l, sep), date = parseDateAny(c[ci.date]);
    if (!date) continue;
    const title = c[ci.title] || 'Sessione', desc = ci.desc >= 0 ? c[ci.desc] : '';
    const min = (ci.min >= 0 && parseFloat(c[ci.min])) || minFrom(title) || minFrom(desc) || 0;
    out.push({ date, dow: dow(date), kind: inferKind(title + ' ' + desc), title, min, rpe: ci.rpe >= 0 ? c[ci.rpe] : '', zone: ci.fc >= 0 ? c[ci.fc] : '', desc, km: ci.km >= 0 ? parseFloat(c[ci.km]) || null : null, hotel: !/lung|long|salit/i.test(title), strength: null, optional: /facoltat|opzional/i.test(title + desc), imported: true });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
export function parseICS(text) {
  const unfolded = text.replace(/\r?\n[ \t]/g, '');
  const evs = [];
  for (const block of unfolded.split('BEGIN:VEVENT').slice(1)) {
    const get = (k) => { const m = block.match(new RegExp(`^${k}[^:\\n]*:(.*)$`, 'm')); return m ? m[1].trim() : ''; };
    const ds = get('DTSTART'), de = get('DTEND');
    const allDay = /DTSTART;VALUE=DATE:/.test(block) || /^\d{8}$/.test(ds);
    const start = parseDateAny(ds);
    let end = parseDateAny(de) || start;
    if (allDay && end && end > start) end = addDays(end, -1);
    const durMin = !allDay && ds.length >= 13 && de.length >= 13
      ? Math.round((Date.UTC(+de.slice(0, 4), +de.slice(4, 6) - 1, +de.slice(6, 8), +de.slice(9, 11), +de.slice(11, 13)) - Date.UTC(+ds.slice(0, 4), +ds.slice(4, 6) - 1, +ds.slice(6, 8), +ds.slice(9, 11), +ds.slice(11, 13))) / 60000)
      : null;
    const unesc = (v) => v.replace(/\\n/g, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';');
    evs.push({ start, end, title: unesc(get('SUMMARY')), desc: unesc(get('DESCRIPTION')), location: unesc(get('LOCATION')), durMin, allDay });
  }
  return evs.filter((e) => e.start);
}
export function planFromICS(text) {
  return parseICS(text).map((e) => ({
    date: e.start, dow: dow(e.start), kind: inferKind(e.title + ' ' + e.desc), title: e.title, min: minFrom(e.title) || minFrom(e.desc) || (e.durMin && e.durMin < 300 ? e.durMin : 0),
    rpe: '', zone: '', desc: e.desc, hotel: !/lung|long|salit/i.test(e.title), strength: null, optional: false, imported: true,
  })).sort((a, b) => a.date.localeCompare(b.date));
}

// ---------- Dati demo ----------
function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
export function demoData(today = '2027-03-03') {
  const R = rng(7);
  const settings = { ...DEFAULT_SETTINGS, age: 42, weightKg: 78, hrRest: 58 };
  const plan = generatePlan(settings);
  const hrp = hrProfile(settings);
  const cities = ['Torino', 'Bologna', 'Verona', 'Firenze', 'Genova', 'Padova', 'Brescia'];
  const manual = [];
  for (let w = mondayOf(settings.planStart); w <= addDays(today, 14); w = addDays(w, 7)) {
    if (R() < 0.65) { const s = addDays(w, 1), len = R() < 0.5 ? 2 : 1; manual.push({ id: 'd' + w, start: s, end: addDays(s, len), city: cities[Math.floor(R() * cities.length)], source: 'manual' }); }
  }
  const tripSet = tripDaySet({ manual });
  const activities = []; let id = 9000;
  for (const p of plan) {
    if (p.date >= today) break;
    if (!['easy', 'quality', 'long', 'runwalk'].includes(p.kind)) continue;
    if (p.optional && R() < 0.6) continue;
    if (R() < 0.08) continue;
    const prog = clamp(diffDays(settings.planStart, p.date) / 120, 0, 1);
    const min = Math.max(15, p.min * (0.9 + R() * 0.2) - (p.kind === 'runwalk' ? 4 : 0));
    let pace = 470 - prog * 45 + (R() - 0.5) * 20 + (p.kind === 'runwalk' ? 60 : 0) - (p.kind === 'quality' ? 25 : 0);
    let hr = Math.round(hrp.zones[1].lo + 6 + (R() - 0.3) * 10 - prog * 4 + (p.kind === 'quality' ? 14 : 0) + (p.kind === 'long' ? 4 : 0));
    const hist = {};
    for (let k = 0; k < 40; k++) { const b = hrBucket(hr + (R() - 0.5) * (p.kind === 'quality' ? 34 : 18)); hist[b] = (hist[b] || 0) + Math.round((min * 60) / 40); }
    const trip = tripSet.has(p.date);
    const speed = 1000 / pace;
    const a = {
      id: ++id, date: p.date, start: p.date + 'T07:15:00', name: p.title + (trip ? ' · hotel' : ''), type: trip && R() < 0.5 ? 'VirtualRun' : 'Run',
      dist_km: Math.round(((min * 60) / pace) * 100) / 100, moving_min: Math.round(min * 10) / 10, elapsed_min: Math.round(min + 3), elev: Math.round(R() * 60),
      avg_hr: hr, max_hr: hr + 12 + Math.round(R() * 10), speed, pace_s: Math.round(pace), cadence: 158 + Math.round(R() * 10), trainer: trip, desc: '',
      hist, decoupling: min >= 60 ? Math.round((3 + R() * 5 - prog * 2) * 10) / 10 : null,
    };
    if (R() < 0.7) { a.rpe = p.kind === 'quality' ? 7 : p.kind === 'long' ? 5 : 4; a.rpe_src = 'intervals'; }
    activities.push(a);
  }
  const lastA = activities[activities.length - 1];
  const checkins = { [today]: { date: today, energy: 3, legs: 3, day: 'heavy', pain: { area: '', level: 0 } } };
  const feed = [
    { id: 'f1', ts: Date.now() - 3.6e6 * 14, kind: 'activity', source: 'ai', ref: lastA?.id, headline: 'Lungo gestito bene, deriva sotto controllo', verdict: 'on_track',
      summary: 'Z2 tenuta per il 84% del tempo, deriva cardiaca 4,1%: il motore aerobico risponde. Il passo è sceso di 12"/km rispetto a 4 settimane fa a parità di FC.',
      kpis: [{ label: 'Z1-Z2', value: '84%', status: 'good' }, { label: 'Deriva FC', value: '4,1%', status: 'good' }, { label: 'EF', value: '+3,8%', status: 'good' }],
      adjustments: [], tips: [{ type: 'nutrition', text: 'Dopo i lunghi oltre 75\': 75-90 g carboidrati + 25 g proteine entro un\'ora.' }] },
    { id: 'f2', ts: Date.now() - 3.6e6 * 40, kind: 'checkin', source: 'ai', headline: 'Trasferta Verona: versione hotel attiva', verdict: 'info',
      summary: 'Giovedì fartlek 30/30 su tapis roulant al posto del parco: stesso stimolo, zero sbatti. Mercoledì solo forza B in camera.',
      kpis: [], adjustments: [{ date: addDays(today, 1), action: 'replace', new_title: 'Fartlek 30/30 su tapis roulant', new_min: 40, new_rpe: '6-7', reason: 'Trasferta, hotel con palestra' }], tips: [{ type: 'travel', text: 'In treno: 2 minuti di cammino ogni ora e borraccia sempre piena.' }] },
  ];
  const weekly = { [mondayOf(today)]: { week: mondayOf(today), source: 'ai', title: 'Consolidare la base, trasferte senza perdere colpi',
    why: 'ACWR stabile a 1,05 e monotonia bassa: puoi assorbire il lungo più lungo finora, a patto che le uscite in trasferta restino davvero facili.',
    keys: ['Lungo domenica: tieni la FC sotto il limite alto di Z2 anche negli ultimi 15\'', 'Giovedì fartlek a sensazione: niente orologio sui recuperi', 'Forza B mercoledì in hotel: 3 giri'],
    targets: [{ label: 'Volume', value: '24-27 km' }, { label: 'Z1-Z2', value: '≥ 80%' }, { label: 'Sessioni', value: '4 + 2 forza' }],
    travel: 'Mar-gio fuori: porta elastico e scarpe, verifica tapis roulant hotel.', nutrition: 'Domenica prova 1 gel a 60\' con 150 ml d\'acqua.', watch: 'Polpacci dopo le salite di sabato.' } };
  // Novità del blocco 2: forza segnata a mano, una pausa passata, una vacanza, una trasferta con domanda aperta
  const logs = plan.filter((p) => p.kind === 'strength' && p.date < today && R() < 0.7).map((p) => ({ date: p.date, kind: 'strength', routine: p.strength || 'B', min: 20, rpe: 5, ts: 0 }));
  const pauses = [{ id: 'dp1', from: '2027-01-18', to: '2027-01-22', endedOn: '2027-01-21', reason: 'illness', note: 'influenza' }];
  manual.push({ id: 'dq', start: addDays(today, 2), end: addDays(today, 3), city: 'Verona', source: 'manual' });
  manual.push({ id: 'dv', start: '2027-04-14', end: '2027-04-21', city: 'Sardegna', type: 'vacation', source: 'manual' });
  // Coach personale (blocco 3): profilo, memoria, un check-up applicato, uno aperto e una domanda in attesa
  const profile = { sports: 'Calcetto per 10 anni', runningExperience: 'Qualche 5 km, mai oltre i 10', injuries: 'Distorsione caviglia destra (2019)', weekdaySlots: '7:00-8:00', travelPattern: 'Mar-gio in treno, hotel in centro', goal: 'Finire senza camminare', boredBy: 'Sempre lo stesso giro', treadmill: 'Solo se piove', updatedAt: Date.now() };
  const memory = [
    { id: 'm1', text: 'Dopo 3 giorni di trasferta l\'RPE sale di circa 1 punto', date: addDays(today, -20) },
    { id: 'm2', text: 'Si annoia sul tapis roulant: preferisce anelli all\'aperto', date: addDays(today, -20) },
    { id: 'm3', text: 'Polpaccio sinistro sensibile oltre i 75\'', date: addDays(today, -6) },
    { id: 'm4', text: 'Risponde bene ai fartlek a sensazione', date: addDays(today, -6) },
  ];
  feed.splice(2, 0, { id: 'f4', ts: Date.now() - 3.6e6 * 24 * 6, kind: 'review', source: 'claude', headline: 'Lungo che cresce piano, una qualità in più fuori casa', verdict: 'info', summary: 'Gambe 4/5 e nessun fastidio: il lungo sale di 10\' a settimana, il fartlek resta all\'aperto. Restano 3 corse a settimana: l\'aderenza è al 75%.', diff: [{ date: addDays(today, 1), before: 'Fartlek a sensazione 45\'', after: 'Fartlek piramidale 40\'' }, { date: addDays(today, 4), before: 'Lungo facile 1h10', after: 'Lungo su percorso nuovo 1h20' }], corrections: ['Dom ' + fmtDate(addDays(today, 11)) + ': lungo ridotto a 90\' (massimo +10\' sul più lungo recente)'], snapshotId: 'demo', undoUntil: Date.now() + 864e5, runsPerWeek: 3, kpis: [], adjustments: [], tips: [] });
  const review = { status: 'questions', intro: 'Hai fatto 8 uscite dall\'ultimo check-up: due domande per tarare le prossime 4 settimane.', reasons: [{ k: 'runs', label: '8 allenamenti dall\'ultimo check-up' }], askedAt: Date.now() - 3.6e6 * 5, answers: {},
    questions: [{ id: 'gambe', text: 'Come stanno le gambe dopo il lungo di domenica?', type: 'scale' }, { id: 'verona', text: 'A Verona riesci a correre all\'aperto?', type: 'choice', options: ['Sì, al mattino', 'Solo tapis roulant', 'Non credo'] }, { id: 'note', text: 'C\'è qualcosa che vuoi dirmi?', type: 'text' }] };
  return { settings, plan, overrides: {}, activities, trips: { manual, ical: [] }, checkins, feed, weekly, logs, pauses, profile, memory, review, inbox: 0, connector: true, garmin: { ts: Date.now(), days: { [today]: { status: 'ok' }, [addDays(today, 1)]: { status: 'ok' } } }, intervals: { connected: true, athlete: 'Demo', imported: true }, ai: true, serverToday: today, demo: true };
}

// ============================================================================
// Coach personale: segnali per il check-up, limiti di sicurezza, differenze
// ============================================================================
export const RUN_KINDS = ['easy', 'quality', 'long', 'runwalk'];
const KINDS = ['easy', 'quality', 'long', 'runwalk', 'strength', 'rest', 'race'];
export const REVIEW_EVERY_RUNS = 8;
export const REVIEW_COOLDOWN_DAYS = 5;
export const REVIEW_ANSWER_HOURS = 72;
export const REVIEW_HORIZON_DAYS = 28;
export const GUARD = { weeklyGrowth: 0.12, longStepMin: 10, maxQualityPerWeek: 2, painLock: 5, taperDays: 21, returnFactor: 0.7 };

// Minuti di corsa "equivalenti" di una sessione pianificata (la corsa/cammino pesa ~55%)
export const runMinutes = (s) => (!s || !RUN_KINDS.includes(s.kind) ? 0 : s.kind === 'runwalk' ? (s.min || 0) * 0.55 : s.min || 0);

// Quando serve un check-up del coach
export function reviewTrigger({ today, acts = [], checkins = {}, plan = [], overrides = {}, settings, review = {}, m, pauses = [] }) {
  const reasons = [];
  // In pausa niente check-up: si fa al rientro
  if (activePause(pauses, today)) return { stage: 'paused', due: false, reasons: [], runsSince: 0, cooling: false, painSignal: false };
  overrides = withPauses(overrides, pauses, today);
  const lastDate = review.lastReviewAt ? new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(review.lastReviewAt)) : null;
  const runs = acts.filter((a) => isRun(a) && a.date <= today && (!lastDate || a.date > lastDate) && a.date >= settings.planStart);
  const runsSince = runs.length;
  if (runsSince >= REVIEW_EVERY_RUNS) reasons.push({ k: 'runs', label: `${runsSince} allenamenti dall'ultimo check-up` });
  const ph = phaseAt(today, settings);
  if (review.lastPhase && review.lastPhase !== ph.id && ph.id !== 'pre') reasons.push({ k: 'phase', label: `Inizia la fase "${ph.name}"` });
  if (review.requested) reasons.push({ k: 'request', label: 'Check-up richiesto da te' });
  const back = pauses.filter((p) => p.endedOn && p.endedOn <= today && (!lastDate || p.endedOn > lastDate)).sort((a, b) => b.endedOn.localeCompare(a.endedOn))[0];
  if (back) reasons.push({ k: 'return', label: `Rientro dalla pausa (${PAUSE_REASONS[back.reason] || 'pausa'})` });

  // Segnali
  const ci7 = Object.values(checkins).filter((c) => c.date > addDays(today, -7) && c.date <= today).sort((a, b) => a.date.localeCompare(b.date));
  const painy = ci7.filter((c) => (c.pain?.level || 0) >= 4);
  const byArea = {};
  painy.forEach((c) => { const k = (c.pain.area || '?').toLowerCase().trim(); byArea[k] = (byArea[k] || 0) + 1; });
  const painLevels = ci7.map((c) => c.pain?.level || 0).filter((v) => v > 0);
  const rising = painLevels.length >= 2 && painLevels[painLevels.length - 1] >= 3 && painLevels[painLevels.length - 1] > painLevels[painLevels.length - 2];
  let painSignal = false;
  if (Object.values(byArea).some((n) => n >= 2) || rising) { painSignal = true; reasons.push({ k: 'pain', label: 'Fastidio ricorrente o in aumento' }); }

  const pIdx = planIndex(plan);
  let missed = 0;
  for (let d = addDays(today, -7); d < today; d = addDays(d, 1)) {
    const p = effective(d, pIdx, overrides);
    if (!p || !RUN_KINDS.includes(p.kind) || p.optional || !p.min) continue;
    const done = acts.filter((a) => a.date === d && isRun(a)).reduce((t, a) => t + (a.moving_min || 0), 0);
    if (done < p.min * 0.4) missed++;
  }
  if (missed >= 2) reasons.push({ k: 'missed', label: `${missed} sessioni saltate negli ultimi 7 giorni` });

  if (m && !m.calibrating) {
    const last3 = m.series.slice(-3);
    if (last3.length === 3 && last3.every((x) => x.acwr != null && x.acwr > 1.3)) reasons.push({ k: 'acwr', label: 'ACWR sopra 1,3 da 3 giorni' });
  }
  const last3ci = [0, 1, 2].map((i) => checkins[addDays(today, -i)]);
  if (last3ci.every(Boolean) && last3ci.every((c) => readiness(c, m).score < 50)) reasons.push({ k: 'ready', label: 'Readiness sotto 50 da 3 giorni' });

  const cooling = lastDate && diffDays(lastDate, today) < REVIEW_COOLDOWN_DAYS && !painSignal && !review.requested && !back;
  let stage = 'none';
  if (review.status === 'questions') {
    const expired = review.askedAt && Date.now() - review.askedAt > REVIEW_ANSWER_HOURS * 3.6e6;
    stage = review.answeredAt ? 'apply' : expired ? 'apply_no_answers' : 'waiting_answers';
  } else if (reasons.length && !cooling && today >= addDays(settings.planStart, -3)) stage = 'ask';
  return { stage, due: stage === 'ask' || stage === 'apply' || stage === 'apply_no_answers', reasons, runsSince, cooling: !!cooling, painSignal };
}

function cleanSession(s) {
  const str = (v, n) => String(v ?? '').replace(/<[^>]*>/g, '').slice(0, n);
  const kind = KINDS.includes(s.kind) ? s.kind : 'easy';
  return {
    date: s.date, dow: dow(s.date), kind, title: str(s.title, 80) || 'Sessione', min: kind === 'rest' ? 0 : clamp(Math.round(+s.min || 0), 0, 240),
    rpe: str(s.rpe, 10) || (kind === 'rest' ? '-' : '3-4'), zone: str(s.zone, 12) || (kind === 'rest' ? '-' : 'Z1-Z2'), desc: str(s.desc, 400),
    hotel: s.hotel !== false, strength: ['A', 'B', 'C', 'D', 'E'].includes(s.strength) ? s.strength : null, optional: !!s.optional, coach: true,
    ...(['5k', '30min'].includes(s.test) ? { test: s.test } : {}),
    ...withSteps(kind, s.steps),
  };
}
// Passi strutturati: ripuliti, massimo 30, durate 0,25-120', zone Z1-Z5; la durata della sessione diventa la loro somma
function withSteps(kind, steps) {
  if (!RUN_KINDS.includes(kind) || !Array.isArray(steps)) return {};
  let n = 0;
  const one = (x, depth) => {
    if (!x || n >= 30) return null;
    if (x.type === 'repeat' && depth === 0) {
      const inner = (Array.isArray(x.steps) ? x.steps : []).map((y) => one(y, 1)).filter(Boolean);
      return inner.length ? { type: 'repeat', reps: clamp(Math.round(+x.reps || 1), 1, 30), steps: inner } : null;
    }
    const type = ['warmup', 'run', 'recover', 'walk', 'cooldown'].includes(x.type) ? x.type : 'run';
    n++;
    return { type, min: Math.round(clamp(+x.min || 0, 0.25, 120) * 4) / 4, zone: /^Z[1-5]$/.test(x.zone) ? x.zone : 'Z2', ...(x.note ? { note: String(x.note).replace(/<[^>]*>/g, '').slice(0, 40) } : {}) };
  };
  const clean = steps.map((x) => one(x, 0)).filter(Boolean);
  if (!clean.length) return {};
  return { steps: clean, min: Math.round(stepsMinutes(clean)) };
}
const easyOf = (s, min, why) => ({ ...s, kind: 'easy', title: 'Facile Z1-Z2', min, rpe: '3-4', zone: 'Z1-Z2', desc: (s.desc ? s.desc + ' ' : '') + why, hotel: true, steps: easySteps(min) });

// Limiti di sicurezza: corregge il piano proposto dal coach. Restituisce le sessioni valide e le correzioni fatte.
export function validatePlan(proposed, { today, plan = [], overrides = {}, acts = [], checkins = {}, tripSet = new Map(), settings, pauses = [] }) {
  const corrections = [];
  // Rientro da una pausa di almeno 7 giorni: per 2 settimane volume al massimo al 70% di prima, senza eccezioni
  const lastPause = pauses.filter((p) => p.endedOn && p.endedOn <= today && diffDays(p.from, p.endedOn) >= 7).sort((a, b) => b.endedOn.localeCompare(a.endedOn))[0];
  const returnUntil = lastPause ? addDays(lastPause.endedOn, 14) : null;
  const prePauseAvg = lastPause ? [1, 2, 3].reduce((t, k) => { const mon = addDays(mondayOf(lastPause.from), -7 * k); return t + acts.filter((a) => isRun(a) && a.date >= mon && a.date < addDays(mon, 7)).reduce((x, a) => x + (a.moving_min || 0), 0); }, 0) / 3 : 0;
  const fix = (date, msg) => corrections.push(`${DOW_IT[dow(date)]} ${fmtDate(date)}: ${msg}`);
  const pIdx = planIndex(plan);
  const horizonEnd = addDays(today, REVIEW_HORIZON_DAYS);
  const taperFrom = addDays(settings.raceDate, -GUARD.taperDays);
  const byDate = {};
  for (const raw of Array.isArray(proposed) ? proposed : []) {
    if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw.date || '')) continue;
    if (raw.date <= today || raw.date > horizonEnd) { corrections.push(`Ignorata la sessione del ${raw.date}: fuori dal periodo del check-up`); continue; }
    if (raw.date >= settings.raceDate) { corrections.push(`Ignorata la sessione del ${raw.date}: la gara e i giorni dopo non si toccano`); continue; }
    byDate[raw.date] = cleanSession(raw);
  }
  const dates = Object.keys(byDate).sort();
  if (!dates.length) return { sessions: [], corrections, from: null, to: null };
  const from = dates[0], to = dates[dates.length - 1];

  // Sessioni per giorno (nuove o, se mancanti, quelle già in piano)
  const old = (d) => effective(d, pIdx, overrides);
  const recentPain = [0, 1, 2].map((i) => checkins[addDays(today, -i)]?.pain?.level || 0);
  const painLock = Math.max(...recentPain) >= GUARD.painLock;
  for (const d of dates) {
    let s = byDate[d]; const o = old(d);
    if (painLock) {
      if (s.kind === 'quality') { s = easyOf(s, Math.min(s.min, runMinutes(o) || s.min), 'Niente qualità finché c\'è il fastidio.'); fix(d, 'qualità tolta per il fastidio segnalato'); }
      if (runMinutes(s) > runMinutes(o)) { s = scaleSteps({ ...s, min: o?.min || 0 }); fix(d, 'nessun aumento finché c\'è il fastidio'); }
    }
    if (d >= taperFrom && o) {
      if (runMinutes(s) > runMinutes(o)) { s = scaleSteps({ ...s, min: o.min }); fix(d, 'nello scarico finale si può solo ridurre'); }
      if ((s.kind === 'quality' || s.kind === 'long') && s.kind !== o.kind) { s = easyOf(s, s.min, ''); fix(d, 'nello scarico finale niente nuove sedute dure'); }
    }
    if (tripSet.has(d) && RUN_KINDS.includes(s.kind)) {
      if (s.kind === 'long') { s = easyOf(s, Math.min(45, s.min), 'Versione trasferta.'); fix(d, `lungo in trasferta (${tripSet.get(d)}) trasformato in facile`); }
      else if (!s.hotel) { s = { ...s, hotel: true }; }
    }
    byDate[d] = s;
  }

  // Controlli settimanali
  const dayOf = (d) => byDate[d] || old(d);
  const actualRunMin = (mon) => acts.filter((a) => isRun(a) && a.date >= mon && a.date < addDays(mon, 7)).reduce((t, a) => t + (a.moving_min || 0), 0);
  const weekMin = (mon) => {
    let t = 0;
    for (let i = 0; i < 7; i++) { const d = addDays(mon, i); t += d <= today ? acts.filter((a) => isRun(a) && a.date === d).reduce((x, a) => x + (a.moving_min || 0), 0) : runMinutes(dayOf(d)); }
    return t;
  };
  const oldWeekMin = (mon) => { let t = 0; for (let i = 0; i < 7; i++) t += runMinutes(old(addDays(mon, i))); return t; };
  const longestBefore = (d) => {
    const fromD = addDays(d, -21); let mx = 0;
    acts.forEach((a) => { if (isRun(a) && a.date >= fromD && a.date <= today) mx = Math.max(mx, a.moving_min || 0); });
    for (let x = addDays(today, 1); x < d; x = addDays(x, 1)) if (x >= fromD) { const s = dayOf(x); if (s?.kind === 'long') mx = Math.max(mx, s.min); }
    return mx;
  };
  for (let mon = mondayOf(from); mon <= to; mon = addDays(mon, 7)) {
    const wd = [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(mon, i));
    const editable = wd.filter((d) => byDate[d]);
    if (!editable.length) continue;
    // Qualità: massimo 2, mai in giorni consecutivi
    let q = 0, prevQ = null;
    for (const d of wd) {
      const s = dayOf(d);
      if (s?.kind !== 'quality') { prevQ = null; continue; }
      const consecutive = prevQ && diffDays(prevQ, d) === 1;
      if ((q >= GUARD.maxQualityPerWeek || consecutive) && byDate[d]) { byDate[d] = easyOf(s, s.min, ''); fix(d, consecutive ? 'due qualità di fila: la seconda diventa facile' : 'massimo 2 sedute di qualità a settimana'); prevQ = null; continue; }
      q++; prevQ = d;
    }
    // Almeno un giorno di riposo completo
    if (!wd.some((d) => dayOf(d)?.kind === 'rest' || !dayOf(d))) {
      const cand = editable.filter((d) => dayOf(d).kind !== 'long' && dayOf(d).kind !== 'race').sort((a, b) => runMinutes(dayOf(a)) - runMinutes(dayOf(b)))[0];
      if (cand) { byDate[cand] = { ...byDate[cand], kind: 'rest', title: 'Riposo', min: 0, rpe: '-', zone: '-', desc: 'Riposo completo (almeno uno a settimana).', strength: null, steps: undefined }; fix(cand, 'serve almeno un giorno di riposo a settimana'); }
    }
    // Lungo: massimo +10' rispetto al più lungo delle ultime 3 settimane
    for (const d of editable) {
      const s = byDate[d];
      if (s.kind !== 'long') continue;
      const cap = Math.max(longestBefore(d) + GUARD.longStepMin, old(d)?.kind === 'long' ? old(d).min : 0, 40);
      if (s.min > cap) { byDate[d] = scaleSteps({ ...s, min: Math.floor(cap / 5) * 5 }); fix(d, `lungo ridotto a ${byDate[d].min}' (massimo +${GUARD.longStepMin}' sul più lungo recente)`); }
    }
    // Volume: massimo +12% sulla media delle 3 settimane prima (o quanto già previsto dal piano originale)
    const prev = [1, 2, 3].map((k) => { const pm = addDays(mon, -7 * k); return addDays(pm, 6) <= today ? actualRunMin(pm) : weekMin(pm); });
    const base = prev.reduce((a, b) => a + b, 0) / 3;
    const returning = returnUntil && mon < returnUntil;
    const cap = returning ? Math.max(prePauseAvg * GUARD.returnFactor, 40) : Math.max(base * (1 + GUARD.weeklyGrowth), oldWeekMin(mon), 60);
    let tot = weekMin(mon);
    if (tot > cap + 1) {
      const order = editable.filter((d) => RUN_KINDS.includes(byDate[d].kind)).sort((a, b) => (byDate[a].kind === 'long') - (byDate[b].kind === 'long'));
      let excess = tot - cap;
      for (const d of order) {
        if (excess <= 0) break;
        const s = byDate[d], w = s.kind === 'runwalk' ? 0.55 : 1, floor = returning ? (s.kind === 'long' ? 25 : 15) : s.kind === 'long' ? 40 : 20;
        const cut = Math.min(excess / w, s.min - floor);
        if (cut <= 0) continue;
        const nm = Math.max(floor, Math.floor((s.min - cut) / 5) * 5);
        excess -= (s.min - nm) * w; byDate[d] = scaleSteps({ ...s, min: nm });
      }
      tot = weekMin(mon);
      corrections.push(returning ? `Settimana del ${fmtDate(mon)}: rientro dalla pausa, volume ridotto a ~${Math.round(tot)}' di corsa (massimo ${Math.round(GUARD.returnFactor * 100)}% di prima)` : `Settimana del ${fmtDate(mon)}: volume ridotto a ~${Math.round(tot)}' di corsa (massimo +${Math.round(GUARD.weeklyGrowth * 100)}% sulle settimane precedenti)`);
    }
  }
  const sessions = Object.keys(byDate).sort().map((d) => ({ ...byDate[d], phase: phaseAt(d, settings).id, week: phaseAt(d, settings).week }));
  return { sessions, corrections, from, to };
}

// Differenze tra due piani effettivi (per la card del check-up)
export function planDiff(before, after) {
  const out = [];
  const label = (s) => (!s ? '—' : s.kind === 'rest' ? 'Riposo' : `${s.title}${s.min ? ' ' + fmtMin(s.min) : ''}`);
  for (const a of after) {
    const b = before[a.date];
    if (!b || b.kind !== a.kind || b.min !== a.min || b.title !== a.title) out.push({ date: a.date, before: label(b), after: label(a) });
  }
  return out;
}

// Contesto compatto per il coach (uguale per API e connettore)
export const DAY_LOAD = { light: 'leggera', normal: 'normale', heavy: 'pesante' };
export const PAIN_AREAS = ['Piede', 'Caviglia', 'Tendine d\'Achille', 'Polpaccio', 'Tibia', 'Ginocchio', 'Coscia', 'Anca', 'Schiena', 'Altro'];
export function checkinTrend(checkins, today, days = 14) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = addDays(today, -i), c = checkins[d];
    if (c) out.push({ data: d, energia: c.energy, gambe: c.legs ?? null, giornata: DAY_LOAD[c.day] || null, fastidio: c.pain?.level ? `${c.pain.area || '?'} ${c.pain.level}/10` : null, ...(c.note ? { nota: c.note } : {}) });
  }
  return out;
}
export function profileText(p) {
  if (!p || !Object.keys(p).length) return null;
  const L = [];
  const add = (k, v) => { if (v != null && String(v).trim() !== '' && !(Array.isArray(v) && !v.length)) L.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`); };
  add('Corsa', p.running); add('Palestra', p.gym); add('Gare fatte', p.races); add('Cosa lo fa mollare', p.quitTriggers); add('Giorni preferiti', p.preferredDays); add('Orari preferiti', p.preferredTime); add('Giorno del lungo', p.longDay); add('Giorni impossibili', p.impossibleDays); add('Settimana tipo', p.typicalWeek); add('Carico di lavoro', p.workload);
  add('Sport praticati', p.sports); add('Esperienza di corsa', p.runningExperience); add('Infortuni passati', p.injuries); add('Punti deboli', p.weakPoints); add('Note storia sportiva', p.historyNotes);
  add('Quando può correre nei feriali', p.weekdaySlots); add('Quando può correre nel weekend', p.weekendSlots); add('Trasferte tipiche', p.travelPattern); add('Ore di sonno abituali', p.sleepHours); add('Stress lavoro medio (1-5)', p.workStress); add('Note vita e orari', p.lifeNotes);
  add('Obiettivo', p.goal); add('Tempo obiettivo', p.goalTime); add('Cosa lo motiva', p.motivation); add('Cosa lo annoia', p.boredBy); add('Come vuole i feedback', p.feedbackStyle); add('Note obiettivi', p.goalNotes);
  add('Sessioni che ama', p.lovedSessions); add('Sessioni che odia', p.hatedSessions); add('Preferisce correre', p.timeOfDay); add('Tapis roulant', p.treadmill); add('Da solo o in compagnia', p.social); add('Note preferenze', p.prefNotes);
  return L.join('\n');
}

// ============================================================================
// Passi strutturati (workout guidati sul Garmin tramite intervals.icu)
// ============================================================================
export const stepsMinutes = (steps = []) => steps.reduce((t, x) => t + (x.type === 'repeat' ? (x.reps || 1) * stepsMinutes(x.steps) : x.min || 0), 0);
const st = (type, min, zone, note) => ({ type, min, zone, ...(note ? { note } : {}) });
export const easySteps = (min) => (min >= 20 ? [st('warmup', 5, 'Z1'), st('run', min - 10, 'Z2'), st('cooldown', 5, 'Z1')] : [st('run', Math.max(min, 5), 'Z2')]);
// Riporta i passi alla nuova durata (accorcia/allunga le parti continue, non le ripetute)
export function scaleSteps(s) {
  if (!s.steps?.length || !RUN_KINDS.includes(s.kind)) return s;
  const tot = stepsMinutes(s.steps), diff = (s.min || 0) - tot;
  if (Math.abs(diff) < 0.5) return s;
  const steps = s.steps.map((x) => ({ ...x }));
  const flex = steps.filter((x) => x.type === 'run' || x.type === 'cooldown').sort((a, b) => b.min - a.min);
  let rest = diff;
  for (const x of flex) { const nm = Math.max(x.type === 'cooldown' ? 3 : 5, x.min + rest); rest -= nm - x.min; x.min = Math.round(nm * 4) / 4; if (Math.abs(rest) < 0.5) break; }
  if (Math.abs(rest) >= 0.5) return { ...s, steps: easySteps(s.min) };
  return { ...s, steps };
}
// Passi dedotti dalla sessione del piano generato (titolo + durata)
export function stepsFor(s) {
  if (!s || !RUN_KINDS.includes(s.kind) || !s.min) return null;
  if (s.steps) return s.steps;
  const min = s.min, t = (s.title || '').toLowerCase();
  const wrap = (wu, main, fixed) => { const cd = Math.max(5, min - wu - fixed); return [st('warmup', wu, 'Z2'), ...main, st('cooldown', cd, 'Z1')]; };
  const rep = (reps, on, onZ, off, offZ, offType = 'recover') => ({ type: 'repeat', reps, steps: [st('run', on, onZ), st(offType, off, offZ)] });
  if (s.kind === 'long') {
    if (/ritmo gara|finale/.test(t)) return [st('warmup', 10, 'Z1'), st('run', Math.max(10, min - 38), 'Z2'), st('run', 28, 'Z3', 'ritmo gara')];
    if (/progressiv/.test(t)) return [st('warmup', 10, 'Z1'), st('run', Math.max(10, min - 25), 'Z2'), st('run', 15, 'Z3')];
    if (/blocchi/.test(t)) return [st('warmup', 10, 'Z1'), st('run', 35, 'Z2'), rep(3, 15, 'Z3', 10, 'Z2', 'run'), st('run', Math.max(5, min - 120), 'Z2')];
    return [st('warmup', 10, 'Z1'), st('run', min - 10, 'Z2')];
  }
  if (s.kind === 'easy') {
    if (s.strides || /allunghi/.test(t)) { const r = /attivazione/.test(t) ? 3 : 6; return [st('warmup', 5, 'Z1'), st('run', Math.max(5, min - 5 - r * 1.33 - 3), 'Z2'), rep(r, 0.33, 'Z4', 1, 'Z1', 'walk'), st('cooldown', 3, 'Z1')]; }
    return easySteps(min);
  }
  if (s.kind === 'quality') {
    if (/30\/30/.test(t)) return wrap(10, [rep(24, 0.5, 'Z4', 0.5, 'Z2')], 24);
    if (/salit/.test(t)) return wrap(15, [rep(8, 0.75, 'Z4', 2, 'Z1')], 22);
    if (/tempo run spezzato/.test(t)) return wrap(15, [rep(3, 8, 'Z3', 2, 'Z1')], 30);
    if (/tempo \+ ritmo/.test(t)) return wrap(15, [rep(2, 10, 'Z4', 2, 'Z1'), st('run', 15, 'Z3', 'ritmo gara')], 39);
    if (/blocchi/.test(t)) { const r = clamp(Math.floor((min - 20) / 15), 2, 3); return wrap(15, [rep(r, 12, 'Z3', 3, 'Z2')], r * 15); }
    if (/richiamo/.test(t)) return wrap(10, [rep(3, 5, 'Z3', 2, 'Z1')], 21);
    if (/misto/.test(t)) return wrap(15, [rep(6, 3, 'Z4', 2, 'Z3')], 30);
    if (/medio con finale/.test(t)) return [st('warmup', 10, 'Z2'), st('run', Math.max(10, min - 35), 'Z2'), st('run', 22, 'Z3', 'ritmo gara'), st('cooldown', 3, 'Z1')];
    if (/progressivo a 3/.test(t)) return [st('warmup', 15, 'Z2'), st('run', 15, 'Z3'), st('run', Math.max(5, min - 35), 'Z4'), st('cooldown', 5, 'Z1')];
    if (/progressiv/.test(t)) { const b = Math.max(5, Math.round((min - 5) / 4)); return [st('warmup', b, 'Z1'), st('run', b, 'Z2'), st('run', b, 'Z2'), st('run', Math.max(5, min - 5 - 3 * b), 'Z3'), st('cooldown', 5, 'Z1')]; }
    if (/piramid/.test(t)) return wrap(10, [st('run', 1, 'Z4'), st('recover', 1, 'Z2'), st('run', 2, 'Z4'), st('recover', 2, 'Z2'), st('run', 3, 'Z4'), st('recover', 3, 'Z2'), st('run', 2, 'Z4'), st('recover', 2, 'Z2'), st('run', 1, 'Z4'), st('recover', 1, 'Z2')], 18);
    if (/fartlek/.test(t)) { const reps = clamp(Math.floor((min - 15) / 3), 4, 10); return wrap(10, [rep(reps, 1, 'Z4', 2, 'Z2')], reps * 3); }
    return [st('warmup', 10, 'Z2'), st('run', Math.max(5, min - 15), 'Z3'), st('cooldown', 5, 'Z1')];
  }
  if (s.kind === 'runwalk') return null; // i passi li mette già rwSession()
  return easySteps(min);
}
// Testo nel formato dei workout di intervals.icu (verifica la sintassi: "- 10m Z2 HR", "6x", sezioni Warmup/Cooldown)
const dur = (m) => { const sec = Math.round(m * 60); return sec % 60 === 0 ? `${sec / 60}m` : sec > 60 ? `${Math.floor(sec / 60)}m${sec % 60}s` : `${sec}s`; };
const CUE = { walk: 'Cammino ', recover: 'Recupero ' };
const line = (x) => `- ${x.note ? x.note + ' ' : CUE[x.type] || ''}${dur(x.min)} ${x.zone} HR`;
export function toIntervalsText(steps = []) {
  const out = [];
  for (const x of steps) {
    if (x.type === 'repeat') { out.push('', `${x.reps}x`, ...x.steps.map(line), ''); continue; }
    if (x.type === 'warmup') out.push('Warmup', line(x), '');
    else if (x.type === 'cooldown') out.push('', 'Cooldown', line(x));
    else out.push(line(x));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ============================================================================
// Giorni di corsa a settimana: li decide il coach, ma salgono di 1 al massimo e solo se i dati lo permettono
// ============================================================================
export function guardRunsPerWeek(cur, next, { acts = [], checkins = {}, plan = [], overrides = {}, today, m }) {
  cur = clamp(+cur || 3, 3, 5); next = clamp(Math.round(+next || cur), 3, 5);
  if (next <= cur) return { value: next, note: null };
  const comp = compliance({ pIdx: planIndex(plan), overrides, acts, today }, 2);
  const pain = Object.values(checkins).some((c) => c.date > addDays(today, -14) && (c.pain?.level || 0) >= 4);
  const acwr = m && !m.calibrating ? m.acwr : null;
  const why = [];
  if (comp != null && comp < 80) why.push(`aderenza ${comp}% (serve almeno 80%)`);
  if (pain) why.push('fastidio negli ultimi 14 giorni');
  if (acwr != null && acwr > 1.3) why.push(`ACWR ${acwr.toFixed(2)} sopra 1,3`);
  if (why.length) return { value: cur, note: `Restano ${cur} corse a settimana: ${why.join(', ')}` };
  return { value: cur + 1, note: next > cur + 1 ? `Salgo a ${cur + 1} corse (massimo +1 per check-up)` : null };
}
