// ============================================================================
// Marathon Coach — dashboard (modulo ES). Legge /api/state dal Worker, calcola
// metriche col motore condiviso e si aggiorna in automatico (polling + burst
// dopo ogni azione). Senza backend raggiungibile parte in modalità DEMO.
// ============================================================================
import * as E from './lib/engine.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d = null) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage non disponibile */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* idem */ } },
};

const S = { data: null, demo: false, ctx: null, charts: {}, lastFeedId: null, lastFetch: 0, err: null, polling: null, burstUntil: 0 };

// ---------------------------------------------------------------- API REST
const API = {
  token: () => store.get('mc_token', ''),
  async req(path, opts = {}) {
    const r = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', authorization: `Bearer ${API.token()}`, ...(opts.headers || {}) } });
    const ct = r.headers.get('content-type') || '';
    if (r.status === 401) throw Object.assign(new Error('Token non valido'), { code: 401 });
    if (!ct.includes('application/json')) throw Object.assign(new Error('Backend non raggiungibile'), { code: 'nobackend' });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || `Errore ${r.status}`);
    return j;
  },
  get: (p) => API.req(p),
  post: (p, b) => API.req(p, { method: 'POST', body: JSON.stringify(b || {}) }),
};

// Azioni: in live chiamano il Worker, in demo simulano localmente
const ACT = {
  async sync() {
    if (S.demo) return toast('Demo: in live scarica le nuove uscite da Strava e avvia l\'analisi del coach.');
    const r = await API.post('/api/sync');
    toast(r.added ? `${r.added} nuove uscite: analisi del coach in arrivo` : 'Nessuna nuova uscita');
    await refresh(); burst();
  },
  async checkin(payload) {
    if (S.demo) {
      S.data.checkins[payload.date] = payload; compute();
      const t = S.ctx.today;
      S.data.feed.unshift({ id: 'd' + Date.now(), ts: Date.now(), kind: 'checkin', source: 'rules', headline: t.adapted.changes.length ? `Oggi: ${t.adapted.session?.title || 'riposo'}` : `Readiness ${t.ready.score}: piano confermato`, verdict: t.adapted.level === 'red' ? 'warning' : t.adapted.level === 'amber' ? 'info' : 'on_track', summary: t.adapted.changes.join(' ') || 'Nessun motivo per cambiare la sessione di oggi.', kpis: [{ label: 'Readiness', value: `${t.ready.score}/100`, status: 'ok' }], adjustments: [], tips: [] });
      render(); return toast('Check-in salvato (demo: in live arriva anche il commento AI)');
    }
    await API.post('/api/checkin', payload);
    toast('Check-in salvato: sessione di oggi ricalcolata, commento del coach in arrivo');
    await refresh(); burst();
  },
  async rpe(id, rpe) {
    const a = S.data.activities.find((x) => String(x.id) === String(id));
    if (a) { a.rpe = rpe || null; a.rpe_src = rpe ? 'manuale' : null; }
    if (!S.demo) await API.post(`/api/activity/${id}/rpe`, { rpe });
    compute(); render(); toast(`RPE ${rpe} salvato: carico e ACWR aggiornati`);
  },
  async analyze(id) {
    if (S.demo) return toast('Demo: in live il coach rianalizza l\'uscita con Claude.');
    await API.post(`/api/activity/${id}/analyze`); toast('Analisi avviata'); burst();
  },
  async override(date, session, reason) {
    if (session) S.data.overrides[date] = { ...session, date, override: true, reason };
    else delete S.data.overrides[date];
    if (!S.demo) await API.post('/api/override', { date, session, reason });
    compute(); render(); toast(session ? 'Sessione aggiornata' : 'Ripristinata la sessione del piano');
  },
  async trips(manual) {
    S.data.trips.manual = manual;
    if (!S.demo) await API.post('/api/trips', { manual });
    compute(); render();
  },
  async settings(patch) {
    Object.assign(S.data.settings, patch);
    if (!S.demo) S.data.settings = await API.post('/api/settings', patch);
    compute(); render(); toast('Impostazioni salvate');
  },
  async plan(body) {
    if (S.demo) {
      S.data.plan = body.mode === 'generate' ? E.generatePlan(S.data.settings) : body.sessions;
      compute(); render(); return toast(`Piano ${body.mode === 'generate' ? 'rigenerato' : 'importato'}: ${S.data.plan.length} sessioni`);
    }
    const r = await API.post('/api/plan', body); await refresh(); toast(`Piano aggiornato: ${r.count} sessioni`);
  },
  async ask(q) {
    if (S.demo) return toast('Demo: in live la domanda va al coach AI e la risposta compare qui sotto.');
    await API.post('/api/coach/ask', { q }); toast('Domanda inviata al coach'); burst();
  },
  async weekly() {
    if (S.demo) return toast('Demo: in live rigenera il focus con Claude.');
    await API.post('/api/coach/weekly', { week: E.mondayOf(S.ctx.todayDate) }); toast('Focus in preparazione'); burst();
  },
  async tripsRefresh() {
    if (S.demo) return toast('Demo: in live rilegge i calendari iCal delle trasferte.');
    await API.post('/api/trips/refresh'); await refresh(); toast('Trasferte aggiornate dal calendario');
  },
  async subscribe() { const r = await API.post('/api/strava/subscribe'); toast(r.existing ? 'Webhook già attivo' : 'Webhook Strava attivato'); await refresh(); },
  async backfill() { toast('Importo lo storico…'); const r = await API.post('/api/strava/backfill'); toast(`${r.imported} attività importate`); await refresh(); },
};

// ---------------------------------------------------------------- Calcolo
function compute() {
  const d = S.data;
  const today = d.demo ? d.serverToday : E.todayISO();
  const settings = { ...E.DEFAULT_SETTINGS, ...d.settings };
  const m = E.computeMetrics(d.activities || [], settings, today);
  const pIdx = E.planIndex(d.plan);
  const tripSet = E.tripDaySet(d.trips);
  const ci = d.checkins?.[today] || null;
  const ready = E.readiness(ci, m);
  const planned = E.effective(today, pIdx, d.overrides);
  const adapted = E.adaptSession(planned, { ci, m, trip: tripSet.has(today), ready, tripSet, date: today });
  const ph = E.phaseAt(today, settings);
  const base = { pIdx, overrides: d.overrides || {}, acts: m.acts, tripSet, today };
  const week = E.weekView(E.mondayOf(today), base);
  const plannedKm = (mon) => {
    let min = 0;
    for (let i = 0; i < 7; i++) { const p = E.effective(E.addDays(mon, i), pIdx, d.overrides); if (p && ['easy', 'quality', 'long', 'runwalk'].includes(p.kind) && !p.optional) min += p.kind === 'runwalk' ? p.min * 0.55 : p.min; }
    return (min * 60) / m.easyPace;
  };
  S.ctx = { todayDate: today, settings, m, pIdx, tripSet, ph, week, base, plannedKm, compliance: E.compliance(base, 4), today: { ci, ready, planned, adapted } };
}

// ---------------------------------------------------------------- Helpers UI
const ago = (ts) => { const s = (Date.now() - ts) / 1000; if (s < 60) return 'ora'; if (s < 3600) return `${Math.round(s / 60)} min fa`; if (s < 86400) return `${Math.round(s / 3600)} h fa`; return `${Math.round(s / 86400)} g fa`; };
const KIND_IT = { easy: 'Facile', quality: 'Qualità', long: 'Lungo', runwalk: 'Corsa/cammino', strength: 'Forza', rest: 'Riposo', race: 'Gara' };
const VERDICT = { on_track: ['In linea', 'good'], too_hard: ['Troppo forte', 'warn'], too_easy: ['Margine', 'info'], warning: ['Attenzione', 'bad'], info: ['Info', 'info'] };
const FEED_KIND = { activity: 'Uscita', checkin: 'Check-in', weekly: 'Focus settimana', answer: 'Risposta', system: 'Sistema' };
function zoneRange(zone, hrp) {
  const n = String(zone || '').match(/\d/g); if (!n) return null;
  const a = hrp.zones[+n[0] - 1], b = hrp.zones[+n[n.length - 1] - 1];
  return a && b ? `${a.lo}-${b.hi}` : null;
}
const kmEst = (min, kind) => (min ? ((kind === 'runwalk' ? min * 0.55 : min) * 60) / S.ctx.m.easyPace : 0);
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 3800);
}
function setLive() {
  const el = $('#live');
  if (S.demo) el.innerHTML = '<i class="dot demo"></i><span>Demo · dati di esempio</span>';
  else if (S.err) el.innerHTML = `<i class="dot err"></i><span>${esc(S.err)}</span>`;
  else el.innerHTML = `<i class="dot on"></i><span>Live · ${S.data.meta?.lastSync ? 'ultima uscita ' + ago(S.data.meta.lastSync) : 'in attesa di uscite'}</span>`;
}

// ---------------------------------------------------------------- Render
function render() {
  if (!S.data) return;
  const { ph } = S.ctx;
  $('#phasePill').innerHTML = `<strong>${esc(ph.name)}</strong><span class="mono">sett. ${ph.week}/${ph.total}</span>${ph.rec ? '<span class="chip" data-tone="info">scarico</span>' : ''}`;
  setLive();
  $('#app').innerHTML = `
    ${banners()}
    <section class="hero">${todayCard()}${focusCard()}${tripsCard()}</section>
    <section class="card">
      <div class="card-h"><h2>Settimana</h2><span class="muted small">Pianificato vs eseguito · tocca un giorno per modificarlo</span></div>
      <div class="week-wrap">${weekBoard()}</div>
    </section>
    <section class="kpis">${kpis()}</section>
    <section class="charts">${chartShells()}</section>
    <section class="split">
      <div class="card">${feedBlock()}</div>
      <div class="card">${activitiesBlock()}</div>
    </section>
    <section class="card">${strengthBlock()}</section>
    <section class="card">${nutritionBlock()}</section>`;
  drawCharts();
  bindMain();
}

function banners() {
  const d = S.data, out = [];
  if (S.demo) out.push(`<div class="banner"><b>Modalità demo.</b> Dati di esempio a marzo 2027 per mostrarti come lavora la dashboard. In produzione si collega al tuo Worker e a Strava. ${location.protocol.startsWith('http') && !location.hostname.endsWith('claude.ai') && !location.hostname.endsWith('claudeusercontent.com') ? '<button class="btn sm" data-a="gate">Collega il backend</button>' : ''}</div>`);
  else {
    if (!d.strava?.connected) out.push(`<div class="banner" data-tone="info"><b>Strava non collegato.</b> Autorizza la lettura delle attività: da lì in poi ogni uscita arriva da sola. <a class="btn sm primary" href="/auth/strava?k=${encodeURIComponent(API.token())}">Collega Strava</a></div>`);
    else if (!d.strava.scopeOk) out.push('<div class="banner" data-tone="bad">Strava collegato senza il permesso "attività private". Ricollega e lascia spunta la casella delle attività.</div>');
    else if (!d.strava.subscription) out.push('<div class="banner" data-tone="info">Webhook Strava non attivo: le uscite arrivano solo col sync giornaliero. <button class="btn sm" data-a="subscribe">Attiva sync istantanea</button></div>');
    if (!d.ai) out.push('<div class="banner" data-tone="info">Coach AI spento: manca la chiave Anthropic sul Worker. Il motore a regole funziona comunque.</div>');
  }
  if (S.ctx.m.hrp.src === 'provvisoria') out.push('<div class="banner" data-tone="info">Zone FC provvisorie (FCmax 185). Inserisci età o FC max nelle impostazioni per tararle. <button class="btn sm" data-a="settings">Imposta</button></div>');
  return out.join('');
}

function ring(score, tone) {
  const C = 2 * Math.PI * 46, off = C * (1 - score / 100);
  const col = tone === 'good' ? 'var(--good)' : tone === 'warn' ? 'var(--warn)' : 'var(--bad)';
  return `<div class="ring"><svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="46" fill="none" stroke="var(--surface-2)" stroke-width="8"/><circle cx="50" cy="50" r="46" fill="none" stroke="${col}" stroke-width="8" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${off}"/></svg><div class="v"><b>${score}</b><span>Readiness</span></div></div>`;
}
function todayCard() {
  const { todayDate, m, settings, tripSet } = S.ctx, { ci, ready, planned, adapted } = S.ctx.today;
  const s = adapted.session, trip = tripSet.get(todayDate);
  const f = E.fueling(s, settings);
  const range = s ? zoneRange(s.zone, m.hrp) : null;
  const km = s ? kmEst(s.min, s.kind) : 0;
  const isRunS = s && ['easy', 'quality', 'long', 'runwalk', 'race'].includes(s.kind);
  return `<article class="card today">
    <div class="card-h"><span class="eyebrow">Oggi · ${E.DOW_IT_LONG[E.dow(todayDate)]} ${E.fmtDate(todayDate)}</span>
      <span style="display:flex;gap:6px;flex-wrap:wrap">${trip ? `<span class="chip" data-tone="info">Trasferta · ${esc(trip)}</span>` : ''}${adapted.changes.length ? `<span class="chip" data-tone="${adapted.level === 'red' ? 'bad' : 'warn'}">Adattata</span>` : planned ? '<span class="chip" data-tone="good">Da piano</span>' : ''}</span></div>
    <div class="today-grid"><div>
      ${s ? `<span class="chip" data-tone="accent">${esc(KIND_IT[s.kind] || s.kind)}${s.optional ? ' · facoltativa' : ''}</span>
      <h2 class="session-title">${esc(s.title)}</h2>
      <dl class="meta">
        ${s.min ? `<div><dt>Durata</dt><dd>${E.fmtMin(s.min)}</dd></div>` : ''}
        ${isRunS && km ? `<div><dt>Stima</dt><dd>~${km.toFixed(1)} km</dd></div>` : ''}
        ${s.rpe && s.rpe !== '-' ? `<div><dt>RPE</dt><dd>${esc(s.rpe)}</dd></div>` : ''}
        ${range ? `<div><dt>FC ${esc(s.zone)}</dt><dd>${range} bpm</dd></div>` : ''}
        ${s.strength ? `<div><dt>Forza</dt><dd>Routine ${s.strength}</dd></div>` : ''}
      </dl>
      <p class="desc">${esc(s.desc)}${s.tripNote ? ' ' + esc(s.tripNote) : ''}</p>` : `<h2 class="session-title">${S.ctx.ph.id === 'pre' ? 'Si parte il 10 dicembre' : 'Nessuna sessione'}</h2><p class="desc">${esc(S.ctx.ph.focus)}</p>`}
      ${adapted.changes.length ? `<ul class="changes" data-level="${adapted.level}">${adapted.changes.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}
      ${s ? `<div class="fuel">${f.pre ? `<div><span class="eyebrow">Prima</span><p>${esc(f.pre)}</p></div>` : ''}${f.during ? `<div><span class="eyebrow">Durante</span><p>${esc(f.during)}</p></div>` : ''}${f.post ? `<div><span class="eyebrow">Dopo</span><p>${esc(f.post)}</p></div>` : ''}</div>` : ''}
    </div>
    <div class="ready">${ring(ready.score, ready.tone)}
      <div class="factors">${ci ? (ready.factors.length ? esc(ready.factors.join(' · ')) : 'Nessun segnale di fatica') : 'Check-in non fatto: valore stimato dai dati'}</div>
      <button class="btn sm ${ci ? '' : 'primary'}" data-a="checkin" type="button">${ci ? 'Aggiorna check-in' : 'Fai il check-in'}</button>
    </div></div>
  </article>`;
}

function focusCard() {
  const { todayDate, ph, plannedKm } = S.ctx, mon = E.mondayOf(todayDate);
  const w = S.data.weekly?.[mon];
  const pk = plannedKm(mon);
  if (!w) {
    const keys = S.ctx.week.filter((d) => d.plan && !['rest'].includes(d.plan.kind) && !d.plan.optional).slice(0, 4).map((d) => `${E.DOW_IT[E.dow(d.date)]}: ${d.plan.title} (${E.fmtMin(d.plan.min)})`);
    return `<article class="card"><div class="card-h"><h2>Focus della settimana</h2><span class="chip" data-tone="muted">dal piano</span></div>
      <h3 class="focus-title">${esc(ph.name)}${ph.rec ? ' · settimana di scarico' : ''}</h3><p class="muted">${esc(ph.focus)}</p>
      <ul class="keys">${keys.map((k) => `<li>${esc(k)}</li>`).join('')}</ul>
      <div class="targets"><div class="target"><span>Volume</span><b>~${pk.toFixed(0)} km</b></div><div class="target"><span>Z1-Z2</span><b>≥ 80%</b></div></div>
      ${S.data.ai || S.demo ? '<button class="btn sm" data-a="weekly" type="button">Chiedi il focus al coach</button>' : ''}</article>`;
  }
  return `<article class="card"><div class="card-h"><h2>Focus della settimana</h2><span class="chip" data-tone="${w.source === 'ai' ? 'accent' : 'muted'}">${w.source === 'ai' ? 'coach AI' : 'dal piano'}</span></div>
    <h3 class="focus-title">${esc(w.title)}</h3><p class="muted">${esc(w.why)}</p>
    <ul class="keys">${(w.keys || []).map((k) => `<li>${esc(k)}</li>`).join('')}</ul>
    <div class="targets">${(w.targets || []).map((t) => `<div class="target"><span>${esc(t.label)}</span><b>${esc(t.value)}</b></div>`).join('')}</div>
    <div class="notes">${w.travel ? `<div><b>Trasferte:</b> ${esc(w.travel)}</div>` : ''}${w.nutrition ? `<div><b>Integrazione:</b> ${esc(w.nutrition)}</div>` : ''}${w.watch ? `<div><b>Da monitorare:</b> ${esc(w.watch)}</div>` : ''}</div>
    <div style="margin-top:10px"><button class="btn sm ghost" data-a="weekly" type="button">Rigenera</button></div></article>`;
}

function tripsCard() {
  const { todayDate, tripSet, base } = S.ctx;
  const cells = [];
  for (let i = 0; i < 14; i++) {
    const d = E.addDays(todayDate, i), t = tripSet.get(d);
    cells.push(`<div class="${t ? 'trip' : ''} ${i === 0 ? 'today-c' : ''}" title="${esc(E.fmtDate(d) + (t ? ' · ' + t : ''))}"><i></i>${E.DOW_IT[E.dow(d)][0]}</div>`);
  }
  const trips = [...(S.data.trips?.manual || []).map((t) => ({ ...t, source: 'manual' })), ...(S.data.trips?.ical || [])]
    .filter((t) => (t.end || t.start) >= todayDate).sort((a, b) => a.start.localeCompare(b.start)).slice(0, 5);
  const warn = (t) => {
    const out = [];
    for (let d = t.start; d <= (t.end || t.start); d = E.addDays(d, 1)) { const p = E.effective(d, base.pIdx, base.overrides); if (p?.kind === 'long' || (p && p.hotel === false && p.kind !== 'rest')) out.push(`${E.DOW_IT[E.dow(d)]}: ${p.title}`); }
    return out;
  };
  return `<article class="card"><div class="card-h"><h2>Trasferte</h2><span class="muted small">prossimi 14 giorni</span></div>
    <div class="strip">${cells.join('')}</div>
    ${trips.length ? `<ul class="trip-list">${trips.map((t) => { const w = warn(t); return `<li><div><b>${esc(t.city || t.title)}</b> <span class="sub mono">${E.fmtDate(t.start)}${t.end && t.end !== t.start ? '→' + E.fmtDate(t.end) : ''}</span>
      <div class="sub">${w.length ? `Da adattare: ${esc(w.join(', '))}` : 'Sessioni già compatibili con l\'hotel'}${t.source === 'ical' ? ' · da calendario' : ''}</div></div>
      ${t.source === 'manual' ? `<button class="btn sm ghost" data-a="trip-del" data-id="${esc(t.id)}" aria-label="Elimina trasferta">✕</button>` : '<span></span>'}</li>`; }).join('')}</ul>` : '<p class="muted small">Nessuna trasferta in vista.</p>'}
    <form class="trip-form" id="tripForm">
      <label class="f">Dal<input type="date" id="tripFrom" required value="${E.addDays(todayDate, 1)}"></label>
      <label class="f">Al<input type="date" id="tripTo" required value="${E.addDays(todayDate, 2)}"></label>
      <input type="text" id="tripCity" class="full" placeholder="Città (es. Bologna)" maxlength="40">
      <button class="btn sm full" type="submit">Aggiungi trasferta</button>
    </form>
    <p class="muted small" style="margin:8px 0 0">${S.data.settings?.icalUrls ? `Calendario collegato${S.data.trips?.icalUpdated ? ' · letto ' + ago(S.data.trips.icalUpdated) : ''}. <button class="btn sm ghost" data-a="trips-refresh" type="button">Rileggi</button>` : 'Collega il calendario trasferte dalle impostazioni per averle in automatico.'}</p>
  </article>`;
}

function weekBoard() {
  const LBL = { done: ['Fatta', 'good'], partial: ['Parziale', 'warn'], missed: ['Saltata', 'bad'], extra: ['Extra', 'info'], today: ['Oggi', 'accent'], planned: ['', ''], rest: ['', ''] };
  return `<div class="week">${S.ctx.week.map((d) => {
    const p = d.plan, [lbl, tone] = LBL[d.status] || ['', ''];
    const a = d.done.filter(E.isRun);
    return `<button class="day ${d.date === S.ctx.todayDate ? 'is-today' : ''}" data-day="${d.date}" type="button">
      <div class="dh"><b>${E.DOW_IT[E.dow(d.date)]}</b><span class="mono">${E.fmtDate(d.date)}</span></div>
      <div class="kind-bar" data-k="${p?.kind || ''}"></div>
      ${d.trip ? `<span class="trip-tag">${esc(d.trip)}</span>` : ''}
      <div class="pt">${p ? esc(p.title) : '—'}${p?.override ? ' <span class="chip" data-tone="warn">mod.</span>' : ''}</div>
      ${p && p.min ? `<div class="pm">${E.fmtMin(p.min)} · RPE ${esc(p.rpe)}${p.strength ? ' · forza ' + p.strength : ''}${p.optional ? ' · facolt.' : ''}</div>` : p?.strength ? `<div class="pm">forza ${p.strength}</div>` : ''}
      ${a.length ? `<div class="done">${a.map((x) => `${x.dist_km.toFixed(1)} km · ${E.fmtPace(x.pace_s)}${x.avg_hr ? ' · ' + x.avg_hr + ' bpm' : ''}`).join('<br>')}</div>` : ''}
      ${lbl ? `<span class="chip" data-tone="${tone}" style="justify-self:start">${lbl}</span>` : ''}
    </button>`;
  }).join('')}</div>`;
}

function kpis() {
  const { m, plannedKm, todayDate, compliance } = S.ctx;
  const band = E.acwrBand(m.acwr, m.calibrating);
  const pk = plannedKm(E.mondayOf(todayDate));
  const formTone = m.form == null ? 'muted' : m.form < -30 ? 'bad' : m.form < -10 ? 'warn' : 'good';
  const formLbl = m.form == null ? 'In calibrazione' : m.form < -30 ? 'Molto affaticato' : m.form < -10 ? 'Carico in assorbimento' : m.form > 10 ? 'Fresco' : 'Equilibrato';
  const monoTone = m.monotony > 2 ? 'bad' : m.monotony > 1.5 ? 'warn' : 'good';
  const polTone = m.polar == null ? '' : m.polar >= 80 ? 'good' : m.polar >= 70 ? 'warn' : 'bad';
  const efTone = m.efTrend == null ? '' : m.efTrend >= 0 ? 'good' : 'warn';
  const T = (tone, label, v, small, d) => `<div class="kpi" data-tone="${tone}"><span class="eyebrow">${label}</span><div class="kv"><b>${v}</b><small>${small || ''}</small></div><span class="kd">${d}</span></div>`;
  return [
    T(E.dow(todayDate) === 0 && m.kmDelta > 15 ? 'warn' : m.week.km > pk * 1.15 ? 'warn' : 'good', 'Volume settimana', m.week.km.toFixed(1), `/ ~${pk.toFixed(0)} km`, `${m.week.runs} uscite · scorsa ${m.prevWeek ? m.prevWeek.km.toFixed(1) + ' km' : '—'}${E.dow(todayDate) === 0 && m.kmDelta != null ? ` (${m.kmDelta >= 0 ? '+' : ''}${m.kmDelta.toFixed(0)}%)` : ''}`),
    T(band.tone, 'ACWR carico acuto/cronico', m.calibrating || m.acwr == null ? '—' : m.acwr.toFixed(2), 'EWMA 7/28', `<span class="chip" data-tone="${band.tone}">${band.label}</span> ottimale 0,8-1,3`),
    T(formTone, 'Forma (CTL-ATL)', m.form == null ? '—' : `${m.form > 0 ? '+' : ''}${m.form.toFixed(0)}%`, '', formLbl),
    T(monoTone, 'Monotonia 7 gg', m.monotony.toFixed(2), `strain ${m.strain}`, m.monotony > 2 ? 'Allenamenti troppo uguali: varia' : 'Varietà di carico ok (< 1,5)'),
    T(polTone, 'Tempo in Z1-Z2 · 28 gg', m.polar == null ? '—' : `${m.polar.toFixed(0)}%`, 'target ≥ 80%', m.polar == null ? 'Servono uscite con FC' : m.polar >= 80 ? 'Base aerobica protetta' : 'Rallenta le uscite facili'),
    T(efTone, 'Efficienza aerobica', m.efNow ? m.efNow.toFixed(2) : '—', 'm/min per bpm', m.efTrend == null ? 'Serve un mese di uscite facili' : `${m.efTrend >= 0 ? '+' : ''}${m.efTrend.toFixed(1)}% vs 4 settimane prima`),
    T(compliance == null ? '' : compliance >= 80 ? 'good' : compliance >= 60 ? 'warn' : 'bad', 'Aderenza piano · 4 sett.', compliance == null ? '—' : `${compliance}%`, '', 'Sessioni non facoltative completate ≥ 80%'),
    T('', 'Lungo più lungo · 28 gg', m.longest28 ? E.fmtMin(m.longest28.moving_min) : '—', m.longest28 ? `${m.longest28.dist_km.toFixed(1)} km` : '', m.longest28 ? `${E.fmtDate(m.longest28.date)} · ${E.fmtPace(m.longest28.pace_s)}` : 'Nessun lungo recente'),
  ].join('');
}

const CHARTS = [
  ['vol', 'Volume settimanale', 'Km corsi (barre) contro km stimati dal piano (linea).'],
  ['acwr', 'ACWR · rischio infortuni', 'Fascia verde 0,8-1,3. Sopra 1,5 il carico sale troppo in fretta.'],
  ['load', 'Carico giornaliero', 'Carico sessione (minuti × RPE), media acuta 7 gg e cronica 28 gg.'],
  ['zones', 'Zone FC per settimana', 'Quota di tempo per zona. In base aerobica Z1-Z2 almeno all\'80%.'],
  ['ef', 'Efficienza aerobica', 'Velocità per battito sulle uscite facili: se sale, il motore migliora.'],
  ['scatter', 'Passo vs FC', 'Ogni punto è un\'uscita; i più recenti sono più scuri. Verso il basso a sinistra = più in forma.'],
];
const chartShells = () => CHARTS.map(([id, t, p]) => `<div class="card chart-card"><h3>${t}</h3><p>${p}</p><div class="chart-box"><canvas id="ch-${id}" role="img" aria-label="${t}"></canvas></div></div>`).join('');

function feedBlock() {
  const feed = S.data.feed || [];
  const item = (f) => {
    const [vl, vt] = VERDICT[f.verdict] || VERDICT.info;
    return `<div class="fi ${f.id === S.newFeedId ? 'new' : ''}" data-v="${esc(f.verdict)}">
      <div class="fh"><span class="chip" data-tone="muted">${FEED_KIND[f.kind] || 'Coach'}</span><span class="chip" data-tone="${vt}">${vl}</span><span class="chip" data-tone="${f.source === 'ai' ? 'accent' : 'muted'}">${f.source === 'ai' ? 'AI' : 'regole'}</span><span>${ago(f.ts)}${f.refDate ? ' · ' + E.fmtDate(f.refDate) : ''}</span></div>
      ${f.question ? `<div class="q">“${esc(f.question)}”</div>` : ''}
      <h4>${esc(f.headline)}</h4><p>${esc(f.summary)}</p>
      ${f.kpis?.length ? `<div class="fk">${f.kpis.map((k) => `<span data-s="${esc(k.status)}">${esc(k.label)} <b>${esc(k.value)}</b></span>`).join('')}</div>` : ''}
      ${f.adjustments?.length ? `<div class="adj">${f.adjustments.map((a, i) => `<div><span><b class="mono">${E.DOW_IT[E.dow(a.date)]} ${E.fmtDate(a.date)}</b> · ${esc(a.new_title || a.action)}${a.new_min ? ' · ' + a.new_min + '\'' : ''}${a.reason ? ' — ' + esc(a.reason) : ''}</span><button class="btn sm" data-a="apply" data-f="${esc(f.id)}" data-i="${i}" type="button">Applica</button></div>`).join('')}</div>` : ''}
      ${f.tips?.length ? `<div class="tips">${f.tips.map((t) => `<span><b>${esc(t.type)}:</b> ${esc(t.text)}</span>`).join('')}</div>` : ''}
      ${f.error ? `<div class="small" style="color:var(--bad)">AI non disponibile: ${esc(f.error)}</div>` : ''}
    </div>`;
  };
  return `<div class="card-h"><h2>Coach Live Feedback</h2><span class="muted small">${S.burstUntil > Date.now() ? 'in ascolto…' : 'si aggiorna da solo'}</span></div>
    <form class="ask" id="askForm"><input type="text" id="askQ" placeholder="Chiedi al coach: es. domani sono a Firenze, cosa faccio?" maxlength="500"><button class="btn primary" type="submit">Chiedi</button></form>
    <div class="feed">${feed.length ? feed.slice(0, 30).map(item).join('') : '<div class="empty">Il primo commento arriva dopo la prima uscita sincronizzata o il primo check-in.</div>'}</div>`;
}

function zbar(a) {
  const z = E.zoneSeconds(a, S.ctx.m.hrp), t = z.reduce((x, y) => x + y, 0);
  if (!t) return '<span class="muted">—</span>';
  return `<span class="zbar" title="${z.map((v, i) => `Z${i + 1} ${Math.round((v / t) * 100)}%`).join(' · ')}">${z.map((v, i) => `<i style="width:${(v / t) * 100}%;background:var(--z${i + 1})"></i>`).join('')}</span>`;
}
function activitiesBlock() {
  const acts = [...S.ctx.m.acts].reverse().slice(0, 18), hrp = S.ctx.m.hrp;
  if (!acts.length) return '<div class="card-h"><h2>Attività</h2></div><div class="empty">Ancora nessuna uscita. Appena registri con Garmin, arriva qui via Strava.</div>';
  return `<div class="card-h"><h2>Attività</h2><span class="muted small">RPE: scegli il valore dopo ogni uscita, oppure scrivi "RPE 6" nella descrizione su Strava</span></div>
  <div class="tbl-wrap"><table><thead><tr><th>Data</th><th>Uscita</th><th>Km</th><th>Tempo</th><th>Passo</th><th>FC</th><th>Zone</th><th>RPE</th><th>Carico</th><th>Deriva</th></tr></thead><tbody>
  ${acts.map((a) => { const r = E.rpeOf(a, hrp); return `<tr class="click" data-act="${a.id}">
    <td class="n">${E.fmtDate(a.date)}</td><td><span class="nm" title="${esc(a.name)}">${esc(a.name)}</span></td>
    <td class="n">${E.isRun(a) ? a.dist_km.toFixed(1) : '—'}</td><td class="n">${E.fmtMin(a.moving_min)}</td><td class="n">${E.isRun(a) ? E.fmtPace(a.pace_s) : '—'}</td>
    <td class="n">${a.avg_hr || '—'}</td><td>${zbar(a)}</td>
    <td><select data-rpe="${a.id}" aria-label="RPE">${['', 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((v) => `<option value="${v}" ${(!r.est && r.v === v) ? 'selected' : ''}>${v === '' ? (r.est ? `~${r.v}` : '—') : v}</option>`).join('')}</select></td>
    <td class="n">${E.loadOf(a, hrp)}</td><td class="n">${a.decoupling != null ? a.decoupling + '%' : '—'}</td></tr>`; }).join('')}
  </tbody></table></div>`;
}

function strengthBlock() {
  return `<div class="card-h"><h2>Forza in camera</h2><span class="muted small">Corpo libero, zero attrezzi. Le routine sono richiamate dal piano.</span></div>
  <div class="lib">${Object.entries(E.STRENGTH).map(([k, r]) => `<div class="routine"><span class="rk">ROUTINE ${k} · ${r.min}'</span><h3>${esc(r.name)}</h3><ol>${r.ex.map(([n, d, c]) => `<li><b>${esc(n)}</b> <span class="mono">${esc(d)}</span><span>${esc(c)}</span></li>`).join('')}</ol></div>`).join('')}</div>`;
}

function nutritionBlock() {
  const ph = S.ctx.ph;
  const longP = S.data.plan.find((p) => p.kind === 'long' && p.date >= S.ctx.todayDate);
  const defMin = longP?.min || 90;
  return `<div class="card-h"><h2>Integrazione & strategia</h2><span class="muted small">Fase attuale: ${esc(ph.name)}</span></div>
  <div class="nutri"><div>
    <span class="eyebrow">Calcolatore per il prossimo lungo</span>
    <div class="calc" style="margin-top:8px">
      <label class="f">Durata (min)<input type="number" id="fcMin" min="30" max="360" value="${defMin}"></label>
      <label class="f">Temperatura (°C)<input type="number" id="fcTemp" min="-5" max="40" value="16"></label>
    </div>
    <div class="calc-out" id="fcOut"></div>
    <p class="muted small" style="margin-top:8px">Gel da ~25 g di carboidrati, il primo dopo 45'. Prova in allenamento ogni prodotto che userai in gara.</p>
  </div><div>
    <span class="eyebrow">${ph.id === 'taper' ? 'Scarico: cosa fare adesso' : 'Piano di scarico (ultime 3 settimane)'}</span>
    <ul class="timeline" style="margin-top:6px">${E.TAPER_TIMELINE.map((t) => `<li><b>${esc(t.when)}</b><span>${esc(t.what)}</span></li>`).join('')}</ul>
  </div></div>`;
}
function updateFuelCalc() {
  const o = $('#fcOut'); if (!o) return;
  const r = E.fuelCalc(+$('#fcMin').value || 0, +$('#fcTemp').value || 16);
  o.innerHTML = `<div><b>${r.carbs} g</b><span>Carboidrati</span></div><div><b>${r.gels}</b><span>Gel</span></div><div><b>${(r.water / 1000).toFixed(1)} L</b><span>Acqua</span></div><div><b>${r.sodium} mg</b><span>Sodio</span></div>`;
}

// ---------------------------------------------------------------- Grafici (Chart.js)
function drawCharts() {
  if (!window.Chart) return;
  Object.values(S.charts).forEach((c) => c.destroy()); S.charts = {};
  const { m, plannedKm, todayDate } = S.ctx;
  const ink = css('--ink-2'), grid = css('--line'), acc = css('--accent'), lane = css('--lane');
  Chart.defaults.color = ink; Chart.defaults.font.family = css('--f-body'); Chart.defaults.font.size = 11; Chart.defaults.borderColor = grid;
  const base = { responsive: true, maintainAspectRatio: false, animation: false, plugins: { legend: { labels: { boxWidth: 10, boxHeight: 10 } } }, scales: { x: { grid: { display: false } }, y: { grid: { color: grid }, beginAtZero: true } } };
  const fmtW = (w) => E.fmtDate(w);

  // 1 Volume: ultime 12 settimane + 3 future pianificate
  const weeks = m.weeks.slice(-12);
  const labels = weeks.map((w) => w.week);
  for (let i = 1; i <= 3; i++) labels.push(E.addDays(E.mondayOf(todayDate), 7 * i));
  S.charts.vol = new Chart($('#ch-vol'), { data: { labels: labels.map(fmtW), datasets: [
    { type: 'bar', label: 'Eseguiti', data: labels.map((w) => m.weeks.find((x) => x.week === w)?.km ?? null), backgroundColor: acc, borderRadius: 3, maxBarThickness: 22 },
    { type: 'line', label: 'Piano (stima)', data: labels.map((w) => Math.round(plannedKm(w) * 10) / 10), borderColor: lane, backgroundColor: lane, borderDash: [4, 3], pointRadius: 2, tension: 0.3 },
  ] }, options: { ...base, scales: { ...base.scales, y: { ...base.scales.y, title: { display: true, text: 'km' } } } } });

  // 2-3 ACWR e carico (ultimi 90 giorni)
  const ser = m.series.slice(-90);
  const bands = { id: 'bands', beforeDatasetsDraw(c) {
    const { ctx, chartArea: a, scales: { y } } = c; if (!a) return;
    const fill = (lo, hi, col) => { const top = y.getPixelForValue(Math.min(hi, y.max)), bot = y.getPixelForValue(Math.max(lo, y.min)); if (bot <= top) return; ctx.fillStyle = col; ctx.fillRect(a.left, top, a.right - a.left, bot - top); };
    ctx.save(); ctx.globalAlpha = 0.16; fill(0.8, 1.3, css('--good')); fill(1.3, 1.5, css('--warn')); fill(1.5, 9, css('--bad')); ctx.restore();
  } };
  const calStart = m.calibrating ? ser.length : ser.findIndex((x) => x.date >= E.addDays(m.acts[0]?.date || todayDate, 21));
  S.charts.acwr = new Chart($('#ch-acwr'), { type: 'line', plugins: [bands], data: { labels: ser.map((x) => E.fmtDate(x.date)), datasets: [
    { label: 'ACWR', data: ser.map((x, i) => (i >= calStart && x.acwr != null ? Math.round(x.acwr * 100) / 100 : null)), borderColor: css('--ink'), borderWidth: 2, pointRadius: 0, tension: 0.25, spanGaps: true },
  ] }, options: { ...base, plugins: { legend: { display: false } }, scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 6 } }, y: { min: 0, max: 2, grid: { color: grid } } } } });

  S.charts.load = new Chart($('#ch-load'), { data: { labels: ser.map((x) => E.fmtDate(x.date)), datasets: [
    { type: 'bar', label: 'Carico', data: ser.map((x) => x.load || null), backgroundColor: css('--z2'), borderRadius: 2, maxBarThickness: 6 },
    { type: 'line', label: 'Acuto 7 gg', data: ser.map((x) => Math.round(x.acute)), borderColor: acc, pointRadius: 0, borderWidth: 2, tension: 0.3 },
    { type: 'line', label: 'Cronico 28 gg', data: ser.map((x) => Math.round(x.chronic)), borderColor: css('--ink'), pointRadius: 0, borderWidth: 2, borderDash: [5, 3], tension: 0.3 },
  ] }, options: { ...base, scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 6 } }, y: { ...base.scales.y } } } });

  // 4 Zone
  const zw = m.weeks.slice(-10);
  S.charts.zones = new Chart($('#ch-zones'), { type: 'bar', data: { labels: zw.map((w) => fmtW(w.week)), datasets: [0, 1, 2, 3, 4].map((i) => ({
    label: `Z${i + 1}`, data: zw.map((w) => { const t = w.z.reduce((a, b) => a + b, 0); return t ? Math.round((w.z[i] / t) * 100) : 0; }), backgroundColor: css(`--z${i + 1}`), maxBarThickness: 26,
  })) }, options: { ...base, scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, max: 100, grid: { color: grid }, ticks: { callback: (v) => v + '%' } } } } });

  // 5 Efficienza
  const ef = m.efSeries.slice(-40);
  S.charts.ef = new Chart($('#ch-ef'), { type: 'line', data: { labels: ef.map((x) => E.fmtDate(x.date)), datasets: [
    { label: 'EF', data: ef.map((x) => x.ef), borderColor: acc, backgroundColor: css('--accent-soft'), fill: true, pointRadius: 2.5, tension: 0.3 },
  ] }, options: { ...base, plugins: { legend: { display: false } }, scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 6 } }, y: { grid: { color: grid } } } } });

  // 6 Passo vs FC
  const sc = m.scatter.slice(-60), n = sc.length;
  S.charts.scatter = new Chart($('#ch-scatter'), { type: 'scatter', data: { datasets: [{ label: 'Uscite', data: sc.map((p) => ({ x: p.x, y: p.y, name: p.name, date: p.date })), pointRadius: 4,
    backgroundColor: sc.map((_, i) => { const c = lane; return c.startsWith('#') ? c + Math.round(60 + (195 * (i + 1)) / n).toString(16).padStart(2, '0') : c; }) }] },
    options: { ...base, plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${E.fmtDate(c.raw.date)} · ${E.fmtPace(c.raw.x)} · ${c.raw.y} bpm` } } },
      scales: { x: { reverse: true, grid: { color: grid }, title: { display: true, text: 'passo (min/km)' }, ticks: { callback: (v) => E.fmtPace(v).replace('/km', '') } }, y: { grid: { color: grid }, title: { display: true, text: 'FC media' } } } } });
}

// ---------------------------------------------------------------- Dialog
function openDlg(html, onBind) {
  $('#dlgBody').innerHTML = html;
  const d = $('#dlg'); if (!d.open) d.showModal();
  $('#dlgBody').querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => d.close()));
  onBind && onBind($('#dlgBody'));
}
const scale = (name, val, labels) => `<fieldset><legend>${labels}</legend><div class="scale">${[1, 2, 3, 4, 5].map((v) => `<label><input type="radio" name="${name}" value="${v}" ${v === val ? 'checked' : ''}><span>${v}</span></label>`).join('')}</div></fieldset>`;

function checkinDlg() {
  const { todayDate, tripSet } = S.ctx, c = S.data.checkins?.[todayDate] || {};
  openDlg(`<div class="dlg-h"><h2>Check-in di oggi</h2><button class="btn ghost" data-close type="button">Chiudi</button></div>
    <form id="ciForm" class="grid2" style="gap:14px">
      ${scale('sleep', c.sleep || 3, 'Sonno (1 pessimo · 5 ottimo)')}
      ${scale('energy', c.energy || 3, 'Energia (1 a terra · 5 carico)')}
      ${scale('stress', c.stress || 3, 'Stress lavoro (1 zero · 5 altissimo)')}
      <label class="f">Indolenzimento muscolare (0-10)<input type="number" id="ciSore" min="0" max="10" value="${c.soreness ?? 0}"></label>
      <label class="f">Fastidio/dolore localizzato: zona<input type="text" id="ciArea" placeholder="es. polpaccio sx" value="${esc(c.pain?.area || '')}" maxlength="40"></label>
      <label class="f">Intensità fastidio (0-10)<input type="number" id="ciPain" min="0" max="10" value="${c.pain?.level ?? 0}"></label>
      <label class="f" style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="ciTravel" ${c.travel ?? tripSet.has(todayDate) ? 'checked' : ''}> Giornata di viaggio / trasferta</label>
      <label class="f" style="grid-column:1/-1">Nota per il coach<textarea id="ciNote" maxlength="300" placeholder="es. 4 ore di treno, mangiato tardi">${esc(c.note || '')}</textarea></label>
      <div style="grid-column:1/-1;display:flex;gap:8px;justify-content:flex-end"><button class="btn" data-close type="button">Annulla</button><button class="btn primary" type="submit">Salva e ricalcola</button></div>
    </form>`, (r) => {
    $('#ciForm', r).addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target, v = (n) => +f.querySelector(`input[name="${n}"]:checked`)?.value || 3;
      const payload = { date: todayDate, sleep: v('sleep'), energy: v('energy'), stress: v('stress'), soreness: +$('#ciSore', r).value || 0, travel: $('#ciTravel', r).checked, pain: { area: $('#ciArea', r).value, level: +$('#ciPain', r).value || 0 }, note: $('#ciNote', r).value };
      $('#dlg').close();
      try { await ACT.checkin(payload); } catch (err) { toast(err.message); }
    });
  });
}

function dayDlg(date) {
  const { base, tripSet, m, settings } = S.ctx;
  const p = E.effective(date, base.pIdx, base.overrides), orig = base.pIdx[date];
  const acts = m.acts.filter((a) => a.date === date);
  const f = p ? E.fueling(p, settings) : null;
  const range = p ? zoneRange(p.zone, m.hrp) : null;
  const st = p?.strength ? E.STRENGTH[p.strength] : null;
  openDlg(`<div class="dlg-h"><div><span class="eyebrow">${E.DOW_IT_LONG[E.dow(date)]} ${E.fmtDate(date)}${tripSet.has(date) ? ' · trasferta ' + esc(tripSet.get(date)) : ''}</span><h2>${esc(p?.title || 'Nessuna sessione')}</h2></div><button class="btn ghost" data-close type="button">Chiudi</button></div>
    ${p ? `<dl class="meta">${p.min ? `<div><dt>Durata</dt><dd>${E.fmtMin(p.min)}</dd></div>` : ''}${p.rpe && p.rpe !== '-' ? `<div><dt>RPE</dt><dd>${esc(p.rpe)}</dd></div>` : ''}${range ? `<div><dt>FC</dt><dd>${range} bpm</dd></div>` : ''}<div><dt>Tipo</dt><dd>${esc(KIND_IT[p.kind] || p.kind)}</dd></div></dl>
    <p class="desc">${esc(p.desc)}</p>${p.override ? `<p class="small muted">Modificata${p.reason ? ': ' + esc(p.reason) : ''}. Originale: ${esc(orig?.title || '—')} ${orig?.min ? E.fmtMin(orig.min) : ''}</p>` : ''}
    ${st ? `<div><span class="eyebrow">Routine ${p.strength} · ${esc(st.name)}</span><ol class="small">${st.ex.map(([n, d]) => `<li>${esc(n)} — <span class="mono">${esc(d)}</span></li>`).join('')}</ol></div>` : ''}
    ${f && (f.pre || f.during) ? `<div class="notes">${f.pre ? `<div><b>Prima:</b> ${esc(f.pre)}</div>` : ''}${f.during ? `<div><b>Durante:</b> ${esc(f.during)}</div>` : ''}<div><b>Dopo:</b> ${esc(f.post)}</div></div>` : ''}` : ''}
    ${acts.length ? `<div><span class="eyebrow">Eseguito</span>${acts.map((a) => `<p class="small mono" style="margin:4px 0">${esc(a.name)} · ${a.dist_km.toFixed(2)} km · ${E.fmtMin(a.moving_min)} · ${E.fmtPace(a.pace_s)} · FC ${a.avg_hr || '—'}${a.decoupling != null ? ' · deriva ' + a.decoupling + '%' : ''}</p>${a.splits?.length ? `<div class="tbl-wrap"><table><thead><tr><th>Km</th><th>Passo</th><th>FC</th><th>Disl.</th></tr></thead><tbody>${a.splits.map((s, i) => `<tr><td class="n">${i + 1}</td><td class="n">${E.fmtPace(s.p)}</td><td class="n">${s.hr || '—'}</td><td class="n">${s.el}</td></tr>`).join('')}</tbody></table></div>` : ''}`).join('')}</div>` : ''}
    ${p && date >= S.ctx.todayDate ? `<div><span class="eyebrow">Adatta questa giornata</span><div class="actions" style="margin-top:6px">
      <button class="btn sm" data-ov="reduce" type="button">-25% volume</button>
      <button class="btn sm" data-ov="easy" type="button">Solo facile</button>
      <button class="btn sm" data-ov="hotel" type="button">Versione hotel</button>
      <button class="btn sm" data-ov="rest" type="button">Riposo</button>
      ${p.override ? '<button class="btn sm primary" data-ov="reset" type="button">Ripristina piano</button>' : ''}
    </div></div>` : ''}`, (r) => {
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

function settingsDlg() {
  const s = S.ctx.settings, hrp = S.ctx.m.hrp, d = S.data;
  openDlg(`<div class="dlg-h"><h2>Impostazioni</h2><button class="btn ghost" data-close type="button">Chiudi</button></div>
    <form id="setForm" style="display:grid;gap:14px">
      <div><span class="eyebrow">Profilo e zone FC</span><div class="grid2" style="margin-top:6px">
        <label class="f">Età<input type="number" id="sAge" min="15" max="90" value="${s.age ?? ''}"></label>
        <label class="f">Peso (kg)<input type="number" id="sKg" min="40" max="150" step="0.5" value="${s.weightKg ?? ''}"></label>
        <label class="f">FC max (se la conosci)<input type="number" id="sMax" min="140" max="220" value="${s.hrMax ?? ''}"></label>
        <label class="f">FC a riposo (mattina, a letto)<input type="number" id="sRest" min="35" max="90" value="${s.hrRest ?? 60}"></label>
      </div>
      <div class="hr-scale">${hrp.zones.map((z) => `<div style="background:var(--z${z.z})">Z${z.z} ${z.lo}-${z.hi}</div>`).join('')}</div>
      <p class="small muted" style="margin:6px 0 0">FC max ${hrp.max} (${esc(hrp.src)}). Zone col metodo Karvonen sulla riserva cardiaca.</p></div>
      <div><span class="eyebrow">Settimana tipo</span><div class="grid2" style="margin-top:6px">
        <label class="f">Giorno del lungo<select id="sLong"><option value="0" ${s.longRunDay === 0 ? 'selected' : ''}>Domenica</option><option value="6" ${s.longRunDay === 6 ? 'selected' : ''}>Sabato</option></select></label>
        <label class="f">Nome gara<input type="text" id="sRace" maxlength="40" value="${esc(s.raceName)}"></label>
      </div></div>
      <div><span class="eyebrow">Trasferte automatiche</span>
        <label class="f" style="margin-top:6px">URL iCal segreti dei calendari trasferte (uno per riga)<textarea id="sIcal" placeholder="https://calendar.google.com/calendar/ical/…/basic.ics">${esc(s.icalUrls || '')}</textarea></label>
        <p class="small muted" style="margin:4px 0 0">Google Calendar → impostazioni del calendario → "Indirizzo segreto in formato iCal". Ogni evento diventa giorni di trasferta.</p></div>
      <div style="display:flex;justify-content:flex-end"><button class="btn primary" type="submit">Salva impostazioni</button></div>
    </form>
    <div style="display:grid;gap:8px;border-top:1px dashed var(--line);padding-top:14px"><span class="eyebrow">Piano di allenamento</span>
      <p class="small muted" style="margin:0">Attuale: ${d.plan.length} sessioni, ${s.planSource === 'import' ? 'importato da file' : 'generato dal coach'}. Le modifiche giornaliere restano.</p>
      <div class="actions"><button class="btn sm" id="genPlan" type="button">Rigenera piano adattivo</button><label class="btn sm" for="planFile">Importa CSV o .ics</label><input type="file" id="planFile" accept=".csv,.ics,text/csv,text/calendar" hidden></div>
      <div id="genConfirm" hidden class="banner">Il piano attuale viene sostituito. <button class="btn sm primary" id="genYes" type="button">Conferma</button></div>
    </div>
    <div style="display:grid;gap:8px;border-top:1px dashed var(--line);padding-top:14px"><span class="eyebrow">Collegamenti</span>
      ${S.demo ? '<p class="small muted" style="margin:0">Demo: nessun backend collegato.</p>' : `
      <p class="small" style="margin:0">Strava: <b>${d.strava?.connected ? 'collegato' + (d.strava.athlete ? ' (' + esc(d.strava.athlete) + ')' : '') : 'non collegato'}</b> · webhook: <b>${d.strava?.subscription ? 'attivo' : 'non attivo'}</b> · coach AI: <b>${d.ai ? 'attivo' : 'spento'}</b> · Telegram: <b>${d.telegram ? 'attivo' : 'spento'}</b></p>
      <div class="actions"><a class="btn sm" href="/auth/strava?k=${encodeURIComponent(API.token())}">${d.strava?.connected ? 'Ricollega Strava' : 'Collega Strava'}</a><button class="btn sm" data-a="subscribe" type="button">Attiva webhook</button><button class="btn sm" data-a="backfill" type="button">Importa ultimi 120 giorni</button><button class="btn sm ghost" data-a="logout" type="button">Cambia token</button></div>`}
    </div>`, (r) => {
    $('#setForm', r).addEventListener('submit', async (e) => {
      e.preventDefault();
      const num = (id) => { const v = $(id, r).value; return v === '' ? null : +v; };
      $('#dlg').close();
      try { await ACT.settings({ age: num('#sAge'), weightKg: num('#sKg'), hrMax: num('#sMax'), hrRest: num('#sRest') || 60, longRunDay: +$('#sLong', r).value, raceName: $('#sRace', r).value || 'Maratona', icalUrls: $('#sIcal', r).value.trim() }); } catch (err) { toast(err.message); }
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
    bindActions(r);
  });
}

function gate(msg) {
  $('#phasePill').innerHTML = '';
  $('#live').innerHTML = '<i class="dot"></i><span>Non collegato</span>';
  $('#app').innerHTML = `<form class="card gate" id="gateForm"><h2 style="font-size:26px;text-transform:uppercase">Accesso</h2>
    <p class="muted" style="margin:0">Incolla il token della dashboard (il secret DASH_TOKEN del Worker). Resta salvato solo in questo browser.</p>
    ${msg ? `<div class="banner" data-tone="bad">${esc(msg)}</div>` : ''}
    <input type="password" id="gateToken" placeholder="Token" autocomplete="current-password" required>
    <div class="actions"><button class="btn primary" type="submit">Entra</button><button class="btn ghost" type="button" id="gateDemo">Guarda la demo</button></div></form>`;
  $('#gateForm').addEventListener('submit', (e) => { e.preventDefault(); store.set('mc_token', $('#gateToken').value.trim()); boot(); });
  $('#gateDemo').addEventListener('click', () => startDemo());
}

// ---------------------------------------------------------------- Eventi
function bindActions(root) {
  root.querySelectorAll('[data-a]').forEach((b) => b.addEventListener('click', async (e) => {
    const a = b.dataset.a;
    try {
      if (a === 'checkin') checkinDlg();
      if (a === 'settings') settingsDlg();
      if (a === 'weekly') await ACT.weekly();
      if (a === 'subscribe') await ACT.subscribe();
      if (a === 'backfill') await ACT.backfill();
      if (a === 'trips-refresh') await ACT.tripsRefresh();
      if (a === 'gate') { S.demo = false; gate(); }
      if (a === 'logout') { store.del('mc_token'); $('#dlg').close(); gate(); }
      if (a === 'trip-del') await ACT.trips((S.data.trips.manual || []).filter((t) => t.id !== b.dataset.id));
      if (a === 'apply') {
        const f = S.data.feed.find((x) => x.id === b.dataset.f), adj = f?.adjustments?.[+b.dataset.i];
        if (!adj) return;
        const cur = E.effective(adj.date, S.ctx.pIdx, S.data.overrides) || { date: adj.date, kind: 'easy', rpe: '', zone: '', desc: '', hotel: true };
        const kind = adj.action === 'rest' ? 'rest' : adj.action === 'easy' ? 'easy' : cur.kind;
        await ACT.override(adj.date, { ...cur, kind, title: adj.new_title || cur.title, min: adj.action === 'rest' ? 0 : adj.new_min || cur.min, rpe: adj.new_rpe || cur.rpe, desc: adj.reason ? `${cur.desc} — Coach: ${adj.reason}` : cur.desc }, adj.reason);
        b.disabled = true; b.textContent = 'Applicato';
      }
    } catch (err) { toast(err.message); }
    e.stopPropagation();
  }));
}
function bindMain() {
  const app = $('#app');
  bindActions(app);
  app.querySelectorAll('[data-day]').forEach((b) => b.addEventListener('click', () => dayDlg(b.dataset.day)));
  app.querySelectorAll('select[data-rpe]').forEach((s) => {
    s.addEventListener('click', (e) => e.stopPropagation());
    s.addEventListener('change', () => ACT.rpe(s.dataset.rpe, +s.value || null).catch((e) => toast(e.message)));
  });
  app.querySelectorAll('tr[data-act]').forEach((tr) => tr.addEventListener('click', () => { const a = S.ctx.m.acts.find((x) => String(x.id) === tr.dataset.act); if (a) dayDlg(a.date); }));
  $('#tripForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const start = $('#tripFrom').value, end = $('#tripTo').value || start;
    if (end < start) return toast('La data di fine è prima dell\'inizio');
    await ACT.trips([...(S.data.trips.manual || []), { id: 't' + Date.now(), start, end, city: $('#tripCity').value.trim() || 'Trasferta', source: 'manual' }]).catch((err) => toast(err.message));
    toast('Trasferta aggiunta: le sessioni di quei giorni passano in versione hotel');
  });
  $('#askForm')?.addEventListener('submit', async (e) => { e.preventDefault(); const q = $('#askQ').value.trim(); if (!q) return; $('#askQ').value = ''; await ACT.ask(q).catch((err) => toast(err.message)); });
  ['#fcMin', '#fcTemp'].forEach((id) => $(id)?.addEventListener('input', updateFuelCalc));
  updateFuelCalc();
}

// ---------------------------------------------------------------- Live sync
async function refresh(silent = true) {
  if (S.demo) return;
  try {
    const d = await API.get('/api/state');
    const head = d.feed?.[0]?.id;
    if (S.lastFeedId && head && head !== S.lastFeedId) { S.newFeedId = head; if (silent) toast('Nuovo feedback dal coach'); }
    S.lastFeedId = head; S.data = d; S.err = null; S.lastFetch = Date.now();
    const open = $('#dlg').open, y = window.scrollY;
    compute(); if (!open) { render(); window.scrollTo(0, y); } else setLive();
  } catch (e) {
    if (e.code === 401) return gate('Token non valido o scaduto.');
    S.err = 'Offline · riprovo'; setLive();
  }
}
function burst() { S.burstUntil = Date.now() + 45_000; }
function startPolling() {
  clearInterval(S.polling);
  S.polling = setInterval(() => {
    if (document.hidden) return;
    const every = S.burstUntil > Date.now() ? 4000 : 60000;
    if (Date.now() - S.lastFetch >= every) refresh();
  }, 2000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - S.lastFetch > 15000) refresh(); });
}

function startDemo() {
  S.demo = true; S.data = E.demoData(); S.lastFeedId = S.data.feed[0]?.id;
  compute(); render();
}
async function boot() {
  const params = new URLSearchParams(location.search);
  if (params.get('strava')) {
    toast(params.get('strava') === 'ok' ? 'Strava collegato: importo lo storico e attivo il webhook' : params.get('strava') === 'scope' ? 'Manca il permesso sulle attività: ricollega' : 'Autorizzazione Strava annullata');
    history.replaceState(null, '', location.pathname);
    burst();
  }
  if (params.has('demo')) return startDemo();
  if (!API.token()) {
    const probe = await fetch('/api/state').catch(() => null);
    if (!probe || !(probe.headers.get('content-type') || '').includes('json')) return startDemo();
    return gate();
  }
  try {
    S.data = await API.get('/api/state'); S.lastFeedId = S.data.feed?.[0]?.id; S.lastFetch = Date.now();
    compute(); render(); startPolling();
  } catch (e) {
    if (e.code === 401) return gate('Token non valido.');
    startDemo();
  }
}

$('#btnSync').addEventListener('click', () => ACT.sync().catch((e) => toast(e.message)));
$('#btnCheckin').addEventListener('click', () => S.data && checkinDlg());
$('#btnSettings').addEventListener('click', () => S.data && settingsDlg());
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => S.data && drawCharts());
new MutationObserver(() => S.data && drawCharts()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
boot();
