// ============================================================================
// Marathon Coach — dashboard (modulo ES, nessun build). Legge /api/state dal
// Worker, calcola le metriche col motore condiviso e disegna SOLO la sezione
// attiva (#oggi, #settimana, #analisi, #coach). Si aggiorna da sola (polling +
// burst dopo ogni azione). La DEMO parte solo con ?demo o su richiesta.
// ============================================================================
import { E, J, S, ACT, $, esc, store, hash, TABS, ago, markApplied, reducedMotion } from './ui/core.js';
import { toast, checkinDlg, dayDlg, settingsDlg, doneDlg, pauseDlg, manualRunDlg, profileDlg, reviewDlg, skipDlg, testDlg, shoesDlg } from './ui/dialogs.js';
import * as Today from './ui/today.js';
import * as Week from './ui/week.js';
import * as Analysis from './ui/analysis.js';
import * as Coach from './ui/coach.js';
import * as Progress from './ui/progress.js';
import * as Race from './ui/race.js';

const SECTIONS = { oggi: Today, settimana: Week, analisi: { units: () => [...Progress.units(), ...Analysis.units()] }, coach: Coach, gara: Race, libreria: { units: () => Coach.libUnits() } };
const mqWide = matchMedia('(min-width: 1100px)'), mqNarrow = matchMedia('(max-width: 759px)');

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
Object.assign(ACT, {
  async sync() {
    if (S.demo) return toast('Demo: in live scarica le nuove uscite da Intervals.icu e avvia l\'analisi del coach.');
    const r = await API.post('/api/sync');
    toast(r.backfilled ? `Primo collegamento: ${r.backfilled} attività importate da Intervals.icu` : r.added ? `${r.added} nuove uscite: analisi del coach in arrivo` : r.refreshed ? `${r.refreshed} uscite aggiornate` : 'Nessuna nuova uscita');
    await refresh(); burst();
  },
  async checkin(payload) {
    if (S.demo) {
      S.data.checkins[payload.date] = payload; compute();
      const t = S.ctx.today;
      demoFeed({ kind: 'checkin', source: 'rules', headline: t.adapted.changes.length ? `Oggi: ${t.adapted.session?.title || 'riposo'}` : `Readiness ${t.ready.score}: piano confermato`, verdict: t.adapted.level === 'red' ? 'warning' : t.adapted.level === 'amber' ? 'info' : 'on_track', summary: t.adapted.changes.join(' ') || 'Nessun motivo per cambiare la sessione di oggi.', kpis: [{ label: 'Readiness', value: `${t.ready.score}/100`, status: 'ok' }] });
      return toast('Check-in salvato: sessione di oggi ricalcolata');
    }
    await API.post('/api/checkin', payload);
    toast('Check-in salvato: sessione di oggi ricalcolata');
    await refresh(); burst();
  },
  async rpe(id, rpe) {
    const a = S.data.activities.find((x) => String(x.id) === String(id));
    if (a) { a.rpe = rpe || null; a.rpe_src = rpe ? 'manuale' : null; }
    if (!S.demo) await API.post(`/api/activity/${id}/rpe`, { rpe });
    compute(); render(); toast(rpe ? `RPE ${rpe} salvato: carico e ACWR aggiornati` : 'RPE rimosso: torna la stima dalla FC');
  },
  async override(date, session, reason, quiet = false) {
    if (session) S.data.overrides[date] = { ...session, date, override: true, reason };
    else delete S.data.overrides[date];
    if (!S.demo) await API.post('/api/override', { date, session, reason });
    if (quiet) return;
    compute(); render(); toast(session ? 'Sessione aggiornata' : 'Ripristinata la sessione del piano');
  },
  async trips(manual) {
    S.data.trips.manual = manual;
    if (!S.demo) await API.post('/api/trips', { manual });
    compute(); render();
  },
  async settings(patch) {
    if (S.demo) Object.assign(S.data.settings, patch);
    else S.data.settings = await API.post('/api/settings', patch); // il Worker valida: se rifiuta, lo stato locale non cambia
    compute(); render(); toast('Impostazioni salvate');
  },
  async plan(body) {
    if (S.demo) {
      S.data.plan = body.mode === 'generate' ? E.generatePlan(S.data.settings) : body.sessions;
      compute(); render(); return toast(`Piano ${body.mode === 'generate' ? 'rigenerato' : 'importato'}: ${S.data.plan.length} sessioni`);
    }
    const r = await API.post('/api/plan', body); await refresh(); toast(`Piano aggiornato: ${r.count} sessioni`);
  },
  // ---------- José: chat, note vocali, voti, "Non riesco", test, scarpe, gara ----------
  async chat(text) {
    if (S.demo) { S.data.chat.push({ id: 'c' + Date.now(), ts: Date.now(), from: 'luca', text, answered: false }); return render(); }
    await API.post('/api/chat', { text }); await refresh();
  },
  async mic() {
    if (S.rec) return S.rec.stop();
    if (!navigator.mediaDevices?.getUserMedia) return toast('Questo browser non registra audio');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mr = new MediaRecorder(stream), chunks = [];
    mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    mr.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop()); S.rec = null; render();
      const blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' });
      if (S.demo) { S.data.chat.push({ id: 'c' + Date.now(), ts: Date.now(), from: 'luca', text: '(nota vocale: in live qui compare la trascrizione)', voice: true, answered: false }); return render(); }
      try {
        toast('Trascrivo la nota vocale…');
        const r = await fetch('/api/chat/voice', { method: 'POST', headers: { authorization: `Bearer ${API.token()}`, 'content-type': blob.type || 'audio/webm' }, body: blob });
        const j = await r.json(); if (!r.ok) throw new Error(j.error || `Errore ${r.status}`);
        await refresh(); toast('Nota vocale inviata a José');
      } catch (e) { toast(e.message); }
    };
    mr.start(); S.rec = mr; render();
    setTimeout(() => mr.state === 'recording' && mr.stop(), 110_000); // massimo ~2 minuti
  },
  async play(id) {
    const r = await fetch(`/api/chat/audio/${id}`, { headers: { authorization: `Bearer ${API.token()}` } });
    if (!r.ok) return toast('Audio non più disponibile');
    new Audio(URL.createObjectURL(await r.blob())).play();
  },
  async skip(date, choice) {
    const r = J.skipOptions(date, { ...S.ctx.base, settings: S.ctx.settings }), o = r?.options.find((x) => x.k === choice);
    if (!o) return;
    if (S.demo) { Object.entries(o.patch).forEach(([d, x]) => (S.data.overrides[d] = { ...x, override: true, reason: `Non riesco: ${o.label.toLowerCase()}` })); S.data.skips = [...(S.data.skips || []), { date, k: o.k, label: o.label }]; compute(); render(); }
    else { await API.post('/api/skip', { date, choice }); await refresh(); }
    toast(o.k === 'skip' ? 'Segnata come saltata. José ne terrà conto.' : `${o.label}: fatto. José commenta al prossimo giro.`);
  },
  async testSave(t) {
    if (S.demo) S.data.tests = [...S.data.tests.filter((x) => x.date !== t.date), { id: 't' + Date.now(), ...t, passo_s: Math.round(t.time_s / t.dist_km), source: 'manuale', previsione: J.predict(t.dist_km, t.time_s), zone_passo: J.paceZones(t.dist_km, t.time_s) }].sort((a, b) => a.date.localeCompare(b.date));
    else { await API.post('/api/tests', t); await refresh(); }
    compute(); render(); toast('Test salvato: previsione e zone di passo aggiornate');
  },
  async testDel(id) {
    if (!S.demo) await API.post('/api/tests/delete', { id });
    S.data.tests = (S.data.tests || []).filter((x) => x.id !== id); compute(); render(); toast('Test eliminato');
  },
  async shoesSave(list) {
    if (S.demo) S.data.shoes = { ...(S.data.shoes || {}), list };
    else S.data.shoes = await API.post('/api/shoes', { list });
    compute(); render(); toast('Scarpe salvate');
  },
  async shoeAssign(actId, shoe) {
    if (S.demo) S.data.shoes.assign = { ...(S.data.shoes.assign || {}), [actId]: shoe };
    else S.data.shoes = await API.post(`/api/activity/${actId}/shoe`, { shoe });
    compute(); render(); toast('Scarpa associata all\'uscita');
  },
  async raceSave(patch) {
    if (S.demo) S.data.race = { ...(S.data.race || {}), ...patch, notes: { ...(S.data.race?.notes || {}), ...(patch.notes || {}) }, pack: { ...(S.data.race?.pack || {}), ...(patch.pack || {}) } };
    else S.data.race = await API.post('/api/race', patch.notes ? { ...patch, notes: { ...(S.data.race?.notes || {}), ...patch.notes } } : patch);
    render(false);
  },
  async tripsRefresh() {
    if (S.demo) return toast('Demo: in live rilegge i calendari iCal delle trasferte.');
    await API.post('/api/trips/refresh'); await refresh(); toast('Trasferte aggiornate dal calendario');
  },
  // "Fatto" su forza/mobilità (e annulla)
  async log(entry) {
    const logs = (S.data.logs || []).filter((l) => !(l.date === entry.date && l.kind === entry.kind));
    if (!S.demo) await API.post('/api/log', entry);
    S.data.logs = [...logs, { ...entry, ts: Date.now() }];
    compute(); render(); toast(entry.kind === 'mobility' ? 'Mobilità segnata come fatta' : 'Forza segnata come fatta');
  },
  async unlog(date, kind) {
    if (!S.demo) await API.post('/api/log/delete', { date, kind });
    S.data.logs = (S.data.logs || []).filter((l) => !(l.date === date && l.kind === kind));
    compute(); render(); toast('Segno tolto');
  },
  async manualRun(r) {
    if (S.demo) {
      S.data.activities.push({ id: 'm' + Date.now(), src: 'manual', date: r.date, start: r.date + 'T12:00:00', name: 'Corsa (inserita a mano)', type: 'Run', dist_km: r.km || 0, moving_min: r.min, speed: r.km ? (r.km * 1000) / (r.min * 60) : 0, pace_s: r.km ? Math.round((r.min * 60) / r.km) : null, rpe: r.rpe || null, rpe_src: r.rpe ? 'manuale' : null });
      compute(); render(); return toast('Corsa aggiunta (demo)');
    }
    const res = await API.post('/api/activity/manual', r);
    await refresh(); toast(res.warning || 'Corsa aggiunta anche su intervals.icu');
  },
  async pause(p) {
    if (S.demo) S.data.pauses = [...(S.data.pauses || []), { id: 'p' + Date.now(), ...p }];
    else S.data.pauses = (await API.post('/api/pause', p)).pauses;
    compute(); render(); toast('Pausa attivata: i giorni saltati non contano. Riprendi quando vuoi.');
  },
  async resume(id) {
    if (S.demo) { const x = S.data.pauses.find((q) => q.id === id); if (x) x.endedOn = S.ctx.todayDate; }
    else S.data.pauses = (await API.post('/api/pause/end', { id })).pauses;
    compute(); render(); toast('Si riparte dal piano. José farà il punto con te.');
  },
  async facilities(key, list, city) {
    if (S.demo) S.data.trips.facilities = { ...(S.data.trips.facilities || {}), [key]: { f: list, ts: Date.now() } };
    else S.data.trips = await API.post('/api/trips/facilities', { key, facilities: list, city });
    compute(); render(); toast('Grazie: le sessioni di quei giorni si adattano a cosa trovi');
  },
  // ---------- Coach personale ----------
  async profile(p) {
    if (S.demo) S.data.profile = { ...p, updatedAt: Date.now() };
    else { const r = await API.post('/api/profile', p); S.data.profile = { ...r.profile, updatedAt: Date.now() }; }
    store.set('mc_profile_skip', '1'); compute(); render(); toast('Profilo salvato: José lo legge dal prossimo giro');
  },
  async reviewAnswers(answers) {
    if (S.demo) S.data.review = { ...S.data.review, answers, answeredAt: Date.now() };
    else { await API.post('/api/review/answers', { answers }); await refresh(); }
    compute(); render(); toast('Risposte inviate: José ricalibra al prossimo giro');
  },
  async checkupRequest() {
    if (S.demo) S.data.review = { ...S.data.review, requested: true };
    else { await API.post('/api/review/request'); S.data.review = { ...S.data.review, requested: true }; }
    render(); toast('Check-up richiesto: José lo prepara al prossimo giro');
  },
  async undoReview(snapshotId) {
    if (S.demo) { const f = S.data.feed.find((x) => x.snapshotId === snapshotId); if (f) f.undone = true; render(); return toast('Demo: in live il piano torna com\'era prima del check-up'); }
    await API.post('/api/review/undo', { snapshotId }); await refresh(); toast('Ricalibrazione annullata: il piano è tornato com\'era');
  },
  async rate(type, id, rating, note = '') {
    const d = S.data, x = type === 'chat' ? d.chat.find((m) => m.id === id) : type === 'report' ? d.reports?.[id] : d.feed.find((f) => f.id === id);
    if (x) { x.rating = rating; if (note) x.ratingNote = note; }
    if (!S.demo) await API.post('/api/rate', { type, id, rating, note });
    render(); if (note) toast('Nota salvata: José la legge al prossimo giro');
  },
  async memDel(id) {
    if (S.demo) S.data.memory = (S.data.memory || []).filter((f) => f.id !== id);
    else S.data.memory = (await API.post('/api/memory/delete', { id })).facts;
    settingsDlg(); toast('Nota dimenticata');
  },
  async profileExport() {
    const d = await API.get('/api/profile/export');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' })); a.download = 'marathon-coach-profilo.json'; a.click();
  },
  async profileDelete() {
    await API.post('/api/profile/delete'); S.data.profile = null; S.data.memory = [];
    settingsDlg(); toast('Profilo e memoria cancellati');
  },
  async zonesRefresh() {
    if (S.demo) return toast('Demo: in live rilegge le zone FC della corsa da intervals.icu.');
    const r = await API.post('/api/intervals/zones');
    await refresh(); toast(r.ok ? 'Zone FC aggiornate da intervals.icu' : r.error);
  },
  async testLink() { const r = await API.post('/api/intervals/test'); toast(r.ok ? `Intervals.icu risponde${r.athlete ? ': ' + r.athlete : ''}` : `Collegamento non riuscito: ${r.error}`); },
  async backfill() { toast('Importo lo storico…'); const r = await API.post('/api/intervals/backfill'); toast(`${r.imported} attività importate${r.skippedStrava ? ` · ${r.skippedStrava} non leggibili (arrivano da Strava)` : ''}`); await refresh(); },
});
function demoFeed(item, announce = false) {
  const f = { id: 'd' + Date.now(), ts: Date.now(), kpis: [], adjustments: [], tips: [], ...item };
  S.data.feed.unshift(f); S.lastFeedId = f.id;
  if (announce) newFeedback(f.id);
  render();
}

// ---------------------------------------------------------------- Calcolo
function compute() {
  const d = S.data;
  const today = d.demo ? d.serverToday : E.todayISO();
  const settings = { ...E.DEFAULT_SETTINGS, ...d.settings };
  // Forza/mobilità segnate con "Fatto" contano come attività; le pause coprono i giorni del piano
  const acts = [...(d.activities || []), ...E.logActivities(d.logs || [], d.activities || [])];
  const m = E.computeMetrics(acts, settings, today);
  const pIdx = E.planIndex(d.plan);
  const tripSet = E.tripDaySet(d.trips), vacSet = E.vacationDaySet(d.trips);
  const pause = E.activePause(d.pauses || [], today);
  const ovr = E.withPauses(d.overrides || {}, d.pauses || [], today);
  const ci = d.checkins?.[today] || null;
  const ready = E.readiness(ci, m);
  const planned = E.effective(today, pIdx, ovr);
  const tripToday = E.tripOn(d.trips, today);
  const adapted = E.adaptSession(planned, { ci, m, trip: tripSet.has(today), ready, tripSet, date: today, facilities: tripToday?.facilities });
  const ph = E.phaseAt(today, settings);
  const base = { pIdx, overrides: ovr, acts: m.acts, tripSet, vacSet, today };
  const week = E.weekView(E.mondayOf(today), base);
  const plannedKm = (mon) => {
    let min = 0;
    for (let i = 0; i < 7; i++) { const p = E.effective(E.addDays(mon, i), pIdx, ovr); if (p && ['easy', 'quality', 'long', 'runwalk'].includes(p.kind) && !p.optional) min += p.kind === 'runwalk' ? p.min * 0.55 : p.min; }
    return (min * 60) / m.easyPace;
  };
  const badges = J.computeBadges({ acts: m.acts, pIdx, overrides: ovr, tripSet, today, settings, tests: d.tests || [] });
  S.ctx = { badges, todayDate: today, settings, m, pIdx, tripSet, vacSet, pause, ph, week, base, plannedKm, compliance: E.compliance(base, 4), today: { ci, ready, planned, adapted } };
}
// Firma leggera dei dati: se non cambia, il polling non ridisegna nulla
function dataSig(d) {
  const { serverToday, ...rest } = d; // serverToday cambia da solo: conta la data locale
  return `${d.feed?.[0]?.id}|${d.activities?.length}|${d.meta?.lastSync}|${hash(JSON.stringify(rest))}|${E.todayISO()}`;
}

// ---------------------------------------------------------------- Barra in alto e navigazione
function setLive(pulse = false) {
  const el = $('#live');
  if (!S.data) return;
  if (S.demo) el.innerHTML = '<i class="dot demo"></i><span class="l-short">Demo</span><span class="l-long">· dati di esempio</span>';
  else if (S.err) el.innerHTML = `<i class="dot err"></i><span class="l-short">${esc(S.err)}</span>`;
  else {
    const st = J.joseStatus(S.data.jose?.last);
    el.innerHTML = `<i class="dot ${st.ok ? 'on' : 'err'} ${pulse ? 'ping' : ''}"></i><span class="l-short">José</span><span class="l-long">· ${esc(st.ok ? st.testo : st.mai ? 'mai passato' : `fermo da ${st.ore} ore`)}</span>`;
    el.title = `Ultima sincronizzazione delle uscite: ${S.data.meta?.lastSync ? ago(S.data.meta.lastSync) : 'mai'}`;
  }
}
function setNav() {
  document.querySelectorAll('[data-tab]').forEach((a) => {
    if (a.dataset.tab === S.tab) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    const revOpen = S.data?.review?.status === 'questions' && !S.data.review.answeredAt;
    if (a.dataset.tab === 'oggi') { if (revOpen) a.setAttribute('data-unread', ''); else a.removeAttribute('data-unread'); }
    if (a.dataset.tab === 'coach') { if (S.unread) a.setAttribute('data-unread', ''); else a.removeAttribute('data-unread'); a.setAttribute('aria-label', S.unread ? 'José, c\'è un messaggio nuovo' : 'José'); }
  });
}
function newFeedback(id) {
  S.newFeedId = id;
  S.unread = !(S.tab === 'coach' || S.wide); // su desktop il feed è sempre visibile a destra
  toast('José ha scritto');
}
const readHash = () => { const h = location.hash.slice(1); return TABS.includes(h) ? h : 'oggi'; };
// Tema: 'auto' segue il sistema, 'light'/'dark' lo forzano (scelta nelle Impostazioni)
export function applyTheme(t, save = true) {
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  if (save) { if (t === 'light' || t === 'dark') store.set('mc_theme', t); else store.del('mc_theme'); }
  if (S.data) render();
}
ACT.theme = (t) => applyTheme(t);

// ---------------------------------------------------------------- Render
function banners() {
  const d = S.data, out = [];
  const hosted = location.protocol.startsWith('http') && !location.hostname.endsWith('claude.ai') && !location.hostname.endsWith('claudeusercontent.com');
  if (S.demo) out.push(`<div class="banner"><span><b>Modalità demo.</b> Dati di esempio a marzo 2027: in produzione si collega al tuo Worker e a Intervals.icu.</span>${hosted ? '<button class="btn sm" data-a="gate" type="button">Collega il backend</button>' : ''}</div>`);
  else {
    const iv = d.intervals || {};
    if (!iv.connected) out.push('<div class="banner" data-tone="info"><span><b>Intervals.icu non collegato.</b> Aggiungi al Worker il secret INTERVALS_API_KEY (Intervals.icu → Settings → Developer Settings) e rifai il deploy: da lì in poi le uscite arrivano da sole.</span></div>');
    else if (iv.error) out.push(`<div class="banner" data-tone="bad"><span><b>Sincronizzazione con Intervals.icu non riuscita.</b> ${esc(iv.error)}</span><button class="btn sm" data-a="test-link" type="button">Verifica collegamento</button></div>`);
    else if (!iv.imported) out.push('<div class="banner" data-tone="info"><span><b>Intervals.icu collegato.</b> Lo storico degli ultimi 120 giorni arriva al primo controllo, entro 10 minuti.</span><button class="btn sm primary" data-a="sync" type="button">Importa adesso</button></div>');
    if (iv.connected && iv.stravaStubs) out.push(`<div class="banner" data-tone="info"><span>${iv.stravaStubs} uscite recenti arrivano a Intervals.icu passando da Strava e non sono leggibili: collega Garmin Connect direttamente a Intervals.icu (Settings → Garmin).</span></div>`);
    // Stato di José: avviso solo se il connettore c'è ma non si fa vivo da più di 36 ore
    const st = J.joseStatus(d.jose?.last);
    if (!d.connector) out.push('<div class="banner" data-tone="info"><span><b>José non è collegato.</b> Imposta il secret MCP_SECRET sul Worker e aggiungi il connettore in Claude (vedi README).</span></div>');
    else if (!st.ok) out.push(`<div class="banner" data-tone="${st.mai ? 'info' : 'bad'}"><span><b>${esc(st.testo)}.</b>${st.mai ? '' : ' In Claude devono essere attive le due attività programmate (mattina e sera).'}</span></div>`);
  }
  if (!d.profile && store.get('mc_profile_skip') !== '1') out.push('<div class="banner" data-tone="info"><span><b>José non ti conosce ancora.</b> 4 schermate: storia sportiva, infortuni, cosa ti motiva e cosa ti fa mollare, giorni e orari. Il resto te lo chiede in chat.</span><button class="btn sm primary" data-a="profile" type="button">Compila il profilo</button><button class="btn sm ghost" data-a="profile-skip" type="button">Più tardi</button></div>');
  if (!S.demo && d.garmin?.error) out.push(`<div class="banner" data-tone="bad"><span><b>Invio al Garmin non riuscito.</b> ${esc(d.garmin.error)}. Controlla su intervals.icu → Settings → Garmin che "Upload planned workouts" sia attivo.</span></div>`);
  const src = S.ctx.m.hrp.src;
  if (!S.demo && d.intervals?.connected && src !== 'intervals.icu') out.push(`<div class="banner" data-tone="info"><span>Zone FC ${src === 'provvisoria' ? 'provvisorie' : 'calcolate dalla dashboard'}: imposta le zone FC della corsa su intervals.icu (Settings → Run), così coincidono con quelle dell'orologio.</span><button class="btn sm" data-a="zones-refresh" type="button">Rileggi zone</button></div>`);
  else if (src === 'provvisoria') out.push('<div class="banner" data-tone="info"><span>Zone FC provvisorie (FC max 185). Inserisci età o FC max per tararle.</span><button class="btn sm" data-a="settings" type="button">Imposta</button></div>');
  // Promemoria (una volta sola): la fatica va inserita sull'orologio a fine corsa
  const recent = (S.ctx.m.acts || []).filter((a) => E.isRun(a) && a.date >= E.addDays(S.ctx.todayDate, -3));
  if (!S.demo && store.get('mc_rpe_tip') !== '1' && recent.some((a) => !a.rpe)) out.push('<div class="banner" data-tone="info"><span><b>Fatica percepita mancante.</b> Inseriscila sul Garmin quando chiudi la corsa: se la metti dopo in Garmin Connect non arriva a intervals.icu. Intanto la stimo dalla frequenza cardiaca.</span><button class="btn sm" data-a="rpe-tip-ok" type="button">Ok</button></div>');
  return out.join('');
}
const isField = (el) => !!el && /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName);

// Ogni sezione è una lista di unità: un'unità viene riscritta solo se il suo HTML è cambiato.
// Un'unità con un campo attivo o con testo non ancora inviato aspetta (force = false dal polling).
function patch(list, force) {
  const ae = isField(document.activeElement) ? document.activeElement : null;
  for (const u of list) {
    const el = S.units[u.id];
    if (!el || el._html === u.html) continue;
    // si rimanda solo se c'è del testo non ancora inviato (un campo vuoto col cursore dentro non blocca l'aggiornamento)
    if (!force && ((ae && el.contains(ae) && (ae.value || ae.tagName === 'SELECT')) || el._dirty)) { S.pending = true; continue; }
    const keep = ae && el.contains(ae) && ae.id ? { id: ae.id, value: ae.value } : null;
    el.innerHTML = u.html; el._html = u.html; el._dirty = false;
    el.querySelectorAll('details[data-fold]').forEach((dt) => { dt.open = S.open[dt.dataset.fold] ?? dt.hasAttribute('data-default-open'); });
    if (u.id === 'nutri') updateFuelCalc();
    if (keep && isField($('#' + keep.id))) { $('#' + keep.id).value = keep.value; $('#' + keep.id).focus(); }
  }
}
function render(force = true) {
  if (!S.data) return;
  setNav();
  const main = [{ id: 'banners', html: banners(), cls: 'u-banners' }, ...SECTIONS[S.tab].units()];
  const rail = S.wide ? Coach.railUnits() : [];
  const key = `${S.tab}|${S.wide}|${main.map((u) => u.id)}|${rail.map((u) => u.id)}`;
  const fresh = key !== S.layoutKey, tabChanged = fresh && S.layoutKey?.split('|')[0] !== S.tab;
  if (fresh) {
    Analysis.destroyCharts();
    const box = (u) => `<div data-u="${u.id}" class="${u.cls || ''}"></div>`;
    const app = $('#app'), railEl = $('#rail');
    app.innerHTML = main.map(box).join('');
    railEl.hidden = !rail.length; railEl.innerHTML = rail.map(box).join('');
    S.units = {};
    document.querySelectorAll('#app > [data-u], #rail > [data-u]').forEach((el) => (S.units[el.dataset.u] = el));
    S.layoutKey = key;
    if (tabChanged || !app.dataset.ready) { app.classList.remove('enter'); void app.offsetWidth; app.classList.add('enter'); app.dataset.ready = '1'; }
  }
  S.pending = false;
  patch(main, force || fresh); patch(rail, force || fresh);
  if (S.tab === 'analisi') Analysis.syncCharts(fresh);
  if (fresh) { const rc = $('#rail .u-feed'); if (rc) rc.scrollTop = rc.scrollHeight; } // la chat parte dall'ultimo messaggio
}
const flushPending = () => { if (S.pending && S.data) render(false); };

// Anello Readiness: da 0 al valore in 600 ms quando si apre la sezione Oggi
function playRing() {
  const c = $('#app .ring .val'), n = $('#app .ring [data-count]');
  if (!c || !n || reducedMotion()) return;
  const target = +n.dataset.count, off = c.dataset.off, t0 = performance.now();
  c.style.transition = 'none'; c.setAttribute('stroke-dashoffset', c.dataset.c); void c.getBoundingClientRect();
  c.style.transition = ''; c.setAttribute('stroke-dashoffset', off);
  n.textContent = '0';
  const tick = (t) => { if (!n.isConnected) return; const k = Math.min(1, (t - t0) / 600); n.textContent = Math.round(target * (1 - (1 - k) ** 3)); if (k < 1) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
}
function updateFuelCalc() {
  const o = $('#fcOut'); if (!o) return;
  const r = E.fuelCalc(+$('#fcMin').value || 0, +$('#fcTemp').value || 16);
  o.innerHTML = `<div><b>${r.carbs} g</b><span>Carboidrati</span></div><div><b>${r.gels}</b><span>Gel</span></div><div><b>${(r.water / 1000).toFixed(1).replace('.', ',')} L</b><span>Acqua</span></div><div><b>${r.sodium} mg</b><span>Sodio</span></div>`;
}

// ---------------------------------------------------------------- Schermate senza dati
function blank(html) {
  clearInterval(S.polling); S.polling = null;
  S.layoutKey = null; S.units = {}; Analysis.destroyCharts();
  $('#rail').hidden = true; $('#rail').innerHTML = '';
  $('#app').innerHTML = html;
}
function gate(msg) {
  S.data = null; S.demo = false;
  $('#live').innerHTML = '<i class="dot"></i><span class="l-short">Non collegato</span>';
  blank(`<form class="card gate" id="gateForm"><h2>Accesso</h2>
    <p class="muted">Incolla il token della dashboard (il secret DASH_TOKEN del Worker). Resta salvato solo in questo browser.</p>
    ${msg ? `<div class="banner" data-tone="bad">${esc(msg)}</div>` : ''}
    <label class="f">Token<input type="password" id="gateToken" autocomplete="current-password" required></label>
    <div class="actions"><button class="btn primary" type="submit">Entra</button><button class="btn ghost" type="button" data-a="demo">Guarda la demo</button></div></form>`);
}
function bootError(e) {
  S.data = null;
  $('#live').innerHTML = '<i class="dot err"></i><span class="l-short">Non collegato</span>';
  const noBackend = e.code === 'nobackend' || e instanceof TypeError;
  blank(`<div class="card gate" role="alert"><h2>${noBackend ? 'Backend non raggiungibile' : 'Errore del backend'}</h2>
    <p class="muted">${noBackend ? 'Il Worker non risponde: controlla la connessione o lo stato del deploy.' : 'Il Worker ha risposto con un errore.'} I tuoi dati non sono stati toccati.</p>
    <div class="banner" data-tone="bad">${esc(e.message || 'Errore sconosciuto')}</div>
    <div class="actions"><button class="btn primary" type="button" data-a="retry">Riprova</button><button class="btn ghost" type="button" data-a="demo">Guarda la demo</button><button class="btn ghost" type="button" data-a="logout">Cambia token</button></div></div>`);
}

// ---------------------------------------------------------------- Eventi (delegati: sopravvivono ai render)
async function doAction(b) {
  const a = b.dataset.a;
  try {
    if (a === 'checkin') checkinDlg();
    if (a === 'settings') settingsDlg();
    if (a === 'sync') await ACT.sync();
    if (a === 'backfill') await ACT.backfill();
    if (a === 'test-link') await ACT.testLink();
    if (a === 'zones-refresh') await ACT.zonesRefresh();
    if (a === 'profile') profileDlg();
    if (a === 'profile-skip') { store.set('mc_profile_skip', '1'); render(); }
    if (a === 'review-open') reviewDlg();
    if (a === 'checkup-request') await ACT.checkupRequest();
    if (a === 'undo-review') { if (b.dataset.confirm) await ACT.undoReview(b.dataset.s); else { b.dataset.confirm = '1'; b.textContent = 'Sicuro? Tocca di nuovo per annullare'; } }
    if (a === 'rate') await ACT.rate(b.dataset.t || 'feed', b.dataset.f, b.dataset.r);
    if (a === 'skip') skipDlg(b.dataset.date);
    if (a === 'test-add') testDlg();
    if (a === 'test-del') { if (b.dataset.confirm) await ACT.testDel(b.dataset.id); else { b.dataset.confirm = '1'; b.title = 'Tocca di nuovo per eliminare'; toast('Tocca di nuovo per eliminare il test'); } }
    if (a === 'shoes') shoesDlg();
    if (a === 'mic') await ACT.mic();
    if (a === 'play') await ACT.play(b.dataset.id);
    if (a === 'race-hotel') await ACT.raceSave({ hotel: b.dataset.k });
    if (a === 'mem-del') await ACT.memDel(b.dataset.id);
    if (a === 'profile-export') await ACT.profileExport();
    if (a === 'profile-delete') { if (b.dataset.confirm) await ACT.profileDelete(); else { b.dataset.confirm = '1'; b.textContent = 'Sicuro? Tocca di nuovo'; } }
    if (a === 'done') doneDlg(b.dataset.date, b.dataset.kind, b.dataset.routine);
    if (a === 'undone') await ACT.unlog(b.dataset.date, b.dataset.kind);
    if (a === 'pause') pauseDlg();
    if (a === 'resume') await ACT.resume(b.dataset.id);
    if (a === 'manual-run') manualRunDlg(b.dataset.date);
    if (a === 'fac') { b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true')); if (b.dataset.k === 'unknown') b.parentElement.querySelectorAll('[data-k]:not([data-k="unknown"])').forEach((x) => x.setAttribute('aria-pressed', 'false')); else b.parentElement.querySelector('[data-k="unknown"]')?.setAttribute('aria-pressed', 'false'); }
    if (a === 'fac-save') { const box = b.closest('[data-trip]'); const list = [...box.querySelectorAll('[data-a="fac"][aria-pressed="true"]')].map((x) => x.dataset.k).filter((k) => k !== 'unknown'); await ACT.facilities(box.dataset.trip, list, box.dataset.city); }
    if (a === 'theme') { ACT.theme(b.dataset.k); b.parentElement.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); }
    if (a === 'rpe-tip-ok') { store.set('mc_rpe_tip', '1'); render(); }
    if (a === 'trips-refresh') await ACT.tripsRefresh();
    if (a === 'gate') gate();
    if (a === 'retry') { blank('<div class="sk" style="height:150px"></div><div class="sk" style="height:300px"></div>'); return boot(); }
    if (a === 'demo') return startDemo();
    if (a === 'logout') { store.del('mc_token'); if ($('#dlg').open) $('#dlg').close(); gate(); }
    if (a === 'trip-del') await ACT.trips((S.data.trips.manual || []).filter((t) => t.id !== b.dataset.id));
    if (a === 'fuel') { S.fuelOpen = S.fuelOpen === b.dataset.k ? null : b.dataset.k; render(); $(`[data-a="fuel"][data-k="${b.dataset.k}"]`)?.focus(); }
    if (a === 'week') { S.weekOff = b.dataset.d === '0' ? 0 : S.weekOff + +b.dataset.d; render(); $(`[data-a="week"][data-d="${b.dataset.d}"]`)?.focus(); }
    if (a === 'period') { S.period = b.dataset.k; store.set('mc_period', S.period); render(); $(`[data-a="period"][data-k="${S.period}"]`)?.focus(); }
    if (a === 'coach-view') { S.coachView = b.dataset.k; render(); $(`[data-a="coach-view"][data-k="${S.coachView}"]`)?.focus(); }
    if (a === 'sugg') { const q = b.closest('form')?.querySelector('#chatQ') || $('#chatQ'); if (q) { q.value = b.dataset.q; q.focus(); q.closest('[data-u]')._dirty = true; } }
    if (a === 'apply') await applyAdjustment(b);
  } catch (err) { toast(err.message); }
}
async function applyAdjustment(b) {
  const f = S.data.feed.find((x) => x.id === b.dataset.f), adj = f?.adjustments?.[+b.dataset.i];
  if (!adj) return;
  const planned = E.effective(adj.date, S.ctx.pIdx, S.data.overrides);
  const cur = planned || { date: adj.date, kind: 'easy', rpe: '', zone: '', desc: '', hotel: true };
  const note = adj.reason ? `${cur.desc} — Coach: ${adj.reason}` : cur.desc;
  if (adj.action === 'move') {
    // Senza destinazione (o senza sessione da spostare) si decide a mano nel dettaglio del giorno
    if (!adj.to_date || !planned) return dayDlg(adj.date);
    const to = `${E.DOW_IT_LONG[E.dow(adj.to_date)].toLowerCase()} ${E.fmtDate(adj.to_date)}`;
    await ACT.override(adj.to_date, { ...cur, dow: E.dow(adj.to_date), title: adj.new_title || cur.title, min: adj.new_min || cur.min, rpe: adj.new_rpe || cur.rpe, desc: note }, `Spostata da ${E.fmtDate(adj.date)}${adj.reason ? ': ' + adj.reason : ''}`, true);
    await ACT.override(adj.date, { ...cur, kind: 'rest', title: 'Riposo', min: 0, rpe: '-', zone: '-', desc: `Sessione spostata a ${to}.`, strength: null, optional: false, strides: false }, `Spostata a ${to}${adj.reason ? ': ' + adj.reason : ''}`, true);
    markApplied(`${f.id}:${b.dataset.i}`); if (!S.demo) API.post(`/api/feed/${f.id}/applied`).catch(() => {}); compute(); render(); toast(`Sessione spostata a ${to}`);
  } else {
    const kind = adj.action === 'rest' ? 'rest' : adj.action === 'easy' ? 'easy' : cur.kind;
    markApplied(`${f.id}:${b.dataset.i}`);
    if (!S.demo) API.post(`/api/feed/${f.id}/applied`).catch(() => {});
    await ACT.override(adj.date, { ...cur, kind, title: adj.new_title || cur.title, min: adj.action === 'rest' ? 0 : adj.new_min || cur.min, rpe: adj.new_rpe || cur.rpe, desc: note }, adj.reason);
  }
}
function onClick(e) {
  const b = e.target.closest('[data-a]');
  if (b) return doAction(b);
  if (e.target.closest('select, input, textarea, label, a')) return;
  const day = e.target.closest('[data-day]');
  if (day) return dayDlg(day.dataset.day);
  const act = e.target.closest('[data-act]');
  if (act) { const a = S.ctx.m.acts.find((x) => String(x.id) === act.dataset.act); if (a) dayDlg(a.date); }
}
function bindOnce() {
  const root = $('.layout');
  root.addEventListener('click', onClick);
  $('#dlgBody').addEventListener('click', (e) => { const b = e.target.closest('[data-a]'); if (b) doAction(b); });
  root.addEventListener('change', (e) => {
    const s = e.target.closest('select[data-rpe]');
    if (s) ACT.rpe(s.dataset.rpe, +s.value || null).catch((err) => toast(err.message));
    // Area gara: checklist e note si salvano da sole
    const u = e.target.closest('[data-u]');
    if (e.target.dataset.pack) { if (u) u._dirty = false; ACT.raceSave({ pack: { [e.target.dataset.pack]: e.target.checked } }).catch((err) => toast(err.message)); }
    if (e.target.dataset.race) { if (u) u._dirty = false; ACT.raceSave({ notes: { [e.target.dataset.race]: e.target.value } }).then(() => toast('Salvato')).catch((err) => toast(err.message)); }
  });
  root.addEventListener('input', (e) => {
    if (e.target.id === 'fcMin' || e.target.id === 'fcTemp') return updateFuelCalc();
    const u = e.target.closest('[data-u]'); if (u && e.target.type !== 'checkbox') u._dirty = !!e.target.value; // testo non ancora inviato: l'unità non va riscritta
  });
  root.addEventListener('submit', async (e) => {
    e.preventDefault();
    const u = e.target.closest('[data-u]'); if (u) u._dirty = false;
    if (e.target.id === 'gateForm') { store.set('mc_token', $('#gateToken').value.trim()); return boot(); }
    if (e.target.id === 'tripForm') {
      const start = $('#tripFrom').value, end = $('#tripTo').value || start;
      if (end < start) return toast('La data di fine è prima dell\'inizio');
      const type = $('#tripType')?.value === 'vacation' ? 'vacation' : 'work';
      await ACT.trips([...(S.data.trips.manual || []), { id: 't' + Date.now(), start, end, city: $('#tripCity').value.trim() || (type === 'vacation' ? 'Vacanza' : 'Trasferta'), type, source: 'manual' }]).catch((err) => toast(err.message));
      toast(type === 'vacation' ? 'Vacanza aggiunta: niente versione hotel, ti chiederò cosa trovi in zona' : 'Trasferta aggiunta: le sessioni di quei giorni passano in versione hotel');
    }
    if (e.target.id === 'chatForm') { const f = e.target.querySelector('#chatQ'), q = f.value.trim(); if (!q) return; f.value = ''; await ACT.chat(q).catch((err) => toast(err.message)); }
    if (e.target.classList.contains('rate-note')) { const d = e.target.dataset, n = e.target.querySelector('input').value.trim(); if (n) await ACT.rate(d.t, d.f, d.r, n).catch((err) => toast(err.message)); }
    if (e.target.id === 'packForm') { const v = $('#packNew').value.trim(); if (v) await ACT.raceSave({ extra: [...(S.data.race?.extra || []), v] }).catch((err) => toast(err.message)); }
  });
  // "toggle" non risale il DOM: lo si ascolta in cattura per ricordare i blocchi aperti/chiusi
  root.addEventListener('toggle', (e) => { const k = e.target.dataset?.fold; if (k) S.open[k] = e.target.open; }, true);
  // Un render rimandato per non disturbare chi scrive riparte quando il campo perde il focus
  root.addEventListener('focusout', () => setTimeout(flushPending, 50));

  $('#btnSync').addEventListener('click', () => S.data && ACT.sync().catch((e) => toast(e.message)));
  $('#btnSettings').addEventListener('click', () => S.data && settingsDlg());
  // Cambio di modalità chiaro/scuro del sistema: i grafici rileggono i colori
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { S.chartSig = null; if (S.data) render(); });
  // Tab da tastiera: frecce sinistra/destra, Home, Fine
  $('#tabs').addEventListener('keydown', (e) => {
    const tabs = [...$('#tabs').querySelectorAll('a')], i = tabs.indexOf(document.activeElement);
    const to = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : null;
    if (i < 0 || to == null) return;
    e.preventDefault(); const t = tabs[(to + tabs.length) % tabs.length]; t.focus(); t.click();
  });
  window.addEventListener('hashchange', () => {
    const t = readHash(); if (t === S.tab) return;
    S.tab = t; if (t === 'coach') S.unread = false;
    if (S.data) { render(); window.scrollTo(0, 0); } else setNav();
  });
  const onMq = () => { S.wide = mqWide.matches; S.narrow = mqNarrow.matches; if (S.wide) S.unread = false; if (S.data) render(); };
  mqWide.addEventListener('change', onMq); mqNarrow.addEventListener('change', onMq);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.polling && S.data && Date.now() - S.lastFetch > 15000) refresh(); });
}

// ---------------------------------------------------------------- Live sync
async function refresh() {
  if (S.demo) return;
  try {
    const d = await API.get('/api/state');
    const lastJ = [...(d.chat || [])].reverse().find((m) => m.from === 'jose')?.id || null;
    const head = `${d.feed?.[0]?.id}|${lastJ}`;
    const isNew = S.lastFeedId && head !== S.lastFeedId;
    S.lastFeedId = head; S.err = null; S.lastFetch = Date.now();
    const sig = dataSig(d);
    if (sig === S.sig) return setLive(); // niente di nuovo: aggiorno solo l'indicatore live
    S.sig = sig; S.data = d;
    if (isNew) newFeedback(d.feed?.[0]?.id);
    compute(); render(false); setLive(true);
  } catch (e) {
    if (e.code === 401) return gate('Token non valido o scaduto.');
    S.err = 'Offline'; setLive();
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
}

function startDemo() {
  clearInterval(S.polling); S.polling = null;
  S.demo = true; S.err = null; S.data = J.demoExtras(E.demoData()); S.lastFeedId = S.data.feed[0]?.id; S.layoutKey = null;
  compute(); setLive(); render();
}
async function boot() {
  if (new URLSearchParams(location.search).has('demo')) return startDemo();
  if (!API.token()) {
    const probe = await fetch('/api/state').catch(() => null);
    if (!probe || !(probe.headers.get('content-type') || '').includes('json')) return startDemo();
    return gate();
  }
  try {
    S.data = await API.get('/api/state'); S.sig = dataSig(S.data); S.lastFeedId = `${S.data.feed?.[0]?.id}|${[...(S.data.chat || [])].reverse().find((m) => m.from === 'jose')?.id || null}`; S.lastFetch = Date.now();
    S.demo = false; S.err = null; S.layoutKey = null;
    compute(); setLive(); render(); startPolling();
  } catch (e) {
    if (e.code === 401) return gate('Token non valido.');
    bootError(e); // mai la demo al posto dei dati veri: si vede l'errore e si sceglie cosa fare
  }
}

S.tab = readHash(); S.wide = mqWide.matches; S.narrow = mqNarrow.matches;
bindOnce(); setNav();
window.mc = { burst, refresh, render, state: S }; // per le verifiche da console: mc.burst(), mc.refresh()
boot();
