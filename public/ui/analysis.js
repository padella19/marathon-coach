// Sezione "Analisi": selettore periodo, 8 KPI con sparkline, grafici (Chart.js), attività
import { E, S, $, esc, css, chip, spark, zbar, hash, reducedMotion, fmtKm, fmtNum } from './core.js';

const PERIODS = [['4', '4 sett.'], ['12', '12 sett.'], ['all', 'Tutto']];
const weeksN = () => (S.period === 'all' ? 520 : +S.period);

function head() {
  return `<div class="an-head"><h2>Analisi</h2>
    <div class="seg" role="group" aria-label="Periodo dei grafici">${PERIODS.map(([k, l]) => `<button type="button" data-a="period" data-k="${k}" aria-pressed="${S.period === k}">${l}</button>`).join('')}</div></div>`;
}

function kpis() {
  const { m, plannedKm, todayDate, compliance } = S.ctx;
  const band = E.acwrBand(m.acwr, m.calibrating);
  const pk = plannedKm(E.mondayOf(todayDate));
  const w8 = m.weeks.slice(-8);
  const weekly = (key) => w8.map((w) => { const x = m.series.filter((s) => s.date <= E.addDays(w.week, 6)).pop(); return x && !m.calibrating ? x[key] : null; });
  const zpct = (w) => { const t = w.z.reduce((a, b) => a + b, 0); return t ? ((w.z[0] + w.z[1]) / t) * 100 : null; };
  const efW = w8.map((w) => { const xs = m.efSeries.filter((x) => x.date >= w.week && x.date <= E.addDays(w.week, 6)); return xs.length ? xs.reduce((t, x) => t + x.ef, 0) / xs.length : null; });
  const formTone = m.form == null ? '' : m.form < -30 ? 'bad' : m.form < -10 ? 'warn' : 'good';
  const formLbl = m.form == null ? 'In calibrazione' : m.form < -30 ? 'Molto affaticato' : m.form < -10 ? 'Carico in assorbimento' : m.form > 10 ? 'Fresco' : 'Equilibrato';
  const monoTone = m.monotony > 2 ? 'bad' : m.monotony > 1.5 ? 'warn' : 'good';
  const polTone = m.polar == null ? '' : m.polar >= 80 ? 'good' : m.polar >= 70 ? 'warn' : 'bad';
  const T = (tone, label, v, small, d, sp = '') => `<div class="kpi" data-tone="${tone}"><span class="eyebrow">${label}</span><div class="kv"><b>${v}</b>${small ? `<small>${small}</small>` : ''}</div>${sp || '<span></span>'}<span class="kd">${d}</span></div>`;
  return `<div class="kpi8">${[
    T(m.week.km > pk * 1.15 && pk ? 'warn' : '', 'Volume settimana', fmtKm(m.week.km), `/ ~${pk.toFixed(0)} km`, `${m.week.runs} ${m.week.runs === 1 ? 'uscita' : 'uscite'} · scorsa ${m.prevWeek ? fmtKm(m.prevWeek.km) + ' km' : '—'}`, spark(w8.map((w) => w.km), { color: 'accent', min: 0, label: 'Km delle ultime 8 settimane' })),
    T(['good', 'warn', 'bad'].includes(band.tone) ? band.tone : '', 'ACWR', m.calibrating || m.acwr == null ? '—' : fmtNum(m.acwr), 'EWMA 7/28', `${chip(band.tone, band.label)}`, spark(weekly('acwr'), { band: [0.8, 1.3], min: 0.5, max: 1.7, label: 'ACWR delle ultime 8 settimane' })),
    T(formTone, 'Forma', m.form == null ? '—' : `${m.form > 0 ? '+' : ''}${m.form.toFixed(0)}%`, '', formLbl, spark(weekly('form'), { label: 'Forma delle ultime 8 settimane' })),
    T(monoTone, 'Monotonia 7 gg', fmtNum(m.monotony), `strain ${m.strain}`, m.monotony > 2 ? 'Allenamenti troppo uguali: varia' : 'Varietà di carico ok'),
    T(polTone, 'Z1-Z2 · 28 gg', m.polar == null ? '—' : `${m.polar.toFixed(0)}%`, '≥ 80%', m.polar == null ? 'Servono uscite con FC' : m.polar >= 80 ? 'Base aerobica protetta' : 'Rallenta le uscite facili', spark(w8.map(zpct), { color: 'lane', min: 50, max: 100, label: 'Quota di tempo facile, ultime 8 settimane' })),
    T(m.efTrend == null ? '' : m.efTrend >= 0 ? 'good' : 'warn', 'Efficienza aerobica', m.efNow ? fmtNum(m.efNow) : '—', 'm/min/bpm', m.efTrend == null ? 'Serve un mese di uscite facili' : `${m.efTrend >= 0 ? '+' : ''}${fmtKm(m.efTrend)}% in 4 settimane`, spark(efW, { color: 'accent', label: 'Efficienza aerobica, ultime 8 settimane' })),
    T(compliance == null ? '' : compliance >= 80 ? 'good' : compliance >= 60 ? 'warn' : 'bad', 'Aderenza · 4 sett.', compliance == null ? '—' : `${compliance}%`, '', 'Sessioni non facoltative completate'),
    T('', 'Lungo più lungo · 28 gg', m.longest28 ? E.fmtMin(m.longest28.moving_min) : '—', m.longest28 ? `${fmtKm(m.longest28.dist_km)} km` : '', m.longest28 ? `${E.fmtDate(m.longest28.date)} · ${E.fmtPace(m.longest28.pace_s)}` : 'Nessun lungo recente', spark(w8.map((w) => w.longMin || null), { color: 'accent', min: 0, label: 'Uscita più lunga per settimana' })),
  ].join('')}</div>`;
}

const CHARTS = [
  ['vol', 'Volume settimanale', 'Km corsi (barre) contro km stimati dal piano (linea).'],
  ['acwr', 'ACWR · rischio infortuni', 'Fascia verde 0,8-1,3. Sopra 1,5 il carico sale troppo in fretta.'],
  ['load', 'Carico giornaliero', 'Carico sessione (minuti × RPE), media acuta 7 gg e cronica 28 gg.'],
  ['zones', 'Zone FC per settimana', 'Quota di tempo per zona. In base aerobica Z1-Z2 almeno all\'80%.'],
  ['ef', 'Efficienza aerobica', 'Velocità per battito sulle uscite facili: se sale, il motore migliora.'],
  ['scatter', 'Passo vs FC', 'Ogni punto è un\'uscita; i più recenti sono più pieni. In basso a destra = più in forma.'],
];
const chartShells = () => `<div class="charts">${CHARTS.map(([id, t, p]) => `<div class="card chart-card"><h3>${t}</h3><p>${p}</p><div class="chart-box"><canvas id="ch-${id}" role="img" aria-label="${t}"></canvas></div></div>`).join('')}</div>`;

function activities() {
  const acts = [...S.ctx.m.acts].reverse().slice(0, S.narrow ? 12 : 20), hrp = S.ctx.m.hrp;
  const titleRow = '<div class="sec-t"><h2>Attività</h2></div>';
  if (!acts.length) return `${titleRow}<div class="empty" style="margin-top:14px">Ancora nessuna uscita. Appena registri con il Garmin, arriva qui da Intervals.icu nel giro di qualche minuto.</div>`;
  const rpeSel = (a) => { const r = E.rpeOf(a, hrp); return `<select data-rpe="${esc(a.id)}" aria-label="RPE di ${esc(a.name)}">${['', 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((v) => `<option value="${v}" ${(!r.est && r.v === v) ? 'selected' : ''}>${v === '' ? (r.est ? `~${r.v}` : '—') : v}</option>`).join('')}</select>`; };
  if (S.narrow) return `${titleRow}<div class="acts" style="margin-top:14px">${acts.map((a) => `<article class="act" data-act="${esc(a.id)}">
      <div class="act-h"><b>${esc(a.name)}</b><span>${E.DOW_IT[E.dow(a.date)]} ${E.fmtDate(a.date)} · ${E.fmtMin(a.moving_min)}</span></div>
      <label>RPE ${rpeSel(a)}</label>
      <div class="act-m">${E.isRun(a) ? `<span>${fmtKm(a.dist_km)}<small>km</small></span><span>${E.fmtPace(a.pace_s).replace('/km', '')}<small>/km</small></span>` : ''}${a.avg_hr ? `<span>${a.avg_hr}<small>bpm</small></span>` : ''}<span>${E.loadOf(a, hrp)}<small>carico</small></span></div>
      ${zbar(a)}</article>`).join('')}</div>`;
  return `${titleRow}<div class="card" style="margin-top:14px"><p class="muted small" style="margin-bottom:8px">RPE: sceglilo qui dopo ogni uscita, oppure compilalo su Intervals.icu. Clic su una riga per i parziali.</p>
  <div class="tbl-wrap"><table><thead><tr><th>Data</th><th>Uscita</th><th>Km</th><th>Tempo</th><th>Passo</th><th>FC</th><th>Zone</th><th>RPE</th><th>Carico</th><th>Deriva</th></tr></thead><tbody>
  ${acts.map((a) => `<tr class="click" data-act="${esc(a.id)}">
    <td class="n">${E.fmtDate(a.date)}</td><td><span class="nm" title="${esc(a.name)}">${esc(a.name)}</span></td>
    <td class="n">${E.isRun(a) ? fmtKm(a.dist_km) : '—'}</td><td class="n">${E.fmtMin(a.moving_min)}</td><td class="n">${E.isRun(a) ? E.fmtPace(a.pace_s) : '—'}</td>
    <td class="n">${a.avg_hr || '—'}</td><td>${zbar(a)}</td><td>${rpeSel(a)}</td>
    <td class="n">${E.loadOf(a, hrp)}</td><td class="n">${a.decoupling != null ? fmtKm(a.decoupling) + '%' : '—'}</td></tr>`).join('')}
  </tbody></table></div></div>`;
}

export function units() {
  return [
    { id: 'anhead', html: head() },
    { id: 'kpi8', html: kpis() },
    { id: 'charts', html: chartShells() },
    { id: 'acts', html: activities() },
  ];
}

// ---------------------------------------------------------------- Grafici
export function destroyCharts() { Object.values(S.charts).forEach((c) => c.destroy()); S.charts = {}; S.chartSig = null; }
const chartSig = () => `${hash(JSON.stringify([S.data.activities, S.data.overrides, S.ctx.settings]))}|${S.data.plan?.length}|${S.ctx.todayDate}|${S.period}|${document.documentElement.dataset.theme || 'auto'}|${matchMedia('(prefers-color-scheme: dark)').matches}`;

// first = true quando la sezione è appena stata aperta: solo allora c'è una leggera animazione
export function syncCharts(first) {
  if (!window.Chart || !$('#ch-vol')) return;
  const sig = chartSig();
  if (sig === S.chartSig && S.charts.vol?.canvas?.isConnected) return;
  S.chartSig = sig;
  Object.values(S.charts).forEach((c) => c.destroy()); S.charts = {};
  draw(first && !reducedMotion());
}

function draw(animate) {
  const { m, plannedKm, todayDate } = S.ctx;
  const ink = css('--ink'), ink2 = css('--ink-2'), grid = css('--line'), acc = css('--accent'), lane = css('--lane'), surf = css('--surface-3');
  const mono = css('--f-mono'), body = css('--f-body');
  Chart.defaults.color = ink2; Chart.defaults.font.family = mono; Chart.defaults.font.size = 11; Chart.defaults.borderColor = grid;
  const tooltip = { backgroundColor: surf, titleColor: ink, bodyColor: ink, borderColor: css('--line-2'), borderWidth: 1, padding: 10, cornerRadius: 8, boxPadding: 4, usePointStyle: true, titleFont: { family: body, weight: '600', size: 12 }, bodyFont: { family: mono, size: 12 } };
  const legend = { labels: { boxWidth: 8, boxHeight: 8, usePointStyle: true, pointStyle: 'rectRounded', font: { family: body, size: 12 }, color: ink2 } };
  const xAxis = (extra = {}) => ({ grid: { display: false }, border: { color: grid }, ticks: { maxTicksLimit: 6, maxRotation: 0, autoSkipPadding: 12 }, ...extra });
  const yAxis = (extra = {}) => ({ grid: { color: grid, drawTicks: false }, border: { display: false }, ticks: { padding: 8, maxTicksLimit: 5 }, beginAtZero: true, ...extra });
  const base = { responsive: true, maintainAspectRatio: false, animation: animate ? { duration: 450, easing: 'easeOutCubic' } : false, interaction: { mode: 'index', intersect: false }, plugins: { legend, tooltip } };
  const N = weeksN(), fromDate = E.addDays(todayDate, -N * 7);
  const fmtW = (w) => E.fmtDate(w);

  // 1 · Volume: settimane del periodo + 3 future pianificate
  const weeks = m.weeks.slice(-Math.min(N, 26));
  const labels = weeks.map((w) => w.week);
  for (let i = 1; i <= 3; i++) labels.push(E.addDays(E.mondayOf(todayDate), 7 * i));
  S.charts.vol = new Chart($('#ch-vol'), { data: { labels: labels.map(fmtW), datasets: [
    { type: 'bar', label: 'Eseguiti', data: labels.map((w) => m.weeks.find((x) => x.week === w)?.km ?? null), backgroundColor: acc, borderRadius: 6, borderSkipped: false, maxBarThickness: 26 },
    { type: 'line', label: 'Piano (stima)', data: labels.map((w) => Math.round(plannedKm(w) * 10) / 10), borderColor: lane, backgroundColor: lane, borderDash: [5, 4], borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: 0.3 },
  ] }, options: { ...base, scales: { x: xAxis({ ticks: { maxTicksLimit: 8, maxRotation: 0 } }), y: yAxis({ title: { display: true, text: 'km', color: ink2 } }) } } });

  // 2-3 · ACWR e carico (giorni del periodo, al massimo 180)
  const ser = m.series.filter((x) => x.date > fromDate).slice(-180);
  const bands = { id: 'bands', beforeDatasetsDraw(c) {
    const { ctx, chartArea: a, scales: { y } } = c; if (!a) return;
    const fill = (lo, hi, col) => { const top = y.getPixelForValue(Math.min(hi, y.max)), bot = y.getPixelForValue(Math.max(lo, y.min)); if (bot <= top) return; ctx.fillStyle = col; ctx.fillRect(a.left, top, a.right - a.left, bot - top); };
    ctx.save(); ctx.globalAlpha = 0.14; fill(0.8, 1.3, css('--good')); fill(1.3, 1.5, css('--warn')); fill(1.5, 9, css('--bad')); ctx.restore();
  } };
  const calFrom = m.calibrating ? '9999' : E.addDays(m.acts[0]?.date || todayDate, 21);
  S.charts.acwr = new Chart($('#ch-acwr'), { type: 'line', plugins: [bands], data: { labels: ser.map((x) => E.fmtDate(x.date)), datasets: [
    { label: 'ACWR', data: ser.map((x) => (x.date >= calFrom && x.acwr != null ? Math.round(x.acwr * 100) / 100 : null)), borderColor: ink, backgroundColor: ink, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: 0.25, spanGaps: true },
  ] }, options: { ...base, plugins: { legend: { display: false }, tooltip }, scales: { x: xAxis(), y: yAxis({ min: 0, max: 2, ticks: { padding: 8, stepSize: 0.5 } }) } } });

  S.charts.load = new Chart($('#ch-load'), { data: { labels: ser.map((x) => E.fmtDate(x.date)), datasets: [
    { type: 'bar', label: 'Carico', data: ser.map((x) => x.load || null), backgroundColor: css('--z1'), borderRadius: 3, borderSkipped: false, maxBarThickness: 8 },
    { type: 'line', label: 'Acuto 7 gg', data: ser.map((x) => Math.round(x.acute)), borderColor: acc, backgroundColor: acc, pointRadius: 0, pointHoverRadius: 4, borderWidth: 2, tension: 0.3 },
    { type: 'line', label: 'Cronico 28 gg', data: ser.map((x) => Math.round(x.chronic)), borderColor: lane, backgroundColor: lane, pointRadius: 0, pointHoverRadius: 4, borderWidth: 2, borderDash: [5, 4], tension: 0.3 },
  ] }, options: { ...base, scales: { x: xAxis(), y: yAxis() } } });

  // 4 · Zone
  const zw = m.weeks.slice(-Math.min(N, 26));
  S.charts.zones = new Chart($('#ch-zones'), { type: 'bar', data: { labels: zw.map((w) => fmtW(w.week)), datasets: [0, 1, 2, 3, 4].map((i) => ({
    label: `Z${i + 1}`, data: zw.map((w) => { const t = w.z.reduce((a, b) => a + b, 0); return t ? Math.round((w.z[i] / t) * 100) : 0; }), backgroundColor: css(`--z${i + 1}`), maxBarThickness: 28, borderRadius: i === 4 ? 4 : 0,
  })) }, options: { ...base, scales: { x: xAxis({ stacked: true, ticks: { maxTicksLimit: 8, maxRotation: 0 } }), y: yAxis({ stacked: true, max: 100, ticks: { padding: 8, stepSize: 25, callback: (v) => v + '%' } }) } } });

  // 5 · Efficienza
  const ef = m.efSeries.filter((x) => x.date > fromDate).slice(-80);
  S.charts.ef = new Chart($('#ch-ef'), { type: 'line', data: { labels: ef.map((x) => E.fmtDate(x.date)), datasets: [
    { label: 'Efficienza', data: ef.map((x) => x.ef), borderColor: acc, backgroundColor: css('--accent-soft'), fill: true, borderWidth: 2, pointRadius: ef.length > 30 ? 0 : 2.5, pointBackgroundColor: acc, pointHoverRadius: 4, tension: 0.3 },
  ] }, options: { ...base, plugins: { legend: { display: false }, tooltip }, scales: { x: xAxis(), y: yAxis({ beginAtZero: false }) } } });

  // 6 · Passo vs FC
  const sc = m.scatter.filter((p) => p.date > fromDate).slice(-120), n = sc.length || 1;
  S.charts.scatter = new Chart($('#ch-scatter'), { type: 'scatter', data: { datasets: [{ label: 'Uscite', data: sc.map((p) => ({ x: p.x, y: p.y, name: p.name, date: p.date })), pointRadius: 4.5, pointHoverRadius: 6, borderWidth: 0,
    backgroundColor: sc.map((_, i) => (lane.startsWith('#') && lane.length === 7 ? lane + Math.round(70 + (185 * (i + 1)) / n).toString(16).padStart(2, '0') : lane)) }] },
    options: { ...base, interaction: { mode: 'nearest', intersect: true }, plugins: { legend: { display: false }, tooltip: { ...tooltip, callbacks: { title: (c) => c[0]?.raw?.name || '', label: (c) => `${E.fmtDate(c.raw.date)} · ${E.fmtPace(c.raw.x)} · ${c.raw.y} bpm` } } },
      scales: { x: xAxis({ reverse: true, title: { display: true, text: 'passo (min/km)', color: ink2 }, ticks: { maxTicksLimit: 6, callback: (v) => E.fmtPace(v).replace('/km', '') } }), y: yAxis({ beginAtZero: false, title: { display: true, text: 'FC media', color: ink2 } }) } } });
}
