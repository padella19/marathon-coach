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
  raceName: 'Maratona',
  icalUrls: '',            // URL iCal segreti dei calendari trasferte (uno per riga)
  planSource: 'generated',
};

// ---------- Attività ----------
const RUN_TYPES = new Set(['Run', 'TrailRun', 'VirtualRun']);
export const isRun = (a) => RUN_TYPES.has(a.type);

// ---------- Frequenza cardiaca ----------
export function hrProfile(s, acts = []) {
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
// Carico di sessione (Foster sRPE): minuti × RPE
export const loadOf = (a, hrp) => Math.round((a.moving_min || 0) * rpeOf(a, hrp).v);

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
  pre: 'Prima del via: scarpe giuste, Garmin collegato a intervals.icu, 2-3 camminate veloci a settimana. Nessuna fretta.',
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
};

function S(date, kind, title, min, rpe, zone, desc, extra = {}) {
  return { date, dow: dow(date), kind, title, min, rpe, zone, desc, hotel: true, strength: null, optional: false, ...extra };
}
function rwSession(date, L, long) {
  const [r, c, n] = RW[Math.min(L, 5)];
  if (long && L >= 5) return S(date, 'runwalk', 'Primi 30\' continui', 40, '3-4', 'Z1-Z2', '5\' cammino + 30\' corsa continua facilissima + 5\' cammino. Primo traguardo vero.', { hotel: false });
  const reps = long ? n + 1 : n;
  return S(date, 'runwalk', `Corsa/cammino ${r}'/${c}'`, 10 + reps * (r + c), '3-4', 'Z1-Z2',
    `5' camminata svelta + ${reps}×(${r}' corsa facile / ${c}' cammino) + 5' camminata. Devi poter parlare.`);
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
      if ((id === 'build' || id === 'spec') && !P.rec) return easy(30, w + 1, { optional: true });
      return S(date, 'rest', 'Riposo', 0, '-', '-', 'Gambe ferme in vista del weekend.');
    case 'sat':
      if (id === 'cond') return S(date, 'easy', 'Camminata svelta + piede-caviglia', 35, '2-3', 'Z1', '35-40\' di camminata svelta, poi routine C.', { strength: 'C', optional: true });
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
      out.push(sess);
    }
  }
  return out;
}

// ---------- Trasferte ----------
export function tripDaySet(trips) {
  const set = new Map();
  const all = [...(trips?.manual || []), ...(trips?.ical || [])];
  for (const t of all) {
    if (!t.start) continue;
    const end = t.end || t.start;
    for (let d = t.start; d <= end && diffDays(t.start, d) < 60; d = addDays(d, 1)) set.set(d, t.city || t.title || 'Trasferta');
  }
  return set;
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
    if (ci.soreness) { score -= ci.soreness * 3; if (ci.soreness >= 5) f.push('indolenzimento'); }
    if (ci.stress) score -= (ci.stress - 3) * 5;
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
  if (trip && running) s.tripNote = 'Tapis roulant: pendenza 1% per simulare la strada. Parco: cerca un anello da 1-2 km vicino all\'hotel.';
  if (m && m.monotony > 2 && running && s.kind === 'easy') changes.push('Monotonia alta: cambia percorso o terreno oggi.');
  return { session: s, changes, level };
}

// ---------- Nutrizione & idratazione ----------
export function fueling(sess, s = {}) {
  const kg = s.weightKg;
  const min = sess?.min || 0;
  if (!sess || ['rest', 'strength'].includes(sess.kind)) return {
    pre: null, during: null,
    post: `Recupero: proteine distribuite nei pasti (${kg ? Math.round(kg * 1.6) + ' g' : '1,6 g/kg'} al giorno), acqua ${kg ? Math.round(kg * 0.035 * 10) / 10 + ' L' : '30-35 ml/kg'} nell'arco della giornata.`,
  };
  if (sess.kind === 'race') return {
    pre: `Carico carboidrati nei 2 giorni prima: ${kg ? `${kg * 8}-${kg * 10} g/giorno` : '8-10 g/kg al giorno'}. Colazione 3h prima: ${kg ? `${kg * 2}-${kg * 3} g` : '2-3 g/kg'} di carboidrati, niente di nuovo.`,
    during: '60-90 g carboidrati/h (gel glucosio+fruttosio ogni 25-30\'), 400-800 ml/h in base al caldo, sodio 500-800 mg/h.',
    post: 'Entro 30\': liquidi + carboidrati + 20-30 g proteine. Poi riposo vero.',
  };
  if (min < 60) return { pre: 'Va bene anche a stomaco quasi vuoto o con uno snack leggero (banana, fetta biscottata).', during: 'Acqua solo se fa caldo.', post: 'Pasto normale entro 1-2h.' };
  if (min < 90) return { pre: 'Snack 60-90\' prima: banana, pane e miele.', during: '400-600 ml/h se caldo. Opzionale 20-30 g carboidrati dopo 45\'.', post: 'Entro 60\': 20 g proteine + carboidrati.' };
  if (min < 150) return { pre: `Colazione 2-3h prima: ${kg ? Math.round(kg * 1.5) + ' g' : '1-2 g/kg'} di carboidrati.`, during: '30-60 g carboidrati/h dal 45\' (gel, datteri), 400-700 ml/h, sodio 300-500 mg/h. È il momento di testare la strategia gara.', post: `Entro 60': ${kg ? kg + ' g' : '1 g/kg'} carboidrati + 20-30 g proteine.` };
  return { pre: `Colazione 2-3h prima: ${kg ? `${kg * 2}-${kg * 3} g` : '2-3 g/kg'} di carboidrati, poche fibre.`, during: '60-90 g carboidrati/h (glucosio+fruttosio), 500-800 ml/h, sodio 500-800 mg/h. Stessi gel che userai in gara.', post: `Entro 30-60': ${kg ? kg + '-' + Math.round(kg * 1.2) + ' g' : '1-1,2 g/kg'} carboidrati + 25-30 g proteine, e pasto completo dopo 2h.` };
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
  { when: '-2/-1 giorni', what: 'Carico carboidrati 8-10 g/kg, poche fibre e grassi. 1,5-2 L acqua extra distribuiti.' },
  { when: 'Mattina gara', what: 'Colazione testata 3h prima, 500 ml acqua. Pettorale e gel preparati la sera prima.' },
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
    let status = 'planned';
    if (date === today) status = runMin ? 'done' : 'today';
    else if (date > today) status = 'planned';
    else if (planned) status = runMin >= plan.min * 0.8 ? 'done' : runMin >= plan.min * 0.4 ? 'partial' : 'missed';
    else status = runMin ? 'extra' : 'rest';
    days.push({ date, plan, done, runMin, km: done.filter(isRun).reduce((t, a) => t + a.dist_km, 0), status, trip: tripSet.get(date) || null });
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
      id: ++id, date: p.date, start: p.date + 'T07:15:00', name: (trip ? '🏨 ' : '') + p.title, type: trip && R() < 0.5 ? 'VirtualRun' : 'Run',
      dist_km: Math.round(((min * 60) / pace) * 100) / 100, moving_min: Math.round(min * 10) / 10, elapsed_min: Math.round(min + 3), elev: Math.round(R() * 60),
      avg_hr: hr, max_hr: hr + 12 + Math.round(R() * 10), speed, pace_s: Math.round(pace), cadence: 158 + Math.round(R() * 10), trainer: trip, desc: '',
      hist, decoupling: min >= 60 ? Math.round((3 + R() * 5 - prog * 2) * 10) / 10 : null,
    };
    if (R() < 0.7) { a.rpe = p.kind === 'quality' ? 7 : p.kind === 'long' ? 5 : 4; a.rpe_src = 'strava'; }
    activities.push(a);
  }
  const lastA = activities[activities.length - 1];
  const checkins = { [today]: { date: today, sleep: 3, energy: 3, soreness: 3, stress: 4, travel: tripSet.has(today), pain: { area: '', level: 0 } } };
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
  return { settings, plan, overrides: {}, activities, trips: { manual, ical: [] }, checkins, feed, weekly, strava: { connected: true, athlete: 'Demo' }, ai: true, serverToday: today, demo: true };
}
