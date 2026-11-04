// Accesso a Cloudflare KV (un solo utente → chiavi singole JSON)
import { DEFAULT_SETTINGS } from '../public/lib/engine.js';

export async function get(env, key, fallback = null) {
  const v = await env.KV.get(key, 'json');
  return v ?? fallback;
}
export async function put(env, key, value) {
  await env.KV.put(key, JSON.stringify(value));
}
export async function getSettings(env) {
  return { ...DEFAULT_SETTINGS, ...(await get(env, 'settings', {})) };
}
export async function pushFeed(env, item) {
  const feed = await get(env, 'feed', []);
  const entry = { id: crypto.randomUUID(), ts: Date.now(), ...item };
  feed.unshift(entry);
  await put(env, 'feed', feed.slice(0, 80));
  return entry;
}
