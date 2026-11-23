import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../public/lib/engine.js';
import * as J from '../public/lib/jose.js';
import worker from '../src/index.js';
import { pickHours } from '../src/jose.js';

const S = { ...E.DEFAULT_SETTINGS, planStart: '2026-12-10', raceDate: '2027-10-31', hrMax: 185, hrRest: 55 };
const plan = E.generatePlan(S), pIdx = E.planIndex(plan);
const run = (date, min, o = {}) => ({ id: 'r' + date, date, start: date + 'T07:00:00', type: 'Run', name: 'Corsa', moving_min: min, dist_km: o.km ?? Math.round((min / 7) * 10) / 10, avg_hr: o.hr ?? 135, max_hr: 150, pace_s: 420, speed: 1000 / 420, ...o });
const base = (today, acts = [], extra = {}) => ({ today, acts, pIdx, overrides: {}, checkins: {}, trips: { manual: [], ical: [] }, tripSet: new Map(), m: E.computeMetrics(acts, S, today), settings: S, ...extra });

test('check-in corto: readiness da energia, gambe, fastidio e giornata (niente sonno)', () => {
  const good = E.readiness({ energy: 4, legs: 1, day: 'light', pain: { level: 0 } }, null);
  const bad = E.readiness({ energy: 2, legs: 5, day: 'heavy', pain: { area: 'Polpaccio', level: 3 } }, null);
  assert.equal(good.score, 83); assert.equal(bad.score, 17);
  assert.deepEqual(bad.factors, ['energia bassa', 'gambe pesanti', 'giornata pesante', 'fastidio Polpaccio 3/10']);
  assert.equal(E.readiness({ sleep: 4, energy: 3, soreness: 2, stress: 3 }, null).score, 72); // i vecchi check-in restano leggibili
  assert.deepEqual(E.checkinTrend({ '2027-03-01': { date: '2027-03-01', energy: 3, legs: 2, day: 'heavy', pain: { level: 0 } } }, '2027-03-01', 3), [{ data: '2027-03-01', energia: 3, gambe: 2, giornata: 'pesante', fastidio: null }]);
});

test('motore a regole: gambe 4/5 tolgono la qualità; trasferta con sola camera diventa forza', () => {
  const q = { date: '2027-03-11', kind: 'quality', title: 'Fartlek', min: 45, hotel: true };
  const r = E.adaptSession(q, { ci: { energy: 3, legs: 4, day: 'normal' }, ready: { score: 55 }, date: q.date });
  assert.equal(r.session.kind, 'easy'); assert.match(r.changes.join(' '), /Gambe 4\/5/);
  const room = E.adaptSession(q, { trip: true, ready: { score: 70 }, tripSet: new Map([[q.date, 'Verona']]), date: q.date, facilities: ['room', 'breakfast'] });
  assert.equal(room.session.kind, 'strength'); assert.equal(room.session.strength, 'B');
  const tm = E.adaptSession(q, { trip: true, ready: { score: 70 }, tripSet: new Map([[q.date, 'Verona']]), date: q.date, facilities: ['treadmill'] });
  assert.equal(tm.session.kind, 'quality'); assert.match(tm.session.tripNote, /qualità si può fare/);
});

test('luoghi: le dotazioni salvate per città valgono per le trasferte successive', () => {
  const trips = { manual: [{ id: 'a', start: '2027-03-09', end: '2027-03-10', city: 'Verona' }, { id: 'b', start: '2027-05-04', end: '2027-05-05', city: ' VERONA ' }], ical: [], places: { verona: { city: 'Verona', treadmill: true, gym: false, outdoor: false, early_breakfast: true } } };
  assert.deepEqual(E.tripOn(trips, '2027-05-04').facilities, ['treadmill', 'breakfast']);
  assert.equal(J.placeText(trips.places.verona), 'tapis roulant, colazione presto (no: palestra, parco o lungofiume vicino)');
  assert.equal(E.placeKey('Città di Castello'), J.cityKey('citta di  castello'));
});

test('segnali: sessione saltata, facile troppo forte, nessun check-in, fastidio ripetuto, trasferta, meteo', () => {
  const today = '2027-03-12'; // venerdì: martedì 9 facile, giovedì 11 qualità
  const acts = [run('2027-03-09', pIdx['2027-03-09'].min, { hr: 150, hist: { [E.hrBucket(128)]: 1500, [E.hrBucket(162)]: 900 } })];
  const trips = { manual: [{ id: 't', start: '2027-03-13', end: '2027-03-13', city: 'Bologna' }], ical: [] };
  const meteo = { days: { '2027-03-13': { city: 'Bologna', hour: 7, feels: 1, temp: 4, rain_prob: 10, rain_mm: 0, wind: 8, best: { hour: 13, feels: 8, rain_prob: 10 } } } };
  const checkins = { '2027-03-08': { date: '2027-03-08', pain: { area: 'Ginocchio', level: 5 } }, '2027-03-09': { date: '2027-03-09', pain: { area: 'Ginocchio', level: 6 } } };
  const ov = { '2027-03-13': { date: '2027-03-13', kind: 'easy', title: 'Facile', min: 30 } };
  const sig = J.signals({ ...base(today, acts), overrides: ov, trips, meteo, checkins });
  const tipi = sig.map((s) => s.tipo);
  for (const t of ['nessun_checkin', 'sessione_saltata', 'facile_troppo_forte', 'fastidio_ripetuto', 'trasferta_dotazioni_ignote', 'meteo_avverso']) assert.ok(tipi.includes(t), t);
  assert.match(sig.find((s) => s.tipo === 'sessione_saltata').id, /^missed:2027-03-11$/);
  assert.ok(sig.find((s) => s.tipo === 'fastidio_ripetuto').sicurezza);
  assert.match(sig.find((s) => s.tipo === 'meteo_avverso').consiglio_regole, /13:00/);
  // con "Non riesco" la sessione non risulta saltata senza avvisare; con il luogo noto la trasferta non è un segnale; in pausa silenzio
  const sig2 = J.signals({ ...base(today, acts), trips, places: { bologna: {} }, skips: [{ date: '2027-03-11', title: 'x', label: 'La salto' }] }).map((s) => s.tipo);
  assert.ok(!sig2.includes('sessione_saltata') && !sig2.includes('trasferta_dotazioni_ignote') && sig2.includes('non_riesco'));
  assert.deepEqual(J.signals({ ...base(today, acts), pause: { from: today } }), []);
});

test('segnale: volume settimanale oltre il piano', () => {
  const today = '2027-03-11', mon = E.mondayOf(today);
  const sig = J.signals(base(today, [run(mon, 90), run(E.addDays(mon, 1), 90), run(E.addDays(mon, 2), 90)]));
  assert.ok(sig.some((s) => s.tipo === 'volume_oltre_piano'));
});

test('badge: lunghi, 100 km nel mese, settimane di fila, trasferta, primo test', () => {
  const today = '2027-03-01', acts = [];
  for (const p of plan) if (p.date < today && E.RUN_KINDS.includes(p.kind) && !p.optional && p.date >= '2027-01-04') acts.push(run(p.date, p.min, p.kind === 'long' ? { km: 15.2 } : {}));
  const b = J.computeBadges({ acts, pIdx, overrides: {}, tripSet: new Map([['2027-01-12', 'Torino']]), today, settings: S, tests: [{ date: '2027-02-20' }] });
  assert.equal(b.week1, '2027-01-10'); assert.equal(b.streak4, '2027-01-31'); assert.equal(b.streak8, '2027-02-28'); assert.ok(!b.streak12);
  assert.ok(b.long10 && b.long15 && !b.long20); assert.equal(b.trip1, '2027-01-12'); assert.equal(b.test1, '2027-02-20'); assert.ok(b.month100);
  assert.equal(J.BADGES.length, 13);
});

test('test e previsione: Riegel con forchetta, zone di passo, risultato ricavato dall\'uscita', () => {
  const p = J.predict(5, 1800); // 5 km in 30'
  assert.ok(p.lo < p.sec && p.sec < p.hi);
  assert.equal(p.lo, Math.round(1800 * Math.pow(42.195 / 5, 1.06)));
  assert.equal(J.fmtHMS(p.sec), '5h13'); assert.equal(E.fmtPace(p.passo_s), '7:26/km');
  const z = J.paceZones(5, 1800); assert.equal(z[3].da, 360); assert.ok(z[0].da > z[0].a && z[0].a > z[1].da);
  const a = run('2027-03-06', 50, { splits: [420, 410, 355, 350, 352, 348, 351, 430].map((s) => ({ p: s })) });
  assert.deepEqual(J.extractTest(a, '5k'), { dist_km: 5, time_s: 1756, hr_avg: 135, hr_max: 150 });
  const t30 = J.extractTest(run('2027-03-06', 40, { splits: Array.from({ length: 7 }, () => ({ p: 360 })) }), '30min');
  assert.equal(t30.dist_km, 5); assert.equal(t30.time_s, 1800);
  assert.equal(J.testDue([], '2027-01-01', S).da_pianificare, false); // condizionamento: niente test
  assert.equal(J.testDue([], '2027-03-01', S).da_pianificare, true);
  assert.equal(J.testDue([{ date: '2027-02-10' }], '2027-03-01', S).da_pianificare, false);
  const rp = J.racePlan(p); assert.equal(rp.length, 3); assert.ok(rp[0].lo > rp[1].lo);
});

test('"Non riesco": due opzioni valide più "la salto", nei limiti di sicurezza', () => {
  const c = { pIdx, overrides: {}, tripSet: new Map(), settings: S };
  const thu = plan.find((p) => p.kind === 'quality' && p.date > '2027-03-01').date, fri = E.addDays(thu, 1), r = J.skipOptions(thu, c); // qualità del giovedì
  assert.deepEqual(r.options.map((o) => o.k), ['move', 'short', 'skip']);
  const mv = r.options[0];
  assert.equal(mv.to, fri); assert.equal(mv.patch[thu].kind, 'rest'); assert.equal(mv.patch[mv.to].min, pIdx[thu].min);
  assert.equal(r.options[1].patch[fri].min, 25); assert.equal(r.options[1].patch[fri].kind, 'easy');
  // la qualità non finisce accanto al lungo: se venerdì è occupato, sabato (vigilia del lungo) non è ammesso
  const r2 = J.skipOptions(thu, { ...c, overrides: { [fri]: { date: fri, kind: 'easy', title: 'Facile', min: 30 } } });
  assert.ok(!r2.options.some((o) => o.k === 'move')); assert.equal(r2.options[0].k, 'short'); assert.equal(r2.options[0].to, thu);
  // il lungo non si sposta in un giorno di trasferta; nella settimana nuova va ridotto del 20%
  const sun = E.addDays(thu, 3), mon = E.addDays(thu, 4), r3 = J.skipOptions(sun, { ...c, tripSet: new Map([[mon, 'Roma']]) });
  assert.equal(pIdx[sun].kind, 'long');
  assert.ok(!r3.options.some((o) => o.k === 'move' && o.to === mon));
  const r4 = J.skipOptions(sun, c).options.find((o) => o.k === 'move');
  assert.equal(r4.to, mon); assert.equal(r4.patch[r4.to].min, Math.max(20, Math.round((pIdx[sun].min * 0.8) / 5) * 5));
  assert.equal(J.skipOptions('2027-03-08', c), null); // lunedì di riposo
});

test('scarpe: km per paio, predefinita dalla data d\'inizio, avviso alla soglia', () => {
  const shoes = { list: [{ id: 'a', model: 'A', start: '2027-02-01', km0: 560, limit: 600, def: true }, { id: 'b', model: 'B', start: '2027-01-01', km0: 0 }], assign: { 'r2027-02-10': 'b' } };
  const acts = [run('2027-01-20', 60, { km: 9 }), run('2027-02-05', 60, { km: 10 }), run('2027-02-10', 60, { km: 8 }), run('2027-02-12', 200, { km: 31 })];
  const [a, b] = J.shoeKm(shoes, acts);
  assert.equal(a.km, 601); assert.ok(a.alert); assert.equal(b.km, 8); assert.equal(b.limit, 600);
  assert.ok(J.signals({ ...base('2027-02-13', acts), shoes }).some((s) => s.tipo === 'scarpe_a_fine_vita'));
});

test('meteo: fascia oraria preferita, ora migliore e soglia del freddo', () => {
  const time = [], t = [], f = [], pr = [], mm = [], w = [];
  for (let h = 0; h < 24; h++) { time.push(`2027-01-10T${String(h).padStart(2, '0')}:00`); t.push(h < 10 ? 2 : 9); f.push(h < 10 ? -1 : 8); pr.push(5); mm.push(0); w.push(10); }
  const d = pickHours({ time, temperature_2m: t, apparent_temperature: f, precipitation_probability: pr, precipitation: mm, wind_speed_10m: w }, '2027-01-10', 7, 5);
  assert.equal(d.feels, -1); assert.equal(d.best.hour, 10);
  const v = J.weatherVerdict(d, 5); assert.ok(v.bad); assert.match(v.consiglio, /10:00/);
  assert.equal(J.weatherVerdict({ ...d, feels: 6, best: { hour: 7, feels: 6 } }, 5).bad, false);
  assert.match(J.weatherVerdict({ hour: 7, feels: 2, rain_prob: 90, rain_mm: 2, wind: 5, best: { hour: 7, feels: 2 } }, 5).consiglio, /tapis roulant/);
});

test('stato di José e prossimo giro', () => {
  assert.deepEqual(J.nextRun('06:30', {}), { quando: 'stamattina', ora: '07:00' });
  assert.equal(J.nextRun('12:00', {}).quando, 'stasera'); assert.equal(J.nextRun('22:10', { runMorning: '06:45' }).ora, '06:45');
  const now = Date.parse('2027-03-03T12:00:00Z');
  assert.equal(J.joseStatus(Date.parse('2027-03-03T06:02:00Z'), now).testo, 'attivo · ultima visita stamattina 07:02');
  assert.equal(J.joseStatus(now - 40 * 3.6e6, now).testo, 'José non si fa vivo da 40 ore: controlla le attività programmate');
  assert.ok(J.joseStatus(null).mai);
});

test('alimentazione prudente: niente grammi per chilo, sempre un perché e la nota del nutrizionista', () => {
  for (const s of [null, { kind: 'easy', min: 40 }, { kind: 'quality', min: 50 }, { kind: 'long', min: 80 }, { kind: 'long', min: 150 }, { kind: 'race', min: 0 }, { kind: 'strength', min: 20 }]) {
    const f = E.fueling(s, { weightKg: 78 }), all = [f.pre, f.during, f.post, ...Object.values(f.why)].join(' ');
    assert.ok(!/g\/kg|kcal|calorie|\b78\b/.test(all), all);
    assert.match(f.note, /nutrizionista/);
    for (const k of ['pre', 'during', 'post']) if (f[k]) assert.ok(f.why[k], `perché mancante: ${k}`);
  }
  assert.match(E.fueling({ kind: 'long', min: 120 }).during, /90'/); assert.match(E.fueling({ kind: 'long', min: 120 }).why.during, /allenare l'intestino/);
  assert.equal(E.fueling({ kind: 'long', min: 80 }).gut, undefined);
  assert.match(E.fueling({ kind: 'easy', min: 30 }, {}, 2).pre, /Ultimi giorni prima della gara/);
});

// ---------- Worker: connettore e chat con un KV in memoria ----------
function fakeEnv() {
  const mem = new Map();
  return { mem, DASH_TOKEN: 'dash', MCP_SECRET: 's'.repeat(40), ASSETS: { fetch: () => new Response('x') },
    KV: { get: async (k, t) => (mem.has(k) ? (t === 'json' ? JSON.parse(mem.get(k)) : mem.get(k)) : null), put: async (k, v) => void mem.set(k, v), delete: async (k) => void mem.delete(k), list: async ({ prefix = '' } = {}) => ({ keys: [...mem.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }) } };
}
const ctx = { waitUntil: (p) => p?.catch?.(() => {}) };
const tool = async (env, name, args, { path = '/mcp', auth = `Bearer ${env.MCP_SECRET}` } = {}) => {
  const r = await worker.fetch(new Request('http://x' + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args || {} } }) }), env, ctx);
  return r.status === 200 ? JSON.parse((await r.json()).result.content[0].text) : { status: r.status };
};
const dash = async (env, path, body) => (await worker.fetch(new Request('http://x' + path, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer dash', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }), env, ctx)).json();

test('connettore: token nell\'header, percorso accettato in transizione e spegnibile', async () => {
  const env = fakeEnv(); globalThis.fetch = async () => { throw new Error('rete spenta nei test'); };
  assert.equal((await tool(env, 'coach_update_memory', { add: ['prova'] })).facts.length, 1);
  assert.equal((await tool(env, 'coach_update_memory', {}, { auth: 'Bearer sbagliato' })).status, 401);
  assert.equal((await tool(env, 'coach_update_memory', {}, { auth: null })).status, 401);
  assert.ok((await tool(env, 'coach_update_memory', {}, { path: '/mcp/' + env.MCP_SECRET, auth: null })).facts);
  env.MCP_PATH_AUTH = 'off';
  assert.equal((await tool(env, 'coach_update_memory', {}, { path: '/mcp/' + env.MCP_SECRET, auth: null })).status, 404);
  assert.ok(JSON.parse(env.mem.get('mcp_status')).last_mcp_call > Date.now() - 5000); // "ultima visita" per la dashboard
});

test('chat: in attesa → risposta; un solo messaggio spontaneo per giro; voto con nota nel briefing', async () => {
  const env = fakeEnv();
  await dash(env, '/api/chat', { text: 'Domani sono a Verona' });
  await dash(env, '/api/checkin', { date: E.todayISO(), energy: 4, legs: 2, day: 'light', pain: { level: 0 }, sleep: 5 });
  assert.equal(JSON.parse(env.mem.get('checkin:' + E.todayISO())).sleep, undefined); // il sonno non si salva più
  const b = await tool(env, 'coach_get_briefing');
  assert.match(b.protocollo, /Sei JOSÉ/); assert.match(b.protocollo, /NON sgridi MAI su dolore/); assert.match(b.protocollo, /AL MASSIMO UNO/);
  for (const k of ['chat_in_attesa', 'chat_recente', 'segnali', 'valutazioni_recenti', 'meteo', 'luoghi', 'scarpe', 'badge_nuovi', 'test', 'previsione', 'report_settimanale']) assert.ok(k in b, k);
  assert.equal(b.chat_in_attesa.length, 1);
  assert.ok((await tool(env, 'coach_send_message', { text: 'no', reply_to: 'inesistente', kind: 'reply' })).error);
  const rep = await tool(env, 'coach_send_message', { text: 'Che hotel?', reply_to: b.chat_in_attesa[0].id, kind: 'reply' });
  assert.ok(rep.ok);
  assert.ok((await tool(env, 'coach_send_message', { text: 'Tre settimane piene.', kind: 'praise', signal_id: 'badge:week1' })).ok);
  assert.match((await tool(env, 'coach_send_message', { text: 'Un altro', kind: 'scolding' })).error, /al massimo uno per giro/);
  assert.ok((await tool(env, 'coach_send_message', { text: 'Ancora una risposta', kind: 'reply' })).ok); // le risposte non sono limitate
  await dash(env, '/api/rate', { type: 'chat', id: rep.id, rating: 'down', note: 'Troppo secco' });
  const b2 = await tool(env, 'coach_get_briefing');
  assert.equal(b2.chat_in_attesa.length, 0);
  assert.deepEqual(b2.valutazioni_recenti.map((v) => [v.voto, v.nota]), [['👎', 'Troppo secco']]);
  const st = await dash(env, '/api/state');
  assert.equal(st.chat.length, 4); assert.ok(st.jose.last); assert.equal(st.ai, false);
});

test('luoghi e profilo dal connettore; report del lunedì con i numeri del Worker', async () => {
  const env = fakeEnv();
  assert.ok((await tool(env, 'coach_set_place_amenities', { city: 'Bologna', treadmill: true, early_breakfast: false })).ok);
  assert.equal(JSON.parse(env.mem.get('trips')).places.bologna.treadmill, true);
  const p = await tool(env, 'coach_update_profile', { set: { quitTriggers: 'Il freddo', inventato: 'x' } });
  assert.deepEqual([p.aggiornati, p.ignorati], [['quitTriggers'], ['inventato']]);
  assert.ok((await tool(env, 'coach_post_weekly_report', { commento: 'x', focus: 'y' })).error);
  const r = await tool(env, 'coach_post_weekly_report', { voto: 12, commento: 'Settimana piena.', bene: ['Lungo'], focus: 'Facili lenti' });
  assert.ok(r.ok && 'corse_fatte' in r.numeri);
  const rep = Object.values(JSON.parse(env.mem.get('reports')))[0];
  assert.equal(rep.voto, 10); assert.equal(JSON.parse(env.mem.get('weekly'))[E.addDays(rep.week, 7)].title, 'Facili lenti');
});
