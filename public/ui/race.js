// Area gara: conto alla rovescia (ultime 3 settimane evidenziate), piano di passo dalla previsione,
// ristori e gel, checklist valigia, logistica. Niente dettagli del percorso inventati: solo ciò che inserisce Luca.
import { E, J, S, esc, ico, chip } from './core.js';

function countdown() {
  const { todayDate, settings, ph } = S.ctx, n = E.diffDays(todayDate, settings.raceDate);
  const [y, mo, d] = settings.raceDate.split('-'), taperFrom = E.addDays(settings.raceDate, -21);
  const weeks = Math.max(0, Math.ceil(n / 7)), inTaper = todayDate >= taperFrom && n >= 0;
  const cells = Array.from({ length: Math.min(weeks, 60) }, (_, i) => `<i class="${weeks - i <= 3 ? 'tp' : ''}" title="${weeks - i} settimane alla gara"></i>`).join('');
  return `<section class="card race-cd"><span class="eyebrow">${esc(settings.raceName)} · ${d}.${mo}.${y}</span>
    <div class="cd-n"><b>${n > 0 ? n : n === 0 ? 'Oggi' : 'Fatta'}</b>${n > 0 ? `<span>${n === 1 ? 'giorno' : 'giorni'} · ${weeks} settimane</span>` : ''}</div>
    ${cells ? `<div class="cd-w" role="img" aria-label="${weeks} settimane alla gara, le ultime 3 sono di scarico">${cells}</div><div class="cd-l small muted"><span>${esc(ph.name)}</span><span>${inTaper ? chip('accent', 'sei nello scarico') : `scarico dal ${E.fmtDate(taperFrom)}`}</span></div>` : ''}
    <ul class="timeline" style="margin-top:14px">${E.TAPER_TIMELINE.map((t) => `<li><b>${esc(t.when)}</b><span>${esc(t.what)}</span></li>`).join('')}</ul></section>`;
}

function pace() {
  const t = [...(S.data.tests || [])].pop(), plan = J.racePlan(t?.previsione);
  if (!plan) return `<section class="card"><span class="eyebrow">Piano di passo</span><h3>Serve un test</h3><p class="muted">Il passo di gara si fissa dalla previsione, che nasce dai test periodici (uno ogni 6-8 settimane). Finché non c'è, il piano è uno solo: correre i primi 10 km più piano di quanto vorresti.</p></section>`;
  const p = t.previsione;
  return `<section class="card"><div class="card-h"><div><span class="eyebrow">Piano di passo · dal test del ${E.fmtDate(t.date)}</span><h3>${J.fmtHMS(p.sec)} <small class="muted">(${J.fmtHMS(p.lo)} – ${J.fmtHMS(p.hi)})</small></h3></div></div>
    <div class="tbl-wrap"><table><thead><tr><th>Tratto</th><th>Passo</th><th>Come</th></tr></thead><tbody>${plan.map((s) => `<tr><td class="n">km ${s.da}–${String(s.a).replace('.', ',')}</td><td class="n">${E.fmtPace(s.lo).replace('/km', '')}–${E.fmtPace(s.hi)}</td><td>${esc(s.nota)}</td></tr>`).join('')}</tbody></table></div>
    <p class="small muted" style="margin-top:10px">Fasce con margine prudente: dal valore centrale della previsione alla parte lenta della forchetta. Si aggiorna a ogni test. L'obiettivo è finirla.</p></section>`;
}

function fuel() {
  const r = S.data.race || {}, f = E.fueling({ kind: 'race' });
  const longs = S.ctx.m.acts.filter((a) => E.isRun(a) && a.moving_min >= 90).length;
  return `<section class="card"><span class="eyebrow">Ristori e gel</span><h3>La strategia si prova nei lunghi</h3>
    <div class="notes"><div><b>Prima:</b> ${esc(f.pre)}</div><div><b>Durante:</b> ${esc(f.during)} <span class="muted">${esc(f.why.during)}</span></div><div><b>Dopo:</b> ${esc(f.post)}</div></div>
    <p class="small" style="margin-top:10px">Lunghi da 90' in su fatti finora: <b>${longs}</b>. Ognuno è una prova generale: stessi gel, stessa colazione, stesso ritmo dei ristori.</p>
    <label class="f" style="margin-top:10px">Il mio piano gel e ristori (cosa ho provato e funziona)<textarea data-race="gel" rows="2" maxlength="500" placeholder="es. gel X ogni 35' con acqua, mai il gusto caffè">${esc(r.notes?.gel || '')}</textarea></label>
    <p class="small muted">${esc(f.note)}</p></section>`;
}

function pack() {
  const r = S.data.race || {}, items = [...J.PACK_LIST, ...(r.extra || []).map((x, i) => [`x${i}`, x])];
  const done = items.filter(([k]) => r.pack?.[k]).length;
  return `<section class="card"><div class="card-h"><div><span class="eyebrow">Checklist valigia</span><h3>${done} di ${items.length}</h3></div></div>
    <ul class="pack">${items.map(([k, l]) => `<li><label class="check"><input type="checkbox" data-pack="${esc(k)}" ${r.pack?.[k] ? 'checked' : ''}> ${esc(l)}</label></li>`).join('')}</ul>
    <form class="ask-row" id="packForm" style="margin-top:10px"><input type="text" id="packNew" maxlength="60" placeholder="Aggiungi una voce…" aria-label="Nuova voce della checklist"><button class="btn" type="submit" aria-label="Aggiungi">${ico('plus')}</button></form></section>`;
}

function logistics() {
  const r = S.data.race || {}, n = r.notes || {};
  const field = (k, l, ph) => `<label class="f">${l}<textarea data-race="${k}" rows="2" maxlength="500" placeholder="${esc(ph)}">${esc(n[k] || '')}</textarea></label>`;
  return `<section class="card"><span class="eyebrow">Logistica</span><h3>Hotel e spostamenti</h3>
    <div class="seg" role="group" aria-label="Hotel scelto" style="margin:10px 0">${[['', 'Da decidere'], ['Maritim', 'Maritim'], ['Avani', 'Avani']].map(([k, l]) => `<button type="button" data-a="race-hotel" data-k="${k}" aria-pressed="${(r.hotel || '') === k}">${l}</button>`).join('')}</div>
    <div style="display:grid;gap:12px">
      ${field('arrivo', 'Viaggio e arrivo in hotel', 'volo o treno, orari, check-in')}
      ${field('partenza', 'Come arrivo alla partenza', 'a piedi o coi mezzi, quanto ci metto, a che ora esco')}
      ${field('traguardo', 'Dopo il traguardo', 'dove ritiro la borsa, come torno in hotel')}
      ${field('vigilia', 'Il giorno prima', 'ritiro pettorale, pranzo e cena, a letto a che ora')}
    </div>
    <p class="small muted" style="margin-top:10px">Qui non ci sono dati inventati sul percorso o sulla città: scrivi tu quello che hai verificato sul sito ufficiale della gara. Si salva quando esci dal campo.</p></section>`;
}

export function units() {
  return [{ id: 'rhead', html: '<div class="an-head"><h2>Gara</h2></div>' }, { id: 'rcd', html: countdown() }, { id: 'rpace', html: pace() }, { id: 'rfuel', html: fuel() }, { id: 'rpack', html: pack() }, { id: 'rlog', html: logistics() }];
}
