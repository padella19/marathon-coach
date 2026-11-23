// Sezione "José": chat (Luca scrive quando vuole, José risponde al giro successivo), commenti a uscite e
// check-in, report del lunedì, focus della settimana e libreria (forza da camera, integrazione, scarico)
import { E, J, S, esc, ico, chip, ago, feedItem, rateBox, romeHM, JM } from './core.js';

const SUGGEST = ['Domani sono in trasferta, cosa faccio?', 'Come sto andando questo mese?', 'Ho un fastidio al polpaccio'];
const VIEWS = [['chat', 'Chat'], ['feed', 'Commenti'], ['report', 'Report']];

// Stato di José: ultima visita del connettore (il vecchio banner "Coach AI spento" non c'è più)
export function statusLine() {
  if (S.demo) return '<i class="dot on"></i> José attivo · ultima visita stamattina 07:02';
  if (!S.data.connector) return '<i class="dot err"></i> José non è collegato: manca il secret MCP_SECRET sul Worker';
  const st = J.joseStatus(S.data.jose?.last);
  return `<i class="dot ${st.ok ? 'on' : 'err'}"></i> ${st.ok ? 'José ' : ''}${esc(st.testo)}`;
}
const waitLine = () => { const n = J.nextRun(romeHM(), S.ctx.settings); return `José risponde entro ${n.quando} (giro delle ${n.ora})`; };

const CHAT_KIND = { scolding: ['Richiamo', 'bad'], praise: ['Merito', 'good'], spontaneous: ['Da José', 'info'] };
function msg(m) {
  const me = m.from === 'luca', k = CHAT_KIND[m.kind];
  return `<div class="msg ${me ? 'me' : 'jose'}" data-k="${esc(m.kind || '')}">${me ? '' : JM}<div class="bub">
    ${k ? chip(k[1], k[0]) : ''}<p>${esc(m.text)}</p>
    ${m.audio ? `<button class="btn sm ghost" data-a="play" data-id="${esc(m.audio)}" type="button">▶ Ascolta la nota vocale</button>` : ''}
    <span class="mt">${m.voice ? 'vocale · ' : ''}${ago(m.ts)}${me && !m.answered ? ' · in attesa di José' : ''}</span>
    ${me ? '' : rateBox('chat', m.id, m.rating, m.ratingNote)}</div></div>`;
}
const chatList = (n = 60) => {
  const chat = (S.data.chat || []).slice(-n);
  return chat.length ? `<div class="chat">${chat.map(msg).join('')}</div>` : '<div class="empty">Scrivi a José quando vuoi. Non è in linea: legge e risponde al giro successivo, mattina o sera.</div>';
};
const composer = (sugg = true) => {
  const rec = S.rec, canVoice = (S.data.voice || S.demo) && typeof MediaRecorder !== 'undefined';
  return `<form class="composer" id="chatForm">
    ${sugg && !(S.data.chat || []).length ? `<div class="sugg" aria-label="Messaggi rapidi">${SUGGEST.map((q) => `<button type="button" data-a="sugg" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div>` : ''}
    <div class="ask-row">${canVoice ? `<button class="btn ${rec ? 'primary rec' : ''}" type="button" data-a="mic" aria-label="${rec ? 'Ferma e invia la nota vocale' : 'Registra una nota vocale'}" aria-pressed="${!!rec}">${ico(rec ? 'stop' : 'mic')}</button>` : ''}<input type="text" id="chatQ" placeholder="${rec ? 'Sto registrando… tocca il quadrato per inviare' : 'Scrivi a José…'}" aria-label="Messaggio per José" maxlength="1500" autocomplete="off" enterkeyhint="send" ${rec ? 'disabled' : ''}><button class="btn primary" type="submit" aria-label="Invia">${ico('send')}</button></div>
    <p class="small muted wait">${waitLine()}</p>
  </form>`;
};
// In Oggi (telefono): gli ultimi scambi e il campo per scrivere
export const chatMini = () => `<div class="chat-mini">${(S.data.chat || []).length ? chatList(3) : ''}${composer(true)}</div>`;

// Report settimanale del lunedì
export function reportCard(r, compact = false) {
  const n = r.numeri || {};
  return `<article class="card report"><div class="rep-h"><div><span class="eyebrow">Report · settimana del ${E.fmtDate(r.week)}</span><h3>${esc(r.titolo)}</h3></div><div class="vote" aria-label="Voto di José ${r.voto} su 10"><b>${r.voto}</b><span>/10</span></div></div>
    <div class="targets"><div class="target"><span>Corse</span><b>${n.corse_fatte ?? '—'} / ${n.corse_pianificate ?? '—'}</b></div><div class="target"><span>Km</span><b>${n.km != null ? String(n.km).replace('.', ',') : '—'}</b></div><div class="target"><span>Minuti</span><b>${n.minuti_corsa ?? '—'} / ${n.minuti_pianificati ?? '—'}</b></div><div class="target"><span>Costanza</span><b>${n.costanza_pct != null ? n.costanza_pct + '%' : '—'}</b></div><div class="target"><span>Forza</span><b>${n.forza_fatta ?? 0} / ${n.forza_prevista ?? 0}</b></div></div>
    <p>${esc(r.commento)}</p>
    ${compact ? '' : `${r.bene?.length ? `<div class="rep-l" data-t="good"><b>Bene</b><ul>${r.bene.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}${r.male?.length ? `<div class="rep-l" data-t="bad"><b>Male</b><ul>${r.male.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}`}
    ${r.focus ? `<p class="rep-focus"><b>Focus della settimana nuova:</b> ${esc(r.focus)}${r.focus_perche && !compact ? ' — ' + esc(r.focus_perche) : ''}</p>` : ''}
    ${rateBox('report', r.week, r.rating, r.ratingNote)}</article>`;
}
const reports = () => {
  const list = Object.values(S.data.reports || {}).sort((a, b) => b.week.localeCompare(a.week));
  return list.length ? list.map((r) => reportCard(r)).join('') : '<div class="empty">Il report arriva il lunedì mattina: settimana fatta contro pianificata, km, costanza, cosa è andato bene e male, il voto di José e il focus della settimana nuova.</div>';
};

function viewSwitch(views) {
  return `<div class="an-head"><h2>José</h2><div class="seg" role="group" aria-label="Vista">${views.map(([k, l]) => `<button type="button" data-a="coach-view" data-k="${k}" aria-pressed="${S.coachView === k}">${l}</button>`).join('')}</div></div><p class="jose-st small">${statusLine()}</p>`;
}
function checkupBtn() {
  const r = S.data.review || {};
  if (r.status === 'questions') return '<span class="small muted">Check-up aperto: rispondi alle domande in Oggi</span>';
  if (r.requested) return '<span class="small muted">Check-up richiesto: José lo prepara al prossimo giro</span>';
  return '<button class="btn sm" data-a="checkup-request" type="button">Chiedi un check-up</button>';
}
function focus() {
  const { todayDate, ph, plannedKm, week } = S.ctx, mon = E.mondayOf(todayDate);
  const w = S.data.weekly?.[mon];
  const title = w ? w.title : `${ph.name}${ph.rec ? ' · settimana di scarico' : ''}`;
  const keys = w?.keys?.length ? w.keys : week.filter((d) => d.plan && d.plan.kind !== 'rest' && !d.plan.optional).slice(0, 4).map((d) => `${E.DOW_IT[E.dow(d.date)]}: ${d.plan.title} (${E.fmtMin(d.plan.min)})`);
  const targets = w?.targets?.length ? w.targets : [{ label: 'Volume', value: `~${plannedKm(mon).toFixed(0)} km` }, { label: 'Z1-Z2', value: '≥ 80%' }];
  const byJose = w?.source === 'claude' || w?.source === 'ai';
  return `<details class="card fold" data-fold="focus" ${S.narrow ? '' : 'data-default-open'}>
    <summary><h3>Focus della settimana</h3><span class="sum-sub">${esc(title)}</span>${ico('down', 'chev')}</summary>
    <div class="fold-b">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px">${chip(byJose ? 'accent' : 'muted', byJose ? 'José' : 'dal piano')}</div>
      <h4 class="focus-title">${esc(title)}</h4><p class="muted">${esc(w ? w.why : ph.focus)}</p>
      ${keys.length ? `<ul class="keys">${keys.map((k) => `<li>${esc(k)}</li>`).join('')}</ul>` : ''}
      ${targets.length ? `<div class="targets">${targets.map((t) => `<div class="target"><span>${esc(t.label)}</span><b>${esc(t.value)}</b></div>`).join('')}</div>` : ''}
      <div class="actions" style="margin-top:12px">${checkupBtn()}</div>
    </div></details>`;
}
const feedList = () => {
  const feed = (S.data.feed || []).filter((f) => !f.superseded);
  return `<div class="feed">${feed.length ? feed.slice(0, 30).map(feedItem).join('') : '<div class="empty">Qui arrivano i commenti di José a uscite e check-in: 2-3 righe, con "Approfondisci" per l\'analisi completa.</div>'}</div>`;
};

function strength() {
  return `<div class="sec-t"><h2>Forza e mobilità da camera d'hotel</h2></div>
  <p class="muted small" style="margin:12px 0">Corpo libero, zero attrezzi. Indicativamente 2 sessioni a settimana da 15-20' più 5' di mobilità dopo le corse: la frequenza la decide José, che richiama le routine nel piano con la loro lettera.</p>
  <div class="lib">${Object.entries(E.STRENGTH).map(([k, r]) => `<div class="routine"><span class="rk">ROUTINE ${k} · ${r.min}'</span><h3>${esc(r.name)}</h3><ol>${r.ex.map(([n, d, c]) => `<li><b>${esc(n)}</b> <span class="mono">${esc(d)}</span><span>${esc(c)}</span></li>`).join('')}</ol></div>`).join('')}</div>`;
}
function nutrition() {
  const ph = S.ctx.ph;
  const longP = S.data.plan.find((p) => p.kind === 'long' && p.date >= S.ctx.todayDate);
  return `<div class="sec-t"><h2>Integrazione e scarico</h2></div>
  <div class="card nutri" style="margin-top:14px"><div>
    <span class="eyebrow">Calcolatore per il prossimo lungo</span>
    <div class="calc">
      <label class="f">Durata (min)<input type="number" id="fcMin" min="30" max="360" inputmode="numeric" value="${longP?.min || 90}"></label>
      <label class="f">Temperatura (°C)<input type="number" id="fcTemp" min="-5" max="40" inputmode="numeric" value="16"></label>
    </div>
    <div class="calc-out" id="fcOut"></div>
    <p class="muted small" style="margin-top:10px">Stima indicativa: gel da ~25 g di carboidrati, il primo dopo 45'. Prova nei lunghi ogni prodotto che userai in gara, mesi prima. ${esc(E.FUEL_NOTE)}</p>
  </div><div>
    <span class="eyebrow">${ph.id === 'taper' ? 'Scarico: cosa fare adesso' : 'Piano di scarico (ultime 3 settimane)'}</span>
    <ul class="timeline">${E.TAPER_TIMELINE.map((t) => `<li><b>${esc(t.when)}</b><span>${esc(t.what)}</span></li>`).join('')}</ul>
  </div></div>`;
}

const chatUnits = () => [{ id: 'chat', html: chatList(), cls: 'u-feed' }, { id: 'ask', html: composer(), cls: 'u-composer' }];
export const libUnits = () => [{ id: 'strength', html: strength() }, { id: 'nutri', html: nutrition() }];

// Su PC la chat vive nella colonna a destra: a sinistra restano commenti, report e focus
export function units() {
  const views = S.wide ? VIEWS.slice(1) : [...VIEWS, ['lib', 'Libreria']];
  const v = views.some(([k]) => k === S.coachView) ? S.coachView : views[0][0];
  if (v !== S.coachView) S.coachView = v;
  const body = v === 'chat' ? chatUnits() : v === 'report' ? [{ id: 'reports', html: reports() }] : v === 'lib' ? libUnits() : [{ id: 'focus', html: focus() }, { id: 'feed', html: feedList(), cls: 'u-feed' }];
  return [{ id: 'cview', html: viewSwitch(views) }, ...body];
}
export function railUnits() {
  return [{ id: 'railh', html: `<div class="rail-h"><h2>${JM} José</h2><span class="muted small">${S.demo ? 'demo' : esc(J.joseStatus(S.data.jose?.last).ok ? 'attivo' : 'da controllare')}</span></div>` }, { id: 'rchat', html: chatList(), cls: 'u-feed' }, { id: 'rask', html: composer(), cls: 'u-composer' }];
}
