// Notifiche Telegram: subito solo le cose importanti, il resto nel riepilogo serale.
// Silenzio notturno 22:30-07:00 (ora di Roma): i messaggi importanti aspettano le 07:00.
import { get, put, getFeed } from './store.js';

export const romeNow = () => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour === '24' ? '00' : p.hour}:${p.minute}`, dow: p.weekday };
};
const quiet = (hm) => hm >= '22:30' || hm < '07:00';
const enabled = (env) => !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);

async function send(env, text) {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: text.slice(0, 3900), disable_web_page_preview: true }),
  });
  if (!r.ok) throw new Error(`Telegram ${r.status}`);
}
const link = (st, section) => (st.origin ? `\n\n${st.origin}/#${section}` : '');

// Messaggio importante: subito, o alle 07:00 se è notte
export async function important(env, title, text, section = 'oggi') {
  if (!enabled(env)) return;
  const st = await get(env, 'notify_state', {});
  const msg = `🏃 ${title}${text ? '\n\n' + text : ''}`;
  if (quiet(romeNow().hm)) { st.queue = [...(st.queue || []), { msg, section }].slice(-10); await put(env, 'notify_state', st); return; }
  try { await send(env, msg + link(st, section)); } catch (e) { console.error('telegram', e.message); }
}
// Alle 07:00: i messaggi rimasti in coda dalla notte
export async function flushQueue(env) {
  if (!enabled(env)) return;
  const st = await get(env, 'notify_state', {});
  if (!st.queue?.length || quiet(romeNow().hm)) return;
  for (const q of st.queue) { try { await send(env, q.msg + link(st, q.section)); } catch (e) { console.error('telegram', e.message); } }
  st.queue = []; await put(env, 'notify_state', st);
}
// Riepilogo serale (21:45): i commenti del giorno non già mandati come importanti
const DIGEST_KINDS = { activity: 'Uscita', checkin: 'Check-in', answer: 'Risposta', note: 'Nota' };
export async function digest(env) {
  if (!enabled(env)) return;
  const st = await get(env, 'notify_state', {});
  const since = st.lastDigest || Date.now() - 864e5;
  const items = (await getFeed(env)).filter((f) => f.ts > since && DIGEST_KINDS[f.kind] && !f.important && !f.superseded && !f.pending).reverse();
  st.lastDigest = Date.now();
  await put(env, 'notify_state', st);
  if (!items.length) return;
  const body = items.slice(0, 8).map((f) => `• ${DIGEST_KINDS[f.kind]}${f.source === 'claude' ? ' (coach)' : ''}: ${f.headline}${f.summary ? '\n  ' + f.summary.slice(0, 280) : ''}`).join('\n\n');
  try { await send(env, `🌙 Riepilogo di oggi\n\n${body}${link(st, 'coach')}`); } catch (e) { console.error('telegram', e.message); }
}
// L'indirizzo della dashboard serve per i link: lo si impara dalla prima richiesta della dashboard
export async function rememberOrigin(env, origin) {
  const st = await get(env, 'notify_state', {});
  if (st.origin === origin) return;
  st.origin = origin; await put(env, 'notify_state', st);
}
