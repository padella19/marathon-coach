// ============================================================================
// Marathon Coach — nucleo condiviso dell'interfaccia: stato, helper, icone e i
// piccoli componenti usati da più sezioni (chip, anello, sparkline, voce del feed).
// ============================================================================
import * as E from '../lib/engine.js';
import * as J from '../lib/jose.js';
export { E, J };

export const $ = (s, r = document) => r.querySelector(s);
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const store = {
  get(k, d = null) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage non disponibile */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* idem */ } },
};
export const hash = (str) => { let h = 5381; for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0; return h; };
export const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export const TABS = ['oggi', 'settimana', 'analisi', 'coach', 'gara', 'libreria'];
let applied = [];
try { applied = JSON.parse(store.get('mc_applied', '[]')) || []; } catch { /* riparte vuoto */ }

// Stato dell'interfaccia (i dati del Worker stanno in S.data, i calcoli in S.ctx)
export const S = {
  data: null, demo: false, ctx: null, err: null,
  tab: 'oggi', weekOff: 0, period: store.get('mc_period', '12'), coachView: 'chat', rec: null, fuelOpen: null,
  wide: false, narrow: false, unread: false, open: {}, applied: new Set(applied),
  charts: {}, chartSig: null, units: {}, layoutKey: null, pending: false,
  lastFeedId: null, newFeedId: null, lastFetch: 0, polling: null, burstUntil: 0, sig: null,
};
export const markApplied = (key) => { S.applied.add(key); store.set('mc_applied', JSON.stringify([...S.applied].slice(-200))); };
// Le azioni (chiamate al Worker o simulazione demo) le registra app.js
export const ACT = {};

// ---------------------------------------------------------------- Testi
export const ago = (ts) => { const s = (Date.now() - ts) / 1000; if (s < 60) return 'ora'; if (s < 3600) return `${Math.round(s / 60)} min fa`; if (s < 86400) return `${Math.round(s / 3600)} h fa`; return `${Math.round(s / 86400)} g fa`; };
export const KIND_IT = { easy: 'Facile', quality: 'Qualità', long: 'Lungo', runwalk: 'Corsa/cammino', strength: 'Forza', rest: 'Riposo', race: 'Gara', pause: 'Pausa' };
export const VERDICT = { on_track: ['In linea', 'good'], too_hard: ['Troppo forte', 'warn'], too_easy: ['Margine', 'info'], warning: ['Attenzione', 'bad'], info: ['Info', 'info'] };
export const FEED_KIND = { activity: ['Uscita', 'pulse'], checkin: ['Check-in', 'clip'], weekly: ['Focus settimana', 'flag'], answer: ['Risposta', 'chat'], report: ['Report', 'flag'], system: ['Sistema', 'info'], review: ['Check-up', 'flag'], checkup_q: ['Check-up', 'clip'], note: ['Nota', 'chat'] };
const SRC = { ai: 'AI', claude: 'José', rules: 'regole' };
export const romeHM = () => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
// Monogramma di José: niente faccia, una J in corsia
export const JM = '<span class="jm" aria-hidden="true">J</span>';
export const ADJ_IT = { keep: 'Confermata', reduce: 'Ridotta', easy: 'Solo facile', rest: 'Riposo', move: 'Spostata', replace: 'Sostituita' };
export const STATUS = { done: ['Fatta', 'good'], partial: ['Parziale', 'warn'], missed: ['Saltata', 'bad'], extra: ['Extra', 'info'], today: ['Oggi', 'accent'], pause: ['Pausa', 'muted'] };
export const RUN_KINDS = ['easy', 'quality', 'long', 'runwalk', 'race'];
export const dayNum = (d) => +d.slice(8);
export const fmtKm = (v, dec = 1) => v.toFixed(dec).replace('.', ',');
export const fmtNum = (v, dec = 2) => v.toFixed(dec).replace('.', ',');
export function zoneRange(zone, hrp) {
  const n = String(zone || '').match(/\d/g); if (!n) return null;
  const a = hrp.zones[+n[0] - 1], b = hrp.zones[+n[n.length - 1] - 1];
  return a && b ? `${a.lo}-${b.hi}` : null;
}
export const kmEst = (min, kind) => (min ? ((kind === 'runwalk' ? min * 0.55 : min) * 60) / S.ctx.m.easyPace : 0);

// ---------------------------------------------------------------- Icone (tratto, 24×24)
const ICONS = {
  today: '<circle cx="12" cy="13.5" r="7"/><path d="M12 13.5l2.6-2.8M10 3.5h4M12 3.5v3"/>',
  week: '<rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  chart: '<path d="M3.5 20.5h17M6.5 17v-5M12 17V6M17.5 17v-8"/>',
  chat: '<path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H11l-4.5 4v-4A2.5 2.5 0 0 1 4 13.5z"/>',
  sync: '<path d="M20.5 12a8.5 8.5 0 1 1-2.8-6.3L20.5 8"/><path d="M20.5 3.5V8H16"/>',
  sliders: '<path d="M4 7h9M18 7h2M4 17h2M11 17h9"/><circle cx="15.5" cy="7" r="2.3"/><circle cx="8.5" cy="17" r="2.3"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.5 1.5M17.2 17.2l1.5 1.5M5.3 18.7l1.5-1.5M17.2 6.8l1.5-1.5"/>',
  moon: '<path d="M20 14.2A8 8 0 1 1 9.8 4a6.4 6.4 0 0 0 10.2 10.200z"/>',
  bag: '<rect x="4" y="8" width="16" height="11.500" rx="2.200"/><path d="M9 8V6.300A1.800 1.800 0 0 1 10.800 4.500h2.400A1.800 1.800 0 0 1 15 6.300V8M4 13h16"/>',
  check: '<path d="M5 12.500l4.500 4.500L19 7.500"/>',
  x: '<path d="M6.500 6.500l11 11M17.500 6.500l-11 11"/>',
  left: '<path d="M14.500 6l-6 6 6 6"/>', right: '<path d="M9.500 6l6 6-6 6"/>', down: '<path d="M6 9.500l6 6 6-6"/>',
  pulse: '<path d="M3 12.500h4l2.500-6.500 4.500 12.500 2.500-6h4.500"/>',
  clip: '<rect x="5" y="5" width="14" height="16" rx="2.200"/><path d="M9 3.500h6v3H9zM9 13.500l2.200 2.200 4-4.500"/>',
  flag: '<path d="M6 21V4M6 5h11.500l-2.700 3.600 2.700 3.600H6"/>',
  info: '<circle cx="12" cy="12" r="8.500"/><path d="M12 11v5.500M12 7.700v.2"/>',
  send: '<path d="M4.500 12L20 4.500 14.500 20l-2.800-6.200z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  pause: '<rect x="7" y="5" width="3.500" height="14" rx="1"/><rect x="13.500" y="5" width="3.500" height="14" rx="1"/>',
  watch: '<rect x="7" y="7" width="10" height="10" rx="2.500"/><path d="M9 7l.7-3.500h4.600L15 7M9 17l.7 3.500h4.600L15 17"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.500 11.500a6.500 6.500 0 0 0 13 0M12 18v3"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="1.500"/>',
  medal: '<circle cx="12" cy="14.500" r="5.500"/><path d="M8.500 3.500l2 5.800M15.500 3.500l-2 5.800"/>',
  sunb: '<circle cx="12" cy="12" r="3.500"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.600 5.600l1.400 1.400M17 17l1.400 1.400M5.600 18.400L7 17M17 7l1.400-1.400"/>',
};
export const ico = (name, cls = '') => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;

// ---------------------------------------------------------------- Componenti
export const chip = (tone, text, icon) => `<span class="chip" data-tone="${tone}">${icon ? ico(icon) : ''}${esc(text)}</span>`;

// Anello Readiness: l'animazione 0 → valore la avvia app.js quando la sezione si apre
export function ring(score, tone) {
  const C = 2 * Math.PI * 44, off = C * (1 - score / 100);
  const col = tone === 'good' ? 'var(--good)' : tone === 'warn' ? 'var(--warn)' : 'var(--bad)';
  return `<div class="ring" role="img" aria-label="Readiness ${score} su 100"><svg viewBox="0 0 100 100"><circle class="trk" cx="50" cy="50" r="44" fill="none" stroke-width="9"/><circle class="val" cx="50" cy="50" r="44" fill="none" stroke="${col}" stroke-width="9" stroke-linecap="round" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}" data-c="${C.toFixed(1)}" data-off="${off.toFixed(1)}"/></svg><div class="v"><b data-count="${score}">${score}</b><span>Readiness</span></div></div>`;
}

// Mini-sparkline SVG. vals: numeri o null; band: [lo, hi] evidenzia una fascia; color: accent | lane
export function spark(vals, { color = '', band = null, min = null, max = null, label = '' } = {}) {
  const pts = vals.map((v, i) => [i, v]).filter(([, v]) => v != null && isFinite(v));
  if (pts.length < 2) return '<svg class="spark" viewBox="0 0 96 34" aria-hidden="true"></svg>';
  const W = 96, H = 34, pad = 4;
  let lo = min ?? Math.min(...pts.map((p) => p[1])), hi = max ?? Math.max(...pts.map((p) => p[1]));
  if (band) { lo = Math.min(lo, band[0]); hi = Math.max(hi, band[1]); }
  if (hi - lo < 1e-9) { hi += 1; lo -= 1; }
  const n = vals.length - 1 || 1;
  const x = (i) => pad + (i / n) * (W - 2 * pad), y = (v) => H - pad - ((v - lo) / (hi - lo)) * (H - 2 * pad);
  const last = pts[pts.length - 1];
  return `<svg class="spark" data-c="${color}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(label || 'andamento')}">${band ? `<rect class="band" x="0" width="${W}" y="${y(band[1]).toFixed(1)}" height="${(y(band[0]) - y(band[1])).toFixed(1)}" rx="2"/>` : ''}<polyline points="${pts.map(([i, v]) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}"/><circle cx="${x(last[0]).toFixed(1)}" cy="${y(last[1]).toFixed(1)}" r="2.6"/></svg>`;
}

export function zbar(a) {
  const z = E.zoneSeconds(a, S.ctx.m.hrp), t = z.reduce((x, y) => x + y, 0);
  if (!t) return '<span class="zbar" title="Zone non disponibili"></span>';
  const lbl = z.map((v, i) => `Z${i + 1} ${Math.round((v / t) * 100)}%`).join(' · ');
  return `<span class="zbar" role="img" aria-label="${lbl}" title="${lbl}">${z.map((v, i) => `<i style="width:${(v / t) * 100}%;background:var(--z${i + 1})"></i>`).join('')}</span>`;
}

export function rateBox(type, id, rating, note) {
  const b = (r, l, e) => `<button class="btn sm ghost rate-b" data-a="rate" data-t="${type}" data-f="${esc(id)}" data-r="${r}" type="button" aria-label="${l}" title="${l}">${e}</button>`;
  if (!rating) return `<div class="fi-rate">${b('up', 'Utile', '👍')}${b('down', 'Non mi torna', '👎')}</div>`;
  return `<div class="fi-rate"><span class="small muted">${rating === 'up' ? '👍' : '👎'} ${note ? '“' + esc(note) + '”' : 'José ne terrà conto.'}</span>${note ? '' : `<form class="rate-note" data-t="${type}" data-f="${esc(id)}" data-r="${rating}"><input type="text" id="rn_${esc(id)}" maxlength="200" placeholder="Nota facoltativa: cosa ti serve?" aria-label="Nota per José"><button class="btn sm" type="submit">Invia</button></form>`}</div>`;
}

// Voce del feed del coach (timeline). Usata in Coach, nella colonna desktop e in Oggi.
export function feedItem(f) {
  const [vl, vt] = VERDICT[f.verdict] || VERDICT.info;
  const [kl, ki] = FEED_KIND[f.kind] || ['Coach', 'chat'];
  const adj = (a, i) => {
    const key = `${f.id}:${i}`, done = S.applied.has(key);
    const dest = a.action === 'move' && a.to_date ? ` → ${E.DOW_IT[E.dow(a.to_date)]} ${E.fmtDate(a.to_date)}` : '';
    const open = a.action === 'move' && !a.to_date;
    return `<div><span><b class="mono">${E.DOW_IT[E.dow(a.date)]} ${E.fmtDate(a.date)}${dest}</b> · ${esc(a.new_title || ADJ_IT[a.action] || a.action)}${a.new_min ? ' · ' + a.new_min + '\'' : ''}${a.reason ? ' — ' + esc(a.reason) : ''}</span>
      ${done ? `<button class="btn sm" type="button" disabled>${ico('check')}Applicato</button>` : `<button class="btn sm ${open ? '' : 'primary'}" data-a="apply" data-f="${esc(f.id)}" data-i="${i}" type="button">${open ? 'Apri giornata' : 'Applica'}</button>`}</div>`;
  };
  const coachy = f.source === 'claude' || f.source === 'ai';
  const canUndo = f.kind === 'review' && f.snapshotId && !f.undone && f.undoUntil > Date.now();
  const rate = !f.pending && f.kind !== 'checkup_q' && f.kind !== 'system' ? rateBox('feed', f.id, f.rating, f.ratingNote) : '';
  const review = f.kind === 'review' ? `${f.diff?.length ? `<details class="fi-diff"><summary>${f.diff.length} ${f.diff.length === 1 ? 'giorno cambiato' : 'giorni cambiati'}${f.runsPerWeek ? ` · ${f.runsPerWeek} corse a settimana` : ''}</summary><ul>${f.diff.map((x) => `<li><b class="mono">${E.DOW_IT[E.dow(x.date)]} ${E.fmtDate(x.date)}</b><span>${esc(x.before)} → <b>${esc(x.after)}</b></span></li>`).join('')}</ul></details>` : ''}
      ${f.corrections?.length ? `<div class="fi-corr"><span class="eyebrow">Limiti di sicurezza</span>${f.corrections.map((c) => `<span>${esc(c)}</span>`).join('')}</div>` : ''}
      ${f.undone ? '<div class="small muted">Annullata: il piano è tornato com\'era.</div>' : canUndo ? `<div><button class="btn sm" data-a="undo-review" data-s="${esc(f.snapshotId)}" type="button">Annulla ricalibrazione</button></div>` : ''}` : '';
  return `<article class="fi ${f.id === S.newFeedId ? 'new' : ''} ${f.pending ? 'pending' : ''}" data-v="${esc(f.verdict)}">
    <div class="fi-ico">${ico(ki)}</div>
    <div class="fi-b">
      <div class="fh"><b>${kl}</b><span>${ago(f.ts)}${f.refDate ? ' · ' + E.fmtDate(f.refDate) : ''}</span>${chip(vt, vl)}<span class="src">${SRC[f.source] || 'regole'}</span></div>
      ${f.question ? `<div class="q">“${esc(f.question)}”</div>` : ''}
      <h4>${esc(f.headline)}</h4><p>${esc(f.summary)}</p>
      ${f.detail ? `<details class="fi-detail" data-fold="det-${esc(f.id)}"><summary>Approfondisci</summary><div>${esc(f.detail)}</div></details>` : ''}
      ${f.kpis?.length ? `<div class="fk">${f.kpis.map((k) => `<span data-s="${esc(k.status)}">${esc(k.label)} <b>${esc(k.value)}</b></span>`).join('')}</div>` : ''}
      ${f.adjustments?.length ? `<div class="adj">${f.adjustments.map(adj).join('')}</div>` : ''}
      ${f.tips?.length ? `<div class="tips">${f.tips.map((t) => `<span><b>${esc(TIP_IT[t.type] || t.type)}:</b> ${esc(t.text)}</span>`).join('')}</div>` : ''}
      ${review}
      
      ${rate}
    </div></article>`;
}
const TIP_IT = { nutrition: 'Alimentazione', recovery: 'Recupero', travel: 'Trasferta', technique: 'Tecnica', motivation: 'Testa' };
