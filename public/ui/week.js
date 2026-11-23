// Sezione "Settimana": riepilogo, 7 giorni pianificato vs eseguito, trasferte
import { E, S, esc, ico, chip, ago, STATUS, RUN_KINDS, fmtKm } from './core.js';

const monday = () => E.addDays(E.mondayOf(S.ctx.todayDate), S.weekOff * 7);

function head(days, mon) {
  const { m, plannedKm, settings } = S.ctx;
  const sun = E.addDays(mon, 6), ph = E.phaseAt(mon > settings.raceDate ? settings.raceDate : mon, settings);
  const km = days.reduce((t, d) => t + d.km, 0), pk = plannedKm(mon);
  const sess = days.filter((d) => d.plan && RUN_KINDS.includes(d.plan.kind) && !d.plan.optional);
  const done = sess.filter((d) => d.status === 'done').length;
  let easySec = 0;
  days.forEach((d) => d.done.filter(E.isRun).forEach((a) => { const z = E.zoneSeconds(a, m.hrp); easySec += z[0] + z[1]; }));
  const rel = S.weekOff === 0 ? 'Questa settimana' : S.weekOff === -1 ? 'Settimana scorsa' : S.weekOff === 1 ? 'Prossima settimana' : S.weekOff < 0 ? `${-S.weekOff} settimane fa` : `Tra ${S.weekOff} settimane`;
  return `<section class="card wk-head">
    <div class="wk-nav"><h2>${E.fmtDate(mon)} – ${E.fmtDate(sun)}<small>${rel} · ${esc(ph.name)}${ph.week ? ` · sett. ${ph.week}/${ph.total}` : ''}${ph.rec ? ' · scarico' : ''}</small></h2>
      ${S.weekOff !== 0 ? '<button class="btn sm" type="button" data-a="week" data-d="0">Oggi</button>' : ''}
      <button class="icon-btn" type="button" data-a="week" data-d="-1" aria-label="Settimana precedente">${ico('left')}</button>
      <button class="icon-btn" type="button" data-a="week" data-d="1" aria-label="Settimana successiva">${ico('right')}</button></div>
    <div class="wk-stats">
      <div class="stat"><b>${fmtKm(km)}<small> / ~${pk.toFixed(0)}</small></b><span>km fatti / piano</span></div>
      <div class="stat"><b>${done}<small> / ${sess.length}</small></b><span>sessioni di corsa</span></div>
      <div class="stat"><b>${Math.round(easySec / 60)}<small> min</small></b><span>in Z1-Z2</span></div>
    </div></section>`;
}

function list(days) {
  return `<div class="wk">${days.map((d) => {
    const p = d.plan, st = STATUS[d.status], runs = d.done.filter(E.isRun);
    const isToday = d.date === S.ctx.todayDate;
    return `<button class="wd ${isToday ? 'is-today' : ''}" data-day="${d.date}" data-k="${p?.kind || ''}" type="button" ${isToday ? 'aria-current="date"' : ''}>
      <div class="wd-date"><b>${E.DOW_IT[E.dow(d.date)]}</b><span>${E.fmtDate(d.date)}</span></div>
      <i class="kb"></i>
      <div class="wd-main">
        <div class="wd-title">${p ? esc(p.title) : 'Nessuna sessione'}${p?.override ? chip('warn', 'modificata') : ''}</div>
        ${p && p.min ? `<div class="wd-plan">${E.fmtMin(p.min)} · RPE ${esc(p.rpe)}${p.strength ? ' · forza ' + p.strength : ''}${p.optional ? ' · facoltativa' : ''}</div>` : p?.strength ? `<div class="wd-plan">forza ${p.strength}${p.kind === 'rest' ? ' facoltativa' : ''}</div>` : ''}
        ${runs.map((a) => `<div class="wd-done">${fmtKm(a.dist_km)} km · ${E.fmtPace(a.pace_s)}${a.avg_hr ? ' · ' + a.avg_hr + ' bpm' : ''}</div>`).join('')}
        ${st || d.trip || d.vacation || (d.str && !d.str.main && (d.str.done || !d.str.optional)) ? `<div class="wd-tags">${st && !(d.status === 'today') ? chip(st[1], st[0]) : ''}${d.str && !d.str.main && d.date <= S.ctx.todayDate && (d.str.done || !d.str.optional) ? chip(d.str.done ? 'good' : 'muted', `forza ${d.str.routine} ${d.str.done ? 'fatta' : d.date < S.ctx.todayDate ? 'non segnata' : 'da fare'}`) : ''}${d.trip ? chip('info', d.trip, 'bag') : ''}${d.vacation ? chip('info', 'Vacanza · ' + d.vacation, 'sunb') : ''}</div>` : ''}
      </div></button>`;
  }).join('')}</div>`;
}

function trips() {
  const { todayDate, tripSet, base } = S.ctx;
  const cells = [];
  let n = 0;
  for (let i = 0; i < 14; i++) {
    const d = E.addDays(todayDate, i), t = tripSet.get(d); if (t) n++;
    cells.push(`<div class="${t ? 'trip' : ''} ${i === 0 ? 'today-c' : ''}" title="${esc(E.fmtDate(d) + (t ? ' · ' + t : ''))}"><i></i>${E.DOW_IT[E.dow(d)][0]}</div>`);
  }
  const all = E.allTrips(S.data.trips).filter((t) => (t.end || t.start) >= todayDate).slice(0, 6);
  const warn = (t) => {
    const out = [];
    for (let d = t.start, k = 0; d <= (t.end || t.start) && k < 30; d = E.addDays(d, 1), k++) { const p = E.effective(d, base.pIdx, base.overrides); if (p?.kind === 'long' || (p && p.hotel === false && p.kind !== 'rest')) out.push(`${E.DOW_IT[E.dow(d)]}: ${p.title}`); }
    return out;
  };
  return `<details class="card fold" data-fold="trips">
    <summary><h3>Trasferte</h3><span class="sum-sub">${n ? `${n} ${n === 1 ? 'giorno' : 'giorni'} fuori nei prossimi 14` : 'nessuna nei prossimi 14 giorni'}</span>${ico('down', 'chev')}</summary>
    <div class="fold-b">
      <div class="strip" role="img" aria-label="Giorni di trasferta nei prossimi 14 giorni">${cells.join('')}</div>
      ${all.length ? `<ul class="trip-list">${all.map((t) => { const w = t.type === 'vacation' ? [] : warn(t); const fac = t.facilities ? (t.facilities.length ? t.facilities.map((f) => E.FACILITIES[f]).join(', ') : 'non sai ancora') : 'da chiedere'; return `<li><div><b>${t.type === 'vacation' ? ico('sunb') + ' ' : ''}${esc(E.tripName(t))}</b> <span class="sub mono">${E.fmtDate(t.start)}${t.end && t.end !== t.start ? ' → ' + E.fmtDate(t.end) : ''}</span>
        ${E.tripDetail(t) ? `<div class="sub">${esc(E.tripDetail(t))}</div>` : ''}<div class="sub">${t.type === 'vacation' ? 'Vacanza: niente versione hotel' : w.length ? `Da adattare: ${esc(w.join(', '))}` : 'Sessioni già compatibili con l\'hotel'} · in loco: ${esc(fac)}${t.source === 'ical' ? ' · da calendario' : ''}</div></div>
        ${t.source === 'manual' ? `<button class="icon-btn" data-a="trip-del" data-id="${esc(t.id)}" type="button" aria-label="Elimina la trasferta a ${esc(t.city || '')}">${ico('x')}</button>` : '<span></span>'}</li>`; }).join('')}</ul>`
    : '<p class="muted small" style="margin-bottom:12px">Nessuna trasferta in vista: quando ne aggiungi una, le sessioni di quei giorni passano in versione hotel e il lungo slitta.</p>'}
      <form class="trip-form" id="tripForm">
        <label class="f">Dal<input type="date" id="tripFrom" required value="${E.addDays(todayDate, 1)}"></label>
        <label class="f">Al<input type="date" id="tripTo" required value="${E.addDays(todayDate, 2)}"></label>
        <label class="f">Città<input type="text" id="tripCity" placeholder="es. Bologna" maxlength="40"></label>
        <label class="f">Tipo<select id="tripType"><option value="work">Lavoro</option><option value="vacation">Vacanza</option></select></label>
        <button class="btn full" type="submit">Aggiungi trasferta</button>
      </form>
      <p class="muted small" style="margin-top:10px">${S.data.settings?.icalUrls ? `Calendario collegato${S.data.trips?.icalUpdated ? ' · letto ' + ago(S.data.trips.icalUpdated) : ''}. <button class="btn sm ghost" data-a="trips-refresh" type="button">Rileggi</button>` : 'Collega il calendario delle trasferte dalle impostazioni per averle in automatico.'}</p>
    </div></details>`;
}

export function units() {
  const mon = monday(), days = E.weekView(mon, S.ctx.base);
  return [
    { id: 'wkhead', html: head(days, mon) },
    { id: 'wklist', html: list(days) },
    { id: 'trips', html: trips() },
  ];
}
