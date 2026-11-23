// Finestre di dialogo: check-in, dettaglio del giorno, impostazioni
import { E, J, S, ACT, $, esc, ico, KIND_IT, zoneRange, fmtKm } from './core.js';

export function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 4200);
}
export function openDlg(html, onBind) {
  $('#dlgBody').innerHTML = html;
  const d = $('#dlg'); if (!d.open) d.showModal();
  $('#dlgBody').scrollTop = 0;
  $('#dlgBody').querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => d.close()));
  onBind && onBind($('#dlgBody'));
}
const closeBtn = `<button class="icon-btn" data-close type="button" aria-label="Chiudi">${ico('x')}</button>`;
const scale = (name, val, label) => `<fieldset><legend>${label}</legend><div class="scale">${[1, 2, 3, 4, 5].map((v) => `<label><input type="radio" name="${name}" value="${v}" ${v === val ? 'checked' : ''}><span>${v}</span></label>`).join('')}</div></fieldset>`;

const radios = (name, val, opts, cls = 'fac-chips') => `<div class="${cls}">${opts.map(([k, l]) => `<label class="${cls === 'fac-chips' ? 'seg-r' : ''}"><input type="radio" name="${name}" value="${esc(k)}" ${String(k) === String(val) ? 'checked' : ''}><span>${esc(l)}</span></label>`).join('')}</div>`;
// Check-in in 3-4 tocchi: energia, gambe, fastidio, giornata. Il sonno non c'è (Luca non dorme col Garmin).
export function checkinDlg() {
  const { todayDate } = S.ctx, c = S.data.checkins?.[todayDate] || {}, pain = c.pain?.level || 0;
  openDlg(`<div class="dlg-h"><div><span class="eyebrow">${E.DOW_IT_LONG[E.dow(todayDate)]} ${E.fmtDate(todayDate)}</span><h2>Check-in</h2></div>${closeBtn}</div>
    <form id="ciForm" style="display:grid;gap:16px">
      ${scale('energy', c.energy || 3, 'Energia · 1 a terra, 5 carico')}
      ${scale('legs', c.legs || 2, 'Gambe · 1 fresche, 5 a pezzi')}
      <fieldset><legend>Dolore o fastidio</legend>${radios('painYN', pain ? 'y' : 'n', [['n', 'No'], ['y', 'Sì']])}
        <div id="ciPainBox" ${pain ? '' : 'hidden'}><div class="ci-pain">
          <span class="small muted">Dove</span>${radios('parea', c.pain?.area || '', E.PAIN_AREAS.map((a) => [a, a]))}
          <span class="small muted">Quanto · 1 lieve, 10 forte</span>${radios('plevel', pain || 3, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((v) => [v, v]), 'scale s10')}
        </div></div></fieldset>
      <fieldset><legend>Giornata · lavoro e stress</legend>${radios('day', c.day || 'normal', [['light', 'Leggera'], ['normal', 'Normale'], ['heavy', 'Pesante']])}</fieldset>
      <button class="btn primary lg block" type="submit">Salva e ricalcola</button>
    </form>`, (r) => {
    const f = $('#ciForm', r), v = (n) => f.querySelector(`input[name="${n}"]:checked`)?.value;
    f.addEventListener('change', (e) => { if (e.target.name === 'painYN') $('#ciPainBox', r).hidden = v('painYN') !== 'y'; });
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const yes = v('painYN') === 'y';
      if (yes && !v('parea')) return toast('Dimmi dove senti il fastidio');
      const payload = { date: todayDate, energy: +v('energy') || 3, legs: +v('legs') || 2, day: v('day') || 'normal', pain: { area: yes ? v('parea') : '', level: yes ? +v('plevel') || 3 : 0 } };
      $('#dlg').close();
      try { await ACT.checkin(payload); } catch (err) { toast(err.message); }
    });
  });
}

export function dayDlg(date) {
  const { base, tripSet, m, settings } = S.ctx;
  const p = E.effective(date, base.pIdx, base.overrides), orig = base.pIdx[date];
  const acts = m.acts.filter((a) => a.date === date);
  const f = p ? E.fueling(p, settings, E.diffDays(date, settings.raceDate)) : null;
  const shoes = J.shoeKm(S.data.shoes, m.acts).filter((x) => !x.retired);
  const canSkip = p && E.RUN_KINDS.includes(p.kind) && date >= S.ctx.todayDate && date <= E.addDays(S.ctx.todayDate, 6) && !acts.some(E.isRun);
  const range = p ? zoneRange(p.zone, m.hrp) : null;
  const st = p?.strength ? E.STRENGTH[p.strength] : null;
  openDlg(`<div class="dlg-h"><div><span class="eyebrow">${E.DOW_IT_LONG[E.dow(date)]} ${E.fmtDate(date)}${tripSet.has(date) ? ' · trasferta ' + esc(tripSet.get(date)) : ''}</span><h2>${esc(p?.title || 'Nessuna sessione')}</h2></div>${closeBtn}</div>
    ${p ? `<dl class="meta">${p.min ? `<div><dt>Durata</dt><dd>${E.fmtMin(p.min)}</dd></div>` : ''}${p.rpe && p.rpe !== '-' ? `<div><dt>RPE</dt><dd>${esc(p.rpe)}</dd></div>` : ''}${range ? `<div><dt>FC ${esc(p.zone)}</dt><dd>${range}<small>bpm</small></dd></div>` : ''}<div><dt>Tipo</dt><dd>${esc(KIND_IT[p.kind] || p.kind)}</dd></div></dl>
    <p class="desc">${esc(p.desc)}</p>${p.override ? `<p class="small muted">Modificata${p.reason ? ': ' + esc(p.reason) : ''}. Dal piano: ${esc(orig?.title || '—')} ${orig?.min ? E.fmtMin(orig.min) : ''}</p>` : ''}
    ${st ? `<div class="dlg-sec"><span class="eyebrow">Routine ${p.strength} · ${esc(st.name)}</span><ol class="small" style="margin:0;padding-left:20px;display:grid;gap:4px">${st.ex.map(([n, d]) => `<li>${esc(n)} — <span class="mono">${esc(d)}</span></li>`).join('')}</ol></div>` : ''}
    ${f && (f.pre || f.during) ? `<div class="notes">${f.pre ? `<div><b>Prima:</b> ${esc(f.pre)}</div>` : ''}${f.during ? `<div><b>Durante:</b> ${esc(f.during)}</div>` : ''}<div><b>Dopo:</b> ${esc(f.post)}</div><div class="muted">${esc(f.note)}</div></div>` : ''}` : '<p class="muted">Nessuna sessione in piano per questo giorno.</p>'}
    ${acts.length ? `<div class="dlg-sec"><span class="eyebrow">Eseguito</span>${acts.map((a) => `<p class="small mono">${esc(a.name)} · ${fmtKm(a.dist_km, 2)} km · ${E.fmtMin(a.moving_min)} · ${E.fmtPace(a.pace_s)} · FC ${a.avg_hr || '—'}${a.decoupling != null ? ' · deriva ' + fmtKm(a.decoupling) + '%' : ''}</p>${E.isRun(a) && shoes.length ? `<label class="f shoe-sel">Scarpe<select data-shoe="${esc(a.id)}"><option value="none">Nessuna</option>${shoes.map((x) => `<option value="${esc(x.id)}" ${J.shoeOf(a, S.data.shoes) === x.id ? 'selected' : ''}>${esc(x.model)}</option>`).join('')}</select></label>` : ''}${a.splits?.length ? `<div class="tbl-wrap"><table><thead><tr><th>Km</th><th>Passo</th><th>FC</th><th>Disl.</th></tr></thead><tbody>${a.splits.map((s, i) => `<tr><td class="n">${i + 1}</td><td class="n">${E.fmtPace(s.p)}</td><td class="n">${s.hr || '—'}</td><td class="n">${s.el}</td></tr>`).join('')}</tbody></table></div>` : ''}`).join('')}</div>` : ''}
    ${strengthBlock(date, p)}
    ${date <= S.ctx.todayDate && p?.kind !== 'pause' ? `<div class="dlg-sec"><span class="eyebrow">Hai corso senza orologio?</span><button class="btn sm" data-a="manual-run" data-date="${date}" type="button">${ico('plus')}Aggiungi corsa a mano</button></div>` : ''}
    ${p && p.kind !== 'pause' && date >= S.ctx.todayDate ? `<div class="dlg-sec"><span class="eyebrow">Adatta questa giornata</span><div class="actions">
      ${canSkip ? `<button class="btn sm primary" data-a="skip" data-date="${date}" type="button">Non riesco</button>` : ''}
      <button class="btn sm" data-ov="reduce" type="button">-25% volume</button>
      <button class="btn sm" data-ov="easy" type="button">Solo facile</button>
      <button class="btn sm" data-ov="hotel" type="button">Versione hotel</button>
      <button class="btn sm" data-ov="rest" type="button">Riposo</button>
      ${p.override ? '<button class="btn sm primary" data-ov="reset" type="button">Ripristina piano</button>' : ''}
    </div></div>` : ''}`, (r) => {
    r.querySelectorAll('select[data-shoe]').forEach((x) => x.addEventListener('change', () => ACT.shoeAssign(x.dataset.shoe, x.value).catch((e) => toast(e.message))));
    r.querySelectorAll('[data-ov]').forEach((b) => b.addEventListener('click', async () => {
      const k = b.dataset.ov; let s = null, reason = '';
      if (k === 'reduce') { s = { ...p, min: Math.max(15, Math.round((p.min * 0.75) / 5) * 5) }; reason = 'Ridotta del 25%'; }
      if (k === 'easy') { s = { ...p, kind: 'easy', title: 'Facile Z1-Z2', rpe: '3-4', zone: 'Z1-Z2', desc: 'Corsa facile, niente variazioni.', min: p.kind === 'long' ? Math.min(p.min, 50) : p.min }; reason = 'Convertita in facile'; }
      if (k === 'hotel') { s = { ...p, kind: p.kind === 'long' ? 'easy' : p.kind, title: p.kind === 'quality' ? p.title + ' (tapis roulant)' : 'Facile vicino all\'hotel', min: p.kind === 'long' ? 40 : Math.min(p.min, 45), hotel: true, desc: (p.kind === 'quality' ? p.desc + ' ' : 'Corsa facile su tapis roulant (pendenza 1%) o anello nel parco più vicino. ') + 'Poi routine A in camera.', strength: 'A' }; reason = 'Versione trasferta'; }
      if (k === 'rest') { s = { ...p, kind: 'rest', title: 'Riposo', min: 0, rpe: '-', zone: '-', desc: 'Riposo deciso dall\'atleta. Opzionale routine D.', strength: 'D' }; reason = 'Riposo'; }
      $('#dlg').close();
      try { await ACT.override(date, k === 'reset' ? null : s, reason); } catch (e) { toast(e.message); }
    }));
  });
}

export function settingsDlg() {
  const s = S.ctx.settings, hrp = S.ctx.m.hrp, d = S.data;
  openDlg(`<div class="dlg-h"><h2>Impostazioni</h2>${closeBtn}</div>
    <form id="setForm" style="display:grid;gap:16px">
      <div><span class="eyebrow">Profilo e zone FC</span><div class="grid2" style="margin-top:8px">
        <label class="f">Età<input type="number" id="sAge" min="15" max="90" inputmode="numeric" value="${s.age ?? ''}"></label>
        <label class="f">Peso (kg)<input type="number" id="sKg" min="40" max="150" step="0.5" inputmode="decimal" value="${s.weightKg ?? ''}"></label>
        <label class="f">FC max (se la conosci)<input type="number" id="sMax" min="140" max="220" inputmode="numeric" value="${s.hrMax ?? ''}"></label>
        <label class="f">FC a riposo (mattina, a letto)<input type="number" id="sRest" min="35" max="90" inputmode="numeric" value="${s.hrRest ?? 60}"></label>
      </div>
      <div class="hr-scale" style="margin-top:12px">${hrp.zones.map((z) => `<div style="border-color:var(--z${z.z})"><b>Z${z.z}</b>${z.lo}-${z.hi}</div>`).join('')}</div>
      ${hrp.src === 'intervals.icu'
        ? `<p class="small muted" style="margin-top:8px">Zone della corsa da intervals.icu (FC max ${hrp.max}): sono le stesse dell'orologio. Per cambiarle modificale su intervals.icu e rileggile. <button class="btn sm ghost" data-a="zones-refresh" type="button">Rileggi zone</button></p>`
        : `<p class="small muted" style="margin-top:8px">FC max ${hrp.max} (${esc(hrp.src)}). Zone calcolate col metodo Karvonen: appena su intervals.icu ci sono le zone della corsa, si usano quelle. ${S.demo ? '' : '<button class="btn sm ghost" data-a="zones-refresh" type="button">Rileggi zone</button>'}</p>`}</div>
      <div class="dlg-sec"><span class="eyebrow">Gara e preparazione</span><div class="grid2">
        <label class="f">Nome gara<input type="text" id="sRace" maxlength="40" value="${esc(s.raceName)}"></label>
        <label class="f">Data gara<input type="date" id="sRaceDate" required value="${esc(s.raceDate)}"></label>
        <label class="f">Inizio preparazione<input type="date" id="sStart" required value="${esc(s.planStart)}"></label>
      </div>
      <p class="small muted">Tra inizio e gara servono da ${E.PLAN_MIN_WEEKS} a ${E.PLAN_MAX_WEEKS} settimane. Se cambi le date ti propongo di rigenerare il piano.</p></div>
      ${profileSection()}
      <div class="dlg-sec"><span class="eyebrow">Aspetto</span>
        <div class="seg" role="group" aria-label="Tema">${[['auto', 'Automatico'], ['light', 'Chiaro'], ['dark', 'Scuro']].map(([k, l]) => `<button type="button" data-a="theme" data-k="${k}" aria-pressed="${(document.documentElement.dataset.theme || 'auto') === k}">${l}</button>`).join('')}</div>
        <p class="small muted">Automatico segue l'impostazione dell'iPhone o del PC. La scelta resta su questo dispositivo.</p></div>
      <div class="dlg-sec"><span class="eyebrow">Settimana tipo</span><div class="grid2">
        <label class="f">Giorno del lungo<select id="sLong"><option value="0" ${s.longRunDay === 0 ? 'selected' : ''}>Domenica</option><option value="6" ${s.longRunDay === 6 ? 'selected' : ''}>Sabato</option></select></label>
      </div></div>
      <div class="dlg-sec"><span class="eyebrow">Meteo e orari</span><div class="grid2">
        <label class="f">Città di casa<input type="text" id="sHome" maxlength="40" value="${esc(s.homeCity || 'Milano')}"></label>
        <label class="f">Ora abituale di corsa<select id="sHour">${Array.from({ length: 18 }, (_, i) => i + 5).map((h) => `<option value="${h}" ${+s.runHour === h ? 'selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('')}</select></label>
        <label class="f">Freddo: attenzione sotto (°C percepiti)<input type="number" id="sCold" min="-10" max="15" inputmode="numeric" value="${s.coldFeelsC ?? 5}"></label>
        <label class="f">Giro di José al mattino<input type="time" id="sAm" value="${esc(s.runMorning || '07:00')}"></label>
        <label class="f">Giro di José la sera<input type="time" id="sPm" value="${esc(s.runEvening || '21:00')}"></label>
      </div><p class="small muted">Gli orari dei giri devono coincidere con le due attività programmate in Claude: servono solo a dirti entro quando José risponde.</p></div>
      <div class="dlg-sec"><span class="eyebrow">Trasferte automatiche</span>
        <label class="f">URL iCal segreti dei calendari (uno per riga, massimo 5)<textarea id="sIcal" placeholder="https://calendar.google.com/calendar/ical/…/basic.ics">${esc(s.icalUrls || '')}</textarea></label>
        <p class="small muted">Google Calendar → impostazioni del calendario → "Indirizzo segreto in formato iCal". Ogni evento diventa giorni di trasferta.</p></div>
      <button class="btn primary lg" type="submit">Salva impostazioni</button>
    </form>
    <div class="dlg-sec"><span class="eyebrow">Piano di allenamento</span>
      <p class="small muted">Attuale: ${d.plan.length} sessioni, ${s.planSource === 'import' ? 'importato da file' : 'generato dal coach'}. Le modifiche giornaliere restano.</p>
      <div class="actions"><button class="btn sm" id="genPlan" type="button">Rigenera piano adattivo</button><label class="btn sm" for="planFile">Importa CSV o .ics</label><input type="file" id="planFile" accept=".csv,.ics,text/csv,text/calendar" hidden></div>
      <div id="genConfirm" hidden class="banner">Il piano attuale viene sostituito. <button class="btn sm primary" id="genYes" type="button">Conferma</button></div>
    </div>
    <div class="dlg-sec"><span class="eyebrow">Collegamenti</span>
      ${S.demo ? '<p class="small muted">Demo: nessun backend collegato.</p>' : `
      <p class="small">Intervals.icu: <b>${d.intervals?.connected ? 'collegato' + (d.intervals.athlete ? ' (' + esc(d.intervals.athlete) + ')' : '') : 'non collegato'}</b> · nuove uscite: <b>ogni 10 minuti</b> · José (connettore): <b>${d.connector ? J.joseStatus(d.jose?.last).testo : 'manca MCP_SECRET'}</b> · note vocali: <b>${d.voice ? 'attive' : 'spente'}</b> · Telegram: <b>${d.telegram ? 'attivo' : 'spento'}</b></p>
      <div class="actions"><button class="btn sm" data-a="test-link" type="button">Verifica collegamento</button><button class="btn sm" data-a="backfill" type="button">Importa ultimi 120 giorni</button><button class="btn sm ghost" data-a="logout" type="button">Cambia token</button></div>`}
    </div>`, (r) => {
    $('#setForm', r).addEventListener('submit', async (e) => {
      e.preventDefault();
      const num = (id) => { const v = $(id, r).value; return v === '' ? null : +v; };
      const planStart = $('#sStart', r).value, raceDate = $('#sRaceDate', r).value;
      const w = E.planWeeks(planStart, raceDate);
      if (w < E.PLAN_MIN_WEEKS || w > E.PLAN_MAX_WEEKS) return toast(`Tra inizio e gara servono da ${E.PLAN_MIN_WEEKS} a ${E.PLAN_MAX_WEEKS} settimane (ora sono ${Math.max(0, w)})`);
      const datesChanged = planStart !== s.planStart || raceDate !== s.raceDate;
      $('#dlg').close();
      try {
        await ACT.settings({ age: num('#sAge'), weightKg: num('#sKg'), hrMax: num('#sMax'), hrRest: num('#sRest') || 60, longRunDay: +$('#sLong', r).value, raceName: $('#sRace', r).value || 'Maratona', planStart, raceDate, icalUrls: $('#sIcal', r).value.trim(), homeCity: $('#sHome', r).value.trim() || 'Milano', runHour: +$('#sHour', r).value, coldFeelsC: +$('#sCold', r).value, runMorning: $('#sAm', r).value || '07:00', runEvening: $('#sPm', r).value || '21:00' });
        if (datesChanged) regenDlg();
      } catch (err) { toast(err.message); }
    });
    $('#genPlan', r).addEventListener('click', () => ($('#genConfirm', r).hidden = false));
    $('#genYes', r).addEventListener('click', async () => { $('#dlg').close(); try { await ACT.plan({ mode: 'generate' }); } catch (e) { toast(e.message); } });
    $('#planFile', r).addEventListener('change', async (e) => {
      const file = e.target.files[0]; if (!file) return;
      const text = await file.text();
      const sessions = /BEGIN:VCALENDAR/.test(text) ? E.planFromICS(text) : E.parsePlanCSV(text);
      if (!sessions.length) return toast('Nessuna sessione riconosciuta: servono almeno le colonne Data e Titolo');
      $('#dlg').close();
      try { await ACT.plan({ mode: 'import', sessions }); } catch (err) { toast(err.message); }
    });
  });
}

// Dopo un cambio di date: il piano attuale è costruito sulle date vecchie
function regenDlg() {
  const s = S.ctx.settings;
  openDlg(`<div class="dlg-h"><h2>Rigenero il piano?</h2>${closeBtn}</div>
    <p>Le date sono cambiate: inizio <b>${E.fmtDate(s.planStart)}</b>, gara <b>${E.fmtDate(s.raceDate)}</b> (${E.planWeeks(s.planStart, s.raceDate)} settimane). Il piano attuale è costruito sulle date vecchie.</p>
    <p class="small muted">Le modifiche che hai fatto a mano sui singoli giorni restano.</p>
    <div class="actions"><button class="btn primary" id="regenYes" type="button">Rigenera il piano</button><button class="btn ghost" data-close type="button">Non ora</button></div>`, (r) => {
    $('#regenYes', r).addEventListener('click', async () => { $('#dlg').close(); try { await ACT.plan({ mode: 'generate' }); } catch (e) { toast(e.message); } });
  });
}

// ---------------------------------------------------------------- Forza: "Fatto"
// Pulsanti per la routine del giorno: segna fatta / annulla (un'attività di forza dal Garmin la segna da sola)
export function strengthBlock(date, p, compact = false) {
  const need = E.strengthNeed(p);
  if (!need || date > S.ctx.todayDate) return '';
  const acts = S.ctx.m.acts.filter((a) => a.date === date);
  const fromWatch = acts.find((a) => a.src !== 'log' && (need.kind === 'mobility' ? E.isMobilityAct(a) || E.isStrengthAct(a) : E.isStrengthAct(a)));
  const log = (S.data.logs || []).find((l) => l.date === date && l.kind === need.kind);
  const r = E.STRENGTH[need.routine];
  const label = `Routine ${need.routine}${r ? ' · ' + r.name : ''}`;
  const state = fromWatch ? `<span class="chip" data-tone="good">${ico('check')}Fatta · dal Garmin (${E.fmtMin(fromWatch.moving_min)})</span>`
    : log ? `<span class="chip" data-tone="good">${ico('check')}Fatta · ${E.fmtMin(log.min)}${log.rpe ? ' · RPE ' + log.rpe : ''}</span><button class="btn sm ghost" data-a="undone" data-date="${date}" data-kind="${need.kind}" type="button">Annulla</button>`
      : `<button class="btn ${need.main ? 'primary' : ''} sm" data-a="done" data-date="${date}" data-kind="${need.kind}" data-routine="${need.routine}" type="button">${ico('check')}${need.main ? 'Fatto' : label + ' fatta'}</button>${need.optional ? '<span class="small muted">facoltativa</span>' : ''}`;
  return `<div class="${compact ? 'str-row' : 'dlg-sec'}">${compact ? '' : `<span class="eyebrow">${esc(label)}</span>`}<div class="actions" style="align-items:center">${state}</div></div>`;
}
export function doneDlg(date, kind, routine) {
  const r = E.STRENGTH[routine];
  openDlg(`<div class="dlg-h"><div><span class="eyebrow">${E.DOW_IT_LONG[E.dow(date)]} ${E.fmtDate(date)}</span><h2>${kind === 'mobility' ? 'Mobilità fatta' : 'Forza fatta'}</h2></div>${closeBtn}</div>
    <form id="doneForm" class="grid2">
      <label class="f">Durata (minuti)<input type="number" id="dMin" min="1" max="180" inputmode="numeric" required value="${r?.min || 20}"></label>
      <label class="f">Fatica (RPE 1-10, facoltativa)<input type="number" id="dRpe" min="1" max="10" inputmode="numeric" placeholder="es. 5"></label>
      <p class="small muted" style="grid-column:1/-1">${r ? `Routine ${routine} · ${esc(r.name)}. ` : ''}Se registri la sessione sul Garmin come attività "Forza", la segno da solo.</p>
      <button class="btn primary lg" type="submit" style="grid-column:1/-1">${ico('check')}Segna come fatta</button>
    </form>`, (el) => {
    $('#doneForm', el).addEventListener('submit', async (e) => {
      e.preventDefault();
      const rpe = $('#dRpe', el).value;
      $('#dlg').close();
      try { await ACT.log({ date, kind, routine, min: +$('#dMin', el).value, rpe: rpe ? +rpe : null }); } catch (err) { toast(err.message); }
    });
  });
}
export function manualRunDlg(date) {
  openDlg(`<div class="dlg-h"><div><span class="eyebrow">${E.DOW_IT_LONG[E.dow(date)]} ${E.fmtDate(date)}</span><h2>Corsa senza orologio</h2></div>${closeBtn}</div>
    <form id="mrForm" class="grid2">
      <label class="f">Durata (minuti)<input type="number" id="mrMin" min="5" max="360" inputmode="numeric" required></label>
      <label class="f">Distanza (km, se la sai)<input type="number" id="mrKm" min="0" max="60" step="0.1" inputmode="decimal"></label>
      <label class="f">Fatica (RPE 1-10)<input type="number" id="mrRpe" min="1" max="10" inputmode="numeric"></label>
      <label class="f">Nota<input type="text" id="mrNote" maxlength="200" placeholder="es. dimenticato l'orologio"></label>
      <p class="small muted" style="grid-column:1/-1">La creo anche su intervals.icu, così i dati restano in un posto solo. Senza frequenza cardiaca il carico si calcola dalla fatica.</p>
      <button class="btn primary lg" type="submit" style="grid-column:1/-1">Aggiungi corsa</button>
    </form>`, (el) => {
    $('#mrForm', el).addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = (id) => $(id, el).value;
      $('#dlg').close();
      try { await ACT.manualRun({ date, min: +v('#mrMin'), km: v('#mrKm') ? +v('#mrKm') : 0, rpe: v('#mrRpe') ? +v('#mrRpe') : null, note: v('#mrNote') }); } catch (err) { toast(err.message); }
    });
  });
}

// ---------------------------------------------------------------- "Mi fermo"
export function pauseDlg() {
  const today = S.ctx.todayDate;
  openDlg(`<div class="dlg-h"><div><span class="eyebrow">Pausa</span><h2>Mi fermo</h2></div>${closeBtn}</div>
    <form id="pauseForm" style="display:grid;gap:14px">
      <fieldset><legend>Motivo</legend><div class="fac-chips" role="radiogroup">${Object.entries(E.PAUSE_REASONS).map(([k, l], i) => `<label class="seg-r"><input type="radio" name="preason" value="${k}" ${i === 0 ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div></fieldset>
      <div class="grid2">
        <label class="f">Da<input type="date" id="pFrom" required value="${today}" min="${E.addDays(today, -14)}" max="${E.addDays(today, 30)}"></label>
        <label class="f">Rientro previsto (facoltativo)<input type="date" id="pTo" min="${today}"></label>
      </div>
      <label class="f">Nota<input type="text" id="pNote" maxlength="200" placeholder="es. febbre, mal di gola"></label>
      <p class="small muted">Durante la pausa le sessioni non contano come saltate e il coach non commenta. Al rientro facciamo il punto e si riparte con calma.</p>
      <button class="btn primary lg" type="submit">Metti in pausa</button>
    </form>`, (el) => {
    $('#pauseForm', el).addEventListener('submit', async (e) => {
      e.preventDefault();
      const reason = el.querySelector('input[name="preason"]:checked')?.value || 'other';
      const from = $('#pFrom', el).value, to = $('#pTo', el).value || null;
      if (to && to < from) return toast('Il rientro è prima dell\'inizio');
      $('#dlg').close();
      try { await ACT.pause({ reason, from, to, note: $('#pNote', el).value }); } catch (err) { toast(err.message); }
    });
  });
}

// ---------------------------------------------------------------- Profilo atleta (questionario in 4 schermate)
const PROFILE_STEPS = [
  { t: 'Storia sportiva', f: [['running', 'Corsa: da quanto, quanto spesso, com\'è andata', 'es. qualche 5 km anni fa, mai oltre i 10'], ['gym', 'Palestra', 'es. pesi 2 volte a settimana fino al 2023'], ['sports', 'Altri sport', 'es. calcetto 10 anni, sci'], ['races', 'Gare fatte', 'es. una 10 km nel 2022 in 58\'']] },
  { t: 'Infortuni e punti deboli', f: [['injuries', 'Infortuni passati', 'zona, quando, se tornano'], ['weakPoints', 'Punti deboli da tenere d\'occhio', 'es. polpacci rigidi, schiena dopo il treno']] },
  { t: 'Testa e obiettivo', f: [['motivation', 'Cosa ti motiva', ''], ['quitTriggers', 'Cosa ti fa mollare', 'es. freddo, settimane di trasferte, saltarne due di fila'], ['goal', 'Obiettivo', 'Finire la maratona']] },
  { t: 'Giorni, orari e vita', f: [['preferredDays', 'Giorni preferiti per correre', 'es. mar, gio, sab, dom'], ['preferredTime', 'Orari preferiti', 'es. 7:00 prima del lavoro'], ['longDay', 'Giorno del lungo', 'es. domenica mattina'], ['impossibleDays', 'Giorni impossibili', 'es. lunedì, riunione fino a tardi'], ['typicalWeek', 'Settimana tipo', 'es. lun ufficio, mar-gio in giro, ven casa'], ['workload', 'Carico di lavoro', 'es. pesante a fine mese'], ['travelPattern', 'Frequenza delle trasferte', 'es. 2-3 notti a settimana, hotel in centro']] },
];
export function profileDlg(step = 0, draft = null) {
  const cur = draft || { goal: 'Finire la maratona di Francoforte', ...(S.data.profile || {}) };
  const st = PROFILE_STEPS[step], last = step === PROFILE_STEPS.length - 1;
  openDlg(`<div class="dlg-h"><div><span class="eyebrow">José vuole sapere · ${step + 1} di ${PROFILE_STEPS.length}</span><h2>${st.t}</h2></div>${closeBtn}</div>
    <p class="small muted">Prima di allenarti devo sapere con chi ho a che fare. Rispondi come parli, bastano poche parole: quello che manca te lo chiedo in chat. Lo legge Claude insieme ai tuoi allenamenti: metti solo quello che ti va.</p>
    <form id="profForm" style="display:grid;gap:12px">
      ${st.f.map(([k, l, ph]) => `<label class="f">${l}<textarea id="pf_${k}" rows="2" maxlength="600" placeholder="${esc(ph)}">${esc(cur[k] || '')}</textarea></label>`).join('')}
      <div class="actions" style="justify-content:space-between">
        ${step ? '<button class="btn" type="button" id="pfBack">Indietro</button>' : '<button class="btn ghost" type="button" data-close>Più tardi</button>'}
        <button class="btn primary" type="submit">${last ? 'Salva il profilo' : 'Avanti'}</button>
      </div>
    </form>`, (el) => {
    const read = () => { for (const [k] of st.f) cur[k] = $(`#pf_${k}`, el).value.trim(); return cur; };
    $('#pfBack', el)?.addEventListener('click', () => profileDlg(step - 1, read()));
    $('#profForm', el).addEventListener('submit', async (e) => {
      e.preventDefault(); read();
      if (!last) return profileDlg(step + 1, cur);
      $('#dlg').close();
      try { await ACT.profile(cur); } catch (err) { toast(err.message); }
    });
  });
}

// ---------------------------------------------------------------- Domande del check-up
export function reviewDlg() {
  const r = S.data.review || {}, ans = { ...(r.answers || {}) };
  openDlg(`<div class="dlg-h"><div><span class="eyebrow">Check-up di José</span><h2>Facciamo il punto</h2></div>${closeBtn}</div>
    ${r.intro ? `<p class="muted">${esc(r.intro)}</p>` : ''}
    <form id="revForm" style="display:grid;gap:16px">
      ${(r.questions || []).map((q) => `<fieldset><legend><b>${esc(q.text)}</b></legend>${
        q.type === 'scale' ? `<div class="scale">${[1, 2, 3, 4, 5].map((v) => `<label><input type="radio" name="rq_${esc(q.id)}" value="${v}" ${+ans[q.id] === v ? 'checked' : ''}><span>${v}</span></label>`).join('')}</div><div class="scale-l small muted"><span>per niente</span><span>moltissimo</span></div>`
        : q.type === 'choice' ? `<div class="fac-chips">${q.options.map((o) => `<label class="seg-r"><input type="radio" name="rq_${esc(q.id)}" value="${esc(o)}" ${ans[q.id] === o ? 'checked' : ''}><span>${esc(o)}</span></label>`).join('')}</div>`
          : `<textarea name="rq_${esc(q.id)}" rows="2" maxlength="400">${esc(ans[q.id] || '')}</textarea>`}</fieldset>`).join('')}
      <button class="btn primary lg" type="submit">Invia le risposte</button>
      <p class="small muted">Al prossimo giro (mattina o sera) José ricalibra le prossime 4 settimane, dentro i limiti di sicurezza. Potrai annullare per 7 giorni.</p>
    </form>`, (el) => {
    $('#revForm', el).addEventListener('submit', async (e) => {
      e.preventDefault();
      const out = {};
      for (const q of r.questions || []) {
        const v = q.type === 'text' ? el.querySelector(`[name="rq_${q.id}"]`)?.value.trim() : el.querySelector(`[name="rq_${q.id}"]:checked`)?.value;
        if (v) out[q.id] = q.type === 'scale' ? +v : v;
      }
      if (!Object.keys(out).length) return toast('Rispondi ad almeno una domanda');
      $('#dlg').close();
      try { await ACT.reviewAnswers(out); } catch (err) { toast(err.message); }
    });
  });
}

// Sezione "Profilo e coach" nelle impostazioni
export function profileSection() {
  const d = S.data, p = d.profile, mem = d.memory || [], s = S.ctx.settings;
  const filled = p ? Object.keys(p).filter((k) => k !== 'updatedAt' && p[k]).length : 0;
  const rh = (s.rpwHistory || []).slice(-1)[0];
  return `<div class="dlg-sec"><span class="eyebrow">Profilo e coach</span>
    <p class="small">${p ? `Profilo compilato: <b>${filled}</b> risposte.` : '<b>Profilo non ancora compilato</b>: il coach ti conosce solo dai dati.'} <button class="btn sm" data-a="profile" type="button">${p ? 'Modifica il profilo' : 'Compila il profilo (3 minuti)'}</button></p>
    <p class="small">Corse a settimana: <b>${s.runsPerWeek || 3}</b> · le decide José ai check-up${rh ? ` (ultima modifica ${E.fmtDate(rh.date)}: ${rh.from} → ${rh.to})` : ''}.</p>
    <div><span class="small"><b>Cosa ha imparato su di te</b> (${mem.length}/30)</span>
      ${mem.length ? `<ul class="mem-list">${mem.map((f) => `<li><span>${esc(f.text)}</span><button class="icon-btn" data-a="mem-del" data-id="${esc(f.id)}" type="button" aria-label="Dimentica questa nota">${ico('x')}</button></li>`).join('')}</ul>` : '<p class="small muted">Ancora niente: le note arrivano con i check-up.</p>'}</div>
    ${S.demo ? '' : '<div class="actions"><button class="btn sm" data-a="profile-export" type="button">Esporta profilo e memoria</button><button class="btn sm ghost" data-a="profile-delete" type="button">Cancella profilo e memoria</button></div>'}
    <p class="small muted">Profilo, memoria e allenamenti vengono letti da Claude a ogni giro di José.</p>
  </div>`;
}

// ---------------------------------------------------------------- "Non riesco": due opzioni valide, subito
export function skipDlg(date) {
  const r = J.skipOptions(date, { ...S.ctx.base, settings: S.ctx.settings });
  if (!r) return toast('In questo giorno non c\'è una corsa da spostare');
  openDlg(`<div class="dlg-h"><div><span class="eyebrow">${E.DOW_IT_LONG[E.dow(date)]} ${E.fmtDate(date)} · ${esc(r.session.title)} ${E.fmtMin(r.session.min)}</span><h2>Non riesco</h2></div>${closeBtn}</div>
    <p class="muted">Scegli come recuperarla. Le opzioni rispettano i limiti di sicurezza del piano; José commenta al prossimo giro.</p>
    <div class="opts">${r.options.map((o) => `<button class="opt" data-k="${o.k}" type="button"><b>${esc(o.label)}</b><span>${esc(o.sub)}</span></button>`).join('')}</div>`, (el) => {
    el.querySelectorAll('.opt').forEach((b) => b.addEventListener('click', async () => { $('#dlg').close(); try { await ACT.skip(date, b.dataset.k); } catch (e) { toast(e.message); } }));
  });
}

// ---------------------------------------------------------------- Test: registra o correggi il risultato
export function testDlg() {
  const today = S.ctx.todayDate;
  openDlg(`<div class="dlg-h"><div><span class="eyebrow">Ogni 6-8 settimane</span><h2>Registra un test</h2></div>${closeBtn}</div>
    <form id="testForm" class="grid2">
      <label class="f">Tipo<select id="tType"><option value="5k">5 km al meglio</option><option value="30min">30' a sensazione</option></select></label>
      <label class="f">Data<input type="date" id="tDate" required max="${today}" value="${today}"></label>
      <label class="f">Distanza (km)<input type="number" id="tKm" min="1" max="25" step="0.01" inputmode="decimal" required value="5"></label>
      <label class="f">Tempo (min:sec)<input type="text" id="tTime" required placeholder="es. 31:20" pattern="\\d{1,3}:[0-5]\\d" inputmode="numeric"></label>
      <label class="f">FC media (facoltativa)<input type="number" id="tHr" min="80" max="220" inputmode="numeric"></label>
      <label class="f">FC max (facoltativa)<input type="number" id="tHrMax" min="80" max="230" inputmode="numeric"></label>
      <p class="small muted" style="grid-column:1/-1">Se il test è nel piano e lo corri col Garmin, il risultato lo ricavo da solo dall'uscita: qui lo puoi correggere.</p>
      <button class="btn primary lg" type="submit" style="grid-column:1/-1">Salva e ricalcola la previsione</button>
    </form>`, (el) => {
    $('#tType', el).addEventListener('change', (e) => { if (e.target.value === '30min') $('#tTime', el).value = '30:00'; else $('#tKm', el).value = 5; });
    $('#testForm', el).addEventListener('submit', async (e) => {
      e.preventDefault();
      const [mm, ss] = $('#tTime', el).value.split(':').map(Number), v = (id) => +$(id, el).value || null;
      $('#dlg').close();
      try { await ACT.testSave({ type: $('#tType', el).value, date: $('#tDate', el).value, dist_km: v('#tKm'), time_s: mm * 60 + ss, hr_avg: v('#tHr'), hr_max: v('#tHrMax') }); } catch (err) { toast(err.message); }
    });
  });
}

// ---------------------------------------------------------------- Scarpe
export function shoesDlg() {
  const list = (S.data.shoes?.list || []).map((x) => ({ ...x }));
  const row = (x, i) => `<div class="shoe-row" data-i="${i}"><label class="f">Modello<input type="text" data-f="model" maxlength="40" required value="${esc(x.model || '')}"></label>
      <label class="f">In uso dal<input type="date" data-f="start" value="${esc(x.start || S.ctx.todayDate)}"></label>
      <label class="f">Km già fatti<input type="number" data-f="km0" min="0" max="3000" inputmode="numeric" value="${x.km0 ?? 0}"></label>
      <label class="f">Avviso a km<input type="number" data-f="limit" min="200" max="1500" step="50" inputmode="numeric" value="${x.limit ?? 600}"></label>
      <label class="check"><input type="radio" name="shoeDef" ${x.def ? 'checked' : ''}> Predefinita</label>
      <label class="check"><input type="checkbox" data-f="retired" ${x.retired ? 'checked' : ''}> A riposo</label></div>`;
  const draw = () => openDlg(`<div class="dlg-h"><div><span class="eyebrow">Anagrafica</span><h2>Scarpe</h2></div>${closeBtn}</div>
    <form id="shoeForm" style="display:grid;gap:14px">${list.map(row).join('') || '<p class="muted">Nessuna scarpa: aggiungi il paio che usi adesso.</p>'}
      <div class="actions"><button class="btn" type="button" id="shoeAdd">${ico('plus')}Aggiungi un paio</button><button class="btn primary" type="submit">Salva</button></div>
      <p class="small muted">La scarpa predefinita viene associata alle corse dalla sua data d'inizio; la cambi sulla singola uscita dal dettaglio del giorno.</p></form>`, (el) => {
    const read = () => el.querySelectorAll('.shoe-row').forEach((r) => { const x = list[+r.dataset.i]; r.querySelectorAll('[data-f]').forEach((f) => { x[f.dataset.f] = f.type === 'checkbox' ? f.checked : f.type === 'number' ? +f.value : f.value; }); x.def = r.querySelector('[name="shoeDef"]').checked; });
    $('#shoeAdd', el).addEventListener('click', () => { read(); list.push({ id: 's' + Date.now().toString(36), model: '', start: S.ctx.todayDate, km0: 0, limit: 600, def: !list.some((x) => x.def) }); draw(); });
    $('#shoeForm', el).addEventListener('submit', async (e) => { e.preventDefault(); read(); $('#dlg').close(); try { await ACT.shoesSave(list.filter((x) => x.model.trim())); } catch (err) { toast(err.message); } });
  });
  draw();
}
