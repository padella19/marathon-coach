# Marathon Coach — setup

Dashboard live per la maratona del 31/10/2027. Gira tutto su **Cloudflare Workers** (piano gratuito), con il codice su GitHub: ogni modifica caricata nel repository viene pubblicata da sola.

```
Garmin ──sync──▶ intervals.icu (gratis) ◀──ogni 15'── Worker Cloudflare ──▶ KV (dati)
Google Calendar (iCal trasferte) ──ogni mattina──────┘        │
                                                              ▼
                                          Dashboard in Chrome (si aggiorna da sola)
```

Nessun abbonamento richiesto: Cloudflare Free, GitHub Free, intervals.icu gratuito. Strava non serve (dal 2026 le sue API richiedono l'abbonamento; il codice resta compatibile se un giorno lo attivi).

---

## 1. intervals.icu (fonte delle uscite)

1. Registrati su https://intervals.icu.
2. **Settings → Connections → Garmin Connect → Connect**: autorizza. Poi "Download old data" per lo storico.
3. **Settings → Developer Settings**: genera la **API key** e copiala. In alto c'è anche il tuo **Athlete ID** (tipo `i123456`).

## 2. Secret sul Worker

Cloudflare → Workers & Pages → `marathon-coach` → **Settings → Variables and Secrets → Add**, tipo **Secret**:

| Nome | Valore |
|---|---|
| `DASH_TOKEN` | password della dashboard, lunga |
| `INTERVALS_API_KEY` | la API key di intervals.icu |
| `INTERVALS_ATHLETE_ID` | il tuo Athlete ID (opzionale ma consigliato) |
| `COACH_READ_TOKEN` | un secondo token, solo lettura, per il coach nella chat Claude |

Opzionali: `ANTHROPIC_API_KEY` (feedback AI dentro la dashboard, a consumo), `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`.

## 3. Primo accesso

1. Apri `https://marathon-coach.<account>.workers.dev`, incolla il `DASH_TOKEN`.
2. Il primo caricamento importa gli ultimi 120 giorni da intervals.icu.
3. **Impostazioni**: età, peso, FC a riposo (e FC max se la conosci). Incolla l'**indirizzo segreto iCal** del calendario trasferte (Google Calendar → impostazioni del calendario → Integra calendario → "Indirizzo segreto in formato iCal").
4. Aggiungi la dashboard ai preferiti di Chrome o installala come app dal menu.

## 4. Coach nella chat Claude

Nella chat del progetto "Maratona 2027" il coach legge lo stato da `/api/coach/export?k=COACH_READ_TOKEN` (sola lettura) e ti risponde con analisi e schede. Coperto dall'abbonamento Claude, nessuna API a pagamento.

## 5. Come si usa ogni giorno

- **Corri** col Garmin: entro 15 minuti l'uscita compare con il feedback nel feed (o subito, col tasto Sync).
- **RPE**: inseriscilo sull'orologio a fine corsa (se lo chiede), su intervals.icu, oppure nella tabella attività. Senza RPE il carico viene stimato dalla FC.
- **Check-in** (30 secondi, mattina): sonno, energia, stress, fastidi, viaggio. La sessione di oggi si ricalcola subito.
- **Trasferte**: arrivano dal calendario; puoi aggiungerle a mano. Le sessioni di quei giorni passano in versione hotel, il lungo slitta al primo giorno libero.
- **Feed coach**: feedback a regole su ogni uscita e check-in; con la chiave Anthropic anche commenti AI e proposte con bottone *Applica*.
- **Domenica sera** arriva in automatico il focus della settimana successiva.

## Opzionale: notifiche Telegram

Se vuoi il feedback anche su Telegram (es. lo stesso bot di Jarvis):

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
```

## Metriche, in breve

| KPI | Cosa misura | Valori di riferimento |
|---|---|---|
| ACWR | Carico ultimi 7 gg / ultimi 28 gg (medie esponenziali) | 0,8-1,3 ok · 1,3-1,5 attenzione · >1,5 riduci |
| Carico sessione | minuti × RPE (metodo Foster) | — |
| Forma | (cronico − acuto) / cronico | sotto −30% = molto affaticato |
| Monotonia | media / deviazione standard del carico 7 gg | >2 = troppo uguale, varia |
| Z1-Z2 28 gg | quota di tempo a bassa intensità | ≥80% in base aerobica |
| Efficienza aerobica | metri/minuto per battito nelle uscite facili | in salita = motore che migliora |
| Deriva FC | calo di efficienza tra 1ª e 2ª metà dei lunghi | <5% = buona resistenza |

L'ACWR è un indicatore utile ma non una previsione: nelle prime 3 settimane resta "in calibrazione" e conta sempre più il check-in (fastidi, sonno) del numero.

## Struttura

```
public/index.html      dashboard (HTML + CSS)
public/app.js          logica UI, polling live, grafici Chart.js
public/lib/engine.js   motore condiviso: metriche, piano, adattamento, nutrizione
src/index.js           Worker: routing, OAuth, webhook, API, cron
src/intervals.js       connettore intervals.icu (fonte principale)
src/strava.js          connettore Strava (alternativo, richiede abbonamento)
src/sync.js            sincronizzazione attività
src/coach.js           Coach Live Feedback (regole + Claude)
src/trips.js           trasferte da iCal
```

Endpoint principali (tutti con `Authorization: Bearer DASH_TOKEN`): `GET /api/state`, `POST /api/sync`, `POST /api/checkin`, `POST /api/override`, `POST /api/trips`, `POST /api/coach/ask`, `POST /api/coach/weekly`, `POST /api/plan`.

Per provarla senza backend: apri `index.html` servito da qualunque server statico con `?demo`.
