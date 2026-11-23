// Sezione "Progressi" (sopra i grafici di analisi): test e previsione, bacheca dei badge, scarpe
import { E, J, S, esc, ico, chip, spark, fmtKm } from './core.js';

function prediction() {
  const tests = S.data.tests || [], last = tests[tests.length - 1], due = J.testDue(tests, S.ctx.todayDate, S.ctx.settings);
  const head = `<div class="card-h"><div><span class="eyebrow">Test ogni 6-8 settimane</span><h3>Previsione maratona</h3></div><button class="btn sm" data-a="test-add" type="button">${ico('plus')}Registra un test</button></div>`;
  if (!last) return `<section class="card">${head}<p class="muted">Ancora nessun test. ${due.da_pianificare ? 'È ora di farne uno: José lo mette nel piano al prossimo check-up.' : 'Il primo arriva dopo il condizionamento iniziale: 5 km al meglio o 30\' a sensazione, messo nel piano da José.'} Dal risultato escono le zone di passo e una previsione del tempo in maratona, con la sua forchetta.</p></section>`;
  const p = last.previsione;
  return `<section class="card">${head}
    <div class="pred"><div class="pred-v"><b class="mono">${J.fmtHMS(p.sec)}</b><span>forchetta ${J.fmtHMS(p.lo)} – ${J.fmtHMS(p.hi)}</span><span>passo gara ${E.fmtPace(p.passo_s)}</span></div>
      <div class="pred-g">${tests.length > 1 ? spark(tests.map((t) => -t.previsione.sec), { color: 'accent', label: 'Andamento delle previsioni: più in alto è più veloce' }) + `<span class="small muted">${tests.length} test · ${tests.map((t) => J.fmtHMS(t.previsione.sec)).join(' → ')}</span>` : '<span class="small muted">Il grafico dell\'andamento compare dal secondo test.</span>'}</div></div>
    <p class="small muted">Stima con la formula di Riegel (esponente 1,10; forchetta 1,06-1,15, perché l'1,06 classico è ottimista per una prima maratona). È informativa: l'obiettivo resta finirla, la previsione serve a fissare il passo di gara.</p>
    <div class="tbl-wrap"><table><thead><tr><th>Data</th><th>Test</th><th>Risultato</th><th>Passo</th><th>FC</th><th>Maratona</th><th></th></tr></thead><tbody>${[...tests].reverse().map((t) => `<tr><td class="n">${E.fmtDate(t.date)}</td><td>${esc(J.TEST_TYPES[t.type] || t.type)}${t.source === 'auto' ? ' ' + chip('muted', 'dall\'uscita') : ''}</td><td class="n">${fmtKm(t.dist_km, 2)} km in ${J.fmtClock(t.time_s)}</td><td class="n">${E.fmtPace(t.passo_s)}</td><td class="n">${t.hr_avg || '—'}</td><td class="n">${J.fmtHMS(t.previsione.sec)}</td><td><button class="icon-btn" data-a="test-del" data-id="${esc(t.id)}" type="button" aria-label="Elimina il test del ${E.fmtDate(t.date)}">${ico('x')}</button></td></tr>`).join('')}</tbody></table></div>
    ${last.zone_passo ? `<div class="targets" style="margin-top:12px">${last.zone_passo.map((z) => `<div class="target"><span>${esc(z.nome)}</span><b>${E.fmtPace(z.da).replace('/km', '')}–${E.fmtPace(z.a)}</b></div>`).join('')}</div>` : ''}
    ${last.nota_fc ? `<p class="small" style="margin-top:10px">${esc(last.nota_fc)}</p>` : ''}</section>`;
}

function badges() {
  const got = S.ctx.badges || {};
  const n = J.BADGES.filter((b) => got[b.id]).length;
  return `<div class="sec-t"><h2>Bacheca</h2><span class="muted small">${n} di ${J.BADGES.length}</span></div>
    <div class="badges">${J.BADGES.map((b) => { const d = got[b.id]; const fresh = d && E.diffDays(d, S.ctx.todayDate) <= 7; return `<div class="badge ${d ? 'on' : ''} ${fresh ? 'new' : ''}" title="${esc(b.desc)}">${ico('medal')}<b>${esc(b.nome)}</b><span>${d ? E.fmtDate(d) + (fresh ? ' · nuovo' : '') : esc(b.desc)}</span></div>`; }).join('')}</div>`;
}

function shoes() {
  const list = J.shoeKm(S.data.shoes, S.ctx.m.acts);
  return `<section class="card"><div class="card-h"><div><span class="eyebrow">Km per paio</span><h3>Scarpe</h3></div><button class="btn sm" data-a="shoes" type="button">${list.length ? 'Modifica' : ico('plus') + 'Aggiungi'}</button></div>
    ${list.length ? `<ul class="shoes">${list.map((x) => `<li class="${x.retired ? 'off' : ''}"><div><b>${esc(x.model)}</b> ${x.def ? chip('accent', 'predefinita') : ''}${x.retired ? chip('muted', 'a riposo') : ''}${x.alert ? chip('bad', 'da cambiare') : x.near ? chip('warn', 'quasi a fine vita') : ''}<span class="small muted">dal ${E.fmtDate(x.start)}</span></div>
      <div class="bar" role="img" aria-label="${x.pct}% della soglia"><i style="width:${Math.min(100, x.pct)}%" data-tone="${x.alert ? 'bad' : x.near ? 'warn' : ''}"></i></div><span class="mono small">${Math.round(x.km)} / ${x.limit} km</span>
      ${x.alert ? '<p class="small">Ammortizzazione a fine vita: ruota con un altro paio e tieni queste per le uscite corte.</p>' : ''}</li>`).join('')}</ul>`
    : '<p class="muted">Registra le scarpe: conto i km di ogni paio e ti avviso a 600 km (soglia modificabile per modello).</p>'}</section>`;
}

export function units() {
  return [{ id: 'pred', html: prediction() }, { id: 'badges', html: badges() }, { id: 'shoes', html: shoes() }, { id: 'lanes2', html: '<div class="lanes" aria-hidden="true"></div>' }];
}
