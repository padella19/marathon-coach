// Sezione "Oggi": testata gara, sessione del giorno, alimentazione, prossimi 7 giorni, 3 KPI, ultimo feedback
import { E, J, S, esc, ico, chip, spark, feedItem, KIND_IT, RUN_KINDS, zoneRange, kmEst, dayNum, fmtKm, fmtNum } from './core.js';
import { chatMini, reportCard, statusLine } from './coach.js';
import { strengthBlock } from './dialogs.js';

// 1 · Striscia della preparazione (direzione D): fase e settimana · barra per fasi · giorni alla gara
function raceHead() {
  const { todayDate, settings, ph } = S.ctx;
  const f = E.planFrame(settings), total = f.total + 1;
  const toRace = E.diffDays(todayDate, settings.raceDate), toStart = E.diffDays(todayDate, settings.planStart);
  const pre = ph.id === 'pre', post = ph.id === 'post';
  const [y, mo, d] = settings.raceDate.split('-');
  const cur = pre ? 0 : post ? total : E.clamp(E.diffDays(f.w0, todayDate) / 7, 0, total);
  const pct = (cur / total) * 100;
  const segs = f.ph.map((p) => ({ ...p, weeks: p.to - p.from + 1, fill: E.clamp((cur - p.from) / (p.to - p.from + 1), 0, 1) }));
  const left = pre ? `<b>Pre-partenza</b> <span class="mono">via il ${E.fmtDate(settings.planStart)}</span>`
    : post ? '<b>Post-gara</b>' : `<b>${esc(ph.name)}</b> <span class="mono">sett. ${ph.week}/${ph.total}</span>${ph.rec ? ' ' + chip('info', 'scarico') : ''}`;
  const n = post ? 0 : pre ? toStart : toRace;
  const right = post ? 'gara fatta' : `<b class="cd">${n}</b> ${pre ? (n === 1 ? 'giorno al via' : 'giorni al via') : n === 0 ? 'è oggi' : n === 1 ? 'giorno' : 'giorni'}<span class="rn"> · ${esc(settings.raceName)} ${d}.${mo}.${y}</span>`;
  return `<section class="prep-strip" aria-label="Avanzamento verso la gara: ${Math.round(pct)}%">
    <span class="ps-l">${left}</span>
    <div class="prep-bar" role="img" aria-label="Preparazione al ${Math.round(pct)}%">${segs.map((s) => `<div class="prep-seg" style="flex:${s.weeks}" title="${esc(s.name)} · ${s.weeks} settimane"><i style="width:${(s.fill * 100).toFixed(1)}%"></i></div>`).join('')}</div>
    <span class="ps-r">${right}</span>
    <div class="prep-lbl" aria-hidden="true">${segs.map((s) => `<span style="flex:${s.weeks}" ${s.id === ph.id ? 'data-on' : ''}>${esc(s.name)}</span>`).join('')}</div>
  </section>`;
}

// Stato dell'invio al Garmin (lo scrive il Worker quando sincronizza il calendario di intervals.icu)
function garminBadge(date) {
  const g = S.data.garmin?.days?.[date];
  if (!g) return '';
  return g.status === 'ok' ? `<span class="chip" data-tone="muted" title="Workout inviato al Garmin tramite intervals.icu">${ico('watch')}su Garmin ✓</span>`
    : `<span class="chip" data-tone="warn" title="${esc(g.msg || '')}">${ico('watch')}Non inviato</span>`;
}

// In pausa: niente sessione, solo lo stato e il rientro
function pauseCard(p) {
  const { todayDate } = S.ctx;
  const late = p.to && p.to < todayDate;
  return `<article class="card today paused" aria-label="In pausa">
    <div class="today-top"><span class="eyebrow">Oggi · ${E.DOW_IT_LONG[E.dow(todayDate)]} ${E.fmtDate(todayDate)}</span><span class="chips">${chip('muted', 'In pausa', 'pause')}</span></div>
    <h2 class="session-title">Pausa</h2>
    <p class="desc">${esc(E.PAUSE_REASONS[p.reason] || 'Pausa')} dal ${E.fmtDate(p.from)}${p.to ? ` · rientro previsto ${E.fmtDate(p.to)}` : ''}${p.note ? ` · ${esc(p.note)}` : ''}. I giorni di pausa non contano come saltati.</p>
    ${late ? '<p class="small" style="margin-top:8px"><b>Il rientro previsto è passato.</b> Come va?</p>' : ''}
    <div class="actions" style="margin-top:14px"><button class="btn primary lg" data-a="resume" data-id="${esc(p.id)}" type="button">Riprendo</button></div>
  </article>`;
}

// Check-up: il coach ha delle domande (le risposte passano dalla dashboard)
function reviewAsk() {
  const r = S.data.review || {};
  if (r.status !== 'questions') return '';
  if (r.answeredAt) return `<section class="card ask-rev done"><span class="eyebrow">Check-up</span><p><b>Risposte inviate.</b> José ricalibra il piano al prossimo giro. <button class="btn sm ghost" data-a="review-open" type="button">Modifica le risposte</button></p></section>`;
  return `<section class="card ask-rev"><span class="eyebrow">Check-up di José</span>
    <h3>José vuole fare il punto</h3>
    <p class="muted">${esc(r.intro || (r.reasons || []).map((x) => x.label).join(' · '))}</p>
    <button class="btn primary lg" data-a="review-open" type="button">Rispondi · ${(r.questions || []).length} domande</button></section>`;
}

// Domanda dei 2 giorni prima: cosa trovi in trasferta?
function facilitiesAsk() {
  const { todayDate } = S.ctx;
  const t = E.allTrips(S.data.trips).find((x) => x.start >= todayDate && x.start <= E.addDays(todayDate, 2) && !x.facilities);
  if (!t) return '';
  const when = t.start === todayDate ? 'da oggi' : t.start === E.addDays(todayDate, 1) ? 'da domani' : `da ${E.DOW_IT_LONG[E.dow(t.start)].toLowerCase()}`;
  return `<section class="card ask-fac" data-trip="${esc(t.key)}" data-city="${esc(E.tripName(t))}">
    <span class="eyebrow">${t.type === 'vacation' ? 'Vacanza' : 'Trasferta'} ${when}</span>
    <h3>${t.type === 'vacation' ? 'In vacanza' : 'A'} ${esc(E.tripName(t))} cosa hai a disposizione?</h3>
    ${E.tripDetail(t) ? `<p class="small muted">${esc(E.tripDetail(t))} · ${E.fmtDate(t.start)}</p>` : ''}
    <p class="small muted">Lo chiedo una volta sola: la prossima volta che torni qui lo so già.</p>
    <div class="fac-chips">${Object.entries(E.FACILITIES).map(([k, l]) => `<button class="pill" type="button" data-a="fac" data-k="${k}" aria-pressed="false">${l}</button>`).join('')}<button class="pill" type="button" data-a="fac" data-k="unknown" aria-pressed="false">Non lo so</button></div>
    <button class="btn primary" data-a="fac-save" type="button">Salva</button>
  </section>`;
}

// 2 · Sessione di oggi + anello Readiness
function sessionCard() {
  if (S.ctx.pause) return pauseCard(S.ctx.pause);
  const { todayDate, m, tripSet, ph } = S.ctx, { ci, ready, planned, adapted } = S.ctx.today;
  const s = adapted.session, trip = tripSet.get(todayDate);
  const range = s ? zoneRange(s.zone, m.hrp) : null;
  const km = s ? kmEst(s.min, s.kind) : 0;
  const isRunS = s && RUN_KINDS.includes(s.kind);
  const chips = [
    s ? chip('accent', (KIND_IT[s.kind] || s.kind) + (s.optional ? ' · facoltativa' : '')) : '',
    trip ? chip('info', `Trasferta · ${trip}`, 'bag') : '',
    adapted.changes.length ? chip(adapted.level === 'red' ? 'bad' : 'warn', 'Adattata') : planned ? chip('good', 'Da piano') : '',
    S.ctx.vacSet.get(todayDate) ? chip('info', `Vacanza · ${S.ctx.vacSet.get(todayDate)}`, 'sunb') : '',
    garminBadge(todayDate),
  ].join('');
  const body = s ? `<h2 class="session-title">${esc(s.title)}</h2>
      <dl class="meta">
        ${s.min ? `<div><dt>Durata</dt><dd>${E.fmtMin(s.min)}</dd></div>` : ''}
        ${isRunS && km ? `<div><dt>Stima</dt><dd>~${fmtKm(km)}<small>km</small></dd></div>` : ''}
        ${s.rpe && s.rpe !== '-' ? `<div><dt>RPE</dt><dd>${esc(s.rpe)}</dd></div>` : ''}
        ${range ? `<div><dt>FC ${esc(s.zone)}</dt><dd>${range}<small>bpm</small></dd></div>` : ''}
        ${s.strength ? `<div><dt>Forza</dt><dd>Routine ${s.strength}</dd></div>` : ''}
      </dl>
      <p class="desc">${esc(s.desc)}${s.tripNote ? ' ' + esc(s.tripNote) : ''}</p>`
    : `<h2 class="session-title">${ph.id === 'pre' ? `Si parte il ${E.fmtDate(S.ctx.settings.planStart)}` : 'Giornata libera'}</h2><p class="desc">${esc(ph.focus)}</p>`;
  const canSkip = planned && E.RUN_KINDS.includes(planned.kind) && !S.ctx.m.acts.some((a) => a.date === todayDate && E.isRun(a));
  return `<article class="card today" aria-label="Sessione di oggi">
    <div class="today-top"><span class="eyebrow">Oggi · ${E.DOW_IT_LONG[E.dow(todayDate)]} ${E.fmtDate(todayDate)}</span><span class="chips">${chips}</span></div>
    ${body}
    <div class="ready-c" data-tone="${ready.tone}"><b class="mono" aria-label="Readiness ${ready.score} su 100">${ready.score}</b>
      <span class="rc-t"><span class="eyebrow">Readiness</span><span class="factors">${ci ? (ready.factors.length ? esc(ready.factors.join(' · ')) : 'Nessun segnale di fatica') : 'Stima dai dati: manca il check-in'}</span></span>
      <button class="btn sm ${ci ? '' : 'primary'}" data-a="checkin" type="button">${ico('clip')}${ci ? 'Aggiorna' : 'Check-in · 4 tocchi'}</button></div>
    ${adapted.changes.length ? `<ul class="changes" data-level="${adapted.level}">${adapted.changes.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}
    ${meteoLines()}
    ${S.data.garmin?.todayUpdatedAt && S.data.garmin?.todayDate === todayDate ? `<p class="garmin-note">${ico('watch')}La sessione di oggi è cambiata dopo l'invio: apri Garmin Connect sul telefono per aggiornare l'orologio.</p>` : ''}
    ${strengthBlock(todayDate, s, true)}
    ${fuelPills()}
    <div class="today-foot">${canSkip ? '<button class="btn sm" data-a="skip" data-date="' + todayDate + '" type="button">Non riesco</button>' : ''}<button class="btn sm ghost" data-a="pause" type="button">${ico('pause')}Mi fermo</button></div>
  </article>`;
}

// Meteo di oggi e domani nella città dove sei (trasferta o casa): condizioni, min/max,
// fascia oraria preferita, ora migliore e ore della giornata (apribili)
function meteoLines() {
  const { todayDate, settings } = S.ctx, days = S.data.meteo?.days || {};
  const r = (v) => Math.round(v);
  const line = (d, lbl) => {
    const x = days[d]; if (!x) return '';
    const v = J.weatherVerdict(x, settings.coldFeelsC ?? 5);
    const where = x.trasferta ? ' <span class="wx-tag">trasferta</span>' : x.vacanza ? ' <span class="wx-tag">vacanza</span>' : '';
    const day = x.day ? ` · ${x.day.cond ? esc(x.day.cond) + ', ' : ''}${x.day.min != null ? `min ${r(x.day.min)}° max ${r(x.day.max)}°` : ''}${x.day.rain_sum ? ` · ${x.day.rain_sum.toFixed(1).replace('.', ',')} mm` : ''}` : '';
    const hours = (x.hours || []).filter((h) => h.hour % 2 === 0);
    return `<div class="meteo" data-bad="${v.bad}">${ico('sunb')}<div class="wx-b">
      <p class="wx-h"><b>${lbl} · ${esc(x.city)}</b>${where}${day}</p>
      <p>Alle ${x.hour}:00 ${r(x.temp)} °C, percepiti ${r(x.feels)} °C${x.cond ? ', ' + esc(x.cond) : ''}${x.rain_prob != null ? ` · pioggia ${x.rain_prob}%` : ''} · vento ${r(x.wind)} km/h.${v.consiglio ? ' ' + esc(v.consiglio) : !v.bad && x.best && x.best.hour !== x.hour ? ` Ora migliore: ${x.best.hour}:00.` : ''}</p>
      ${hours.length ? `<details class="wx-more"><summary>Ora per ora</summary><div class="wx-hours" role="list">${hours.map((h) => `<div role="listitem" title="${esc(h.hour + ':00 · percepiti ' + r(h.feels) + ' °C' + (h.rain_prob != null ? ' · pioggia ' + h.rain_prob + '%' : '') + ' · vento ' + r(h.wind) + ' km/h')}"><span>${h.hour}</span><b>${r(h.temp)}°</b><small>${h.rain_prob != null && h.rain_prob >= 20 ? h.rain_prob + '%' : '&nbsp;'}</small></div>`).join('')}</div></details>` : ''}
    </div></div>`;
  };
  return line(todayDate, 'Oggi') + line(E.addDays(todayDate, 1), 'Domani');
}

// 3 · Cosa mangiare: tre pillole apribili
function fuelPills() {
  const s = S.ctx.today.adapted.session, toRace = E.diffDays(S.ctx.todayDate, S.ctx.settings.raceDate);
  const f = E.fueling(s, S.ctx.settings, toRace);
  const items = [['pre', 'Prima', f.pre], ['during', 'Durante', f.during], ['post', 'Dopo', f.post]].filter((x) => x[2]);
  if (!items.length) return '';
  const open = items.find((x) => x[0] === S.fuelOpen);
  return `<div class="fuel-in"><span class="eyebrow">Cosa mangiare</span>
    <div class="fuel-pills">${items.map(([k, l]) => `<button class="pill" type="button" data-a="fuel" data-k="${k}" aria-expanded="${open?.[0] === k}" aria-controls="fuelPanel">${l}${ico('down')}</button>`).join('')}</div>
    ${open ? `<div class="fuel-panel" id="fuelPanel"><b>${open[1]}.</b> ${esc(open[2])}<br><span class="muted"><b>Perché:</b> ${esc(f.why[open[0]] || '')}</span><br><span class="small muted">${esc(f.note)}</span></div>` : ''}</div>`;
}

// 4 · Prossimi 7 giorni
function next7() {
  const { todayDate, pIdx, tripSet } = S.ctx;
  const cells = [];
  for (let i = 0; i < 7; i++) {
    const d = E.addDays(todayDate, i), p = i === 0 ? S.ctx.today.adapted.session : E.effective(d, pIdx, S.ctx.base.overrides), trip = tripSet.get(d) || S.ctx.vacSet.get(d);
    const dur = !p || p.kind === 'rest' || p.kind === 'pause' ? '<span class="dm off">—</span>' : p.kind === 'race' ? '<span class="dm">42K</span>' : `<span class="dm">${p.min ? E.fmtMin(p.min) : '·'}</span>`;
    const lbl = `${E.DOW_IT_LONG[E.dow(d)]} ${E.fmtDate(d)}: ${p ? p.title + (p.min ? ', ' + E.fmtMin(p.min) : '') : 'nessuna sessione'}${trip ? ', trasferta ' + trip : ''}`;
    cells.push(`<button type="button" data-day="${d}" data-k="${p?.kind || ''}" class="${i === 0 ? 'is-today' : ''}" aria-label="${esc(lbl)}" title="${esc(p?.title || 'Nessuna sessione')}">
      <span class="dw">${E.DOW_IT[E.dow(d)]}</span><span class="dn">${dayNum(d)}</span><i class="kb"></i>${dur}<span class="dt">${S.ctx.vacSet.get(d) ? ico('sunb') : trip ? ico('bag') : ''}</span></button>`);
  }
  return `<div class="sec-t"><h2>La settimana</h2><a class="more" href="#settimana">Dettaglio</a></div><div class="d7" style="margin-top:14px">${cells.join('')}</div>`;
}

// 5 · Tre KPI essenziali con sparkline
function kpi3() {
  const { m, plannedKm, todayDate } = S.ctx;
  const pk = plannedKm(E.mondayOf(todayDate));
  const band = E.acwrBand(m.acwr, m.calibrating);
  const w8 = m.weeks.slice(-8);
  const zpct = (w) => { const t = w.z.reduce((a, b) => a + b, 0); return t ? ((w.z[0] + w.z[1]) / t) * 100 : null; };
  const volTone = pk && m.week.km > pk * 1.15 ? 'warn' : '';
  const polTone = m.polar == null ? '' : m.polar >= 80 ? 'good' : m.polar >= 70 ? 'warn' : 'bad';
  const acwrSer = m.series.slice(-28).map((x) => (m.calibrating ? null : x.acwr));
  return `<div class="kpi3">
    <div class="kpi" data-tone="${volTone}"><span class="eyebrow">Volume settimana</span>
      <div class="kv"><b>${fmtKm(m.week.km)}</b><small>/ ~${pk.toFixed(0)} km</small></div>${spark(w8.map((w) => w.km), { color: 'accent', min: 0, label: 'Km delle ultime 8 settimane' })}
      <div class="bar" role="img" aria-label="${pk ? Math.round((m.week.km / pk) * 100) : 0}% del volume pianificato"><i style="width:${pk ? Math.min(100, (m.week.km / pk) * 100).toFixed(0) : 0}%"></i></div>
      <span class="kd">${m.week.runs} ${m.week.runs === 1 ? 'uscita' : 'uscite'} · scorsa ${m.prevWeek ? fmtKm(m.prevWeek.km) + ' km' : '—'}</span></div>
    ${m.calibrating || m.acwr == null ? `<div class="kpi"><span class="eyebrow">Uscite questa settimana</span>
      <div class="kv"><b>${m.week.runs}</b><small>${m.week.runs === 1 ? 'uscita' : 'uscite'}</small></div>${spark(w8.map((w) => w.runs), { color: 'lane', min: 0, label: 'Uscite delle ultime 8 settimane' })}
      <span class="kd">L'ACWR si calcola dopo 3 settimane di dati</span></div>`
    : `<div class="kpi" data-tone="${band.tone === 'muted' || band.tone === 'info' ? '' : band.tone}"><span class="eyebrow">ACWR · carico acuto/cronico</span>
      <div class="kv"><b>${fmtNum(m.acwr)}</b></div>${spark(acwrSer, { band: [0.8, 1.3], min: 0.5, max: 1.7, label: 'ACWR degli ultimi 28 giorni, fascia ottimale evidenziata' })}
      <span class="kd">${chip(band.tone, band.label)} ottimale 0,8-1,3</span></div>`}
    <div class="kpi" data-tone="${polTone}"><span class="eyebrow">Z1-Z2 · 28 giorni</span>
      <div class="kv"><b>${m.polar == null ? '—' : m.polar.toFixed(0) + '%'}</b><small>target ≥ 80%</small></div>${spark(w8.map(zpct), { color: 'lane', min: 50, max: 100, label: 'Quota di tempo facile nelle ultime 8 settimane' })}
      <span class="kd">${m.polar == null ? 'Servono uscite con la FC registrata' : m.polar >= 80 ? 'Base aerobica protetta' : 'Rallenta le uscite facili'}</span></div>
  </div>`;
}

// Messaggi di José: stato, domande aperte, report del lunedì, ultimo commento e chat
function joseBlock() {
  const d = S.data, f = (d.feed || []).find((x) => !x.superseded && x.kind !== 'system');
  const rep = Object.values(d.reports || {}).sort((a, b) => b.ts - a.ts)[0];
  const freshRep = rep && Date.now() - rep.ts < 3 * 864e5 && !S.demo ? rep : S.demo ? rep : null;
  return `<div class="sec-t"><h2>José</h2><a class="more" href="#coach">Apri la chat</a></div>
    <p class="jose-st small">${statusLine()}</p>
    ${reviewAsk()}${facilitiesAsk()}
    ${freshRep ? reportCard(freshRep, true) : ''}
    ${S.wide ? '' : chatMini()}
    ${f ? `<div class="feed" style="margin-top:12px">${feedItem(f)}</div>` : ''}`;
}
// Progressi verso la gara: striscia delle fasi, previsione (se c'è un test) e tre indicatori
function progress() {
  const t = [...(S.data.tests || [])].pop(), p = t?.previsione;
  return `<div class="sec-t"><h2>Verso la gara</h2><a class="more" href="#gara">Area gara</a></div>
    <div style="margin-top:14px">${raceHead()}</div>
    ${p ? `<p class="pred-line">Previsione maratona <b class="mono">${J.fmtHMS(p.sec)}</b> <span class="muted">(${J.fmtHMS(p.lo)}–${J.fmtHMS(p.hi)}, dal test del ${E.fmtDate(t.date)})</span> · l'obiettivo resta finirla.</p>` : ''}
    ${kpi3()}<a class="more-kpi" href="#analisi">Badge, test, scarpe e grafici in Progressi →</a>`;
}

// Ordine della home: sessione di oggi → messaggi di José → settimana → progressi verso la gara
export function units() {
  return [
    { id: 'session', html: sessionCard() },
    { id: 'jose', html: joseBlock(), cls: 'u-jose' },
    { id: 'lanes', html: '<div class="lanes" aria-hidden="true"></div>' },
    { id: 'next7', html: next7() },
    { id: 'progress', html: progress() },
  ];
}
