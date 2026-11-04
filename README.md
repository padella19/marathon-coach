# Marathon Coach — setup

Dashboard live per la maratona del 31/10/2027. Gira tutto su **Cloudflare Workers** (piano gratuito): il Worker serve la dashboard, riceve le uscite da Strava in tempo reale, calcola il carico e chiede a Claude il feedback.

```
Garmin ──sync──▶ Strava ──webhook──▶ Worker Cloudflare ──▶ Claude (feedback)
                                         │  KV (dati)
Google Calendar (iCal trasferte) ──cron──┘
                                         ▼
                         Dashboard in Chrome (polling live)
```

Tempo di setup: circa 30 minuti, una volta sola.

---

## 0. Cosa ti serve

- **Node.js LTS** sul PC (nodejs.org). Su Windows i comandi sotto vanno in PowerShell.
- Garmin Connect già collegato a Strava (Garmin Connect → Impostazioni → App di terze parti → Strava).
- Un account **Cloudflare** gratuito (dash.cloudflare.com).

## 1. App Strava

1. Vai su https://www.strava.com/settings/api e crea un'app.
2. **Authorization Callback Domain**: metti `workers.dev` per ora (lo affini al punto 4).
3. Segnati **Client ID** e **Client Secret**.

## 2. Chiave Anthropic (coach AI)

1. https://console.anthropic.com → API Keys → crea una chiave.
2. Carica un po' di credito e imposta un **limite di spesa mensile** (Settings → Limits). Ogni analisi è una chiamata breve: il consumo è basso, ma il limite ti tutela.

Senza chiave la dashboard funziona lo stesso col motore a regole (adattamento, ACWR, feedback base).

## 3. Deploy del Worker

Dalla cartella del progetto:

```bash
npm install
npx wrangler login                       # apre il browser, autorizzi Cloudflare
npx wrangler kv namespace create KV      # copia l'id che stampa
```

Apri `wrangler.toml` e sostituisci `INCOLLA_QUI_ID_KV` con quell'id. Poi i secret (ognuno ti chiede il valore):

```bash
npx wrangler secret put STRAVA_CLIENT_ID
npx wrangler secret put STRAVA_CLIENT_SECRET
npx wrangler secret put STRAVA_VERIFY_TOKEN     # una parola a caso, es. pista-2027
npx wrangler secret put DASH_TOKEN              # la "password" della dashboard, lunga
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler deploy
```

Il deploy stampa l'URL, tipo `https://marathon-coach.<tuo-account>.workers.dev`.

## 4. Collega tutto

1. Su Strava (settings/api) metti come **Authorization Callback Domain** il dominio esatto: `marathon-coach.<tuo-account>.workers.dev`.
2. Apri l'URL in Chrome, incolla il `DASH_TOKEN`.
3. Clicca **Collega Strava** e lascia spuntato l'accesso alle attività. Il Worker importa gli ultimi 120 giorni e attiva il webhook da solo.
4. **Impostazioni**: età, peso, FC a riposo (e FC max se la conosci) per tarare le zone. Incolla l'**indirizzo segreto iCal** del calendario delle trasferte (Google Calendar → impostazioni del calendario → Integra calendario → "Indirizzo segreto in formato iCal"). Puoi metterne più di uno, uno per riga.
5. Aggiungi la dashboard ai preferiti di Chrome (o "Installa app" dal menu per averla come finestra a sé).

## 5. Come si usa ogni giorno

- **Corri** col Garmin: in 1-2 minuti l'uscita compare, con analisi del coach nel feed.
- **RPE**: compila "Fatica percepita" su Strava, oppure scrivi `RPE 6` nella descrizione, oppure sceglilo nella tabella attività. Senza RPE il carico viene stimato dalla FC.
- **Check-in** (30 secondi, mattina): sonno, energia, stress, fastidi, viaggio. La sessione di oggi si ricalcola subito.
- **Trasferte**: arrivano dal calendario; puoi aggiungerle a mano. Le sessioni di quei giorni passano in versione hotel, il lungo slitta al primo giorno libero.
- **Feed coach**: le proposte di modifica hanno il bottone *Applica*. Puoi anche fare domande libere.
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
src/strava.js          connettore Strava
src/sync.js            sincronizzazione attività
src/coach.js           Coach Live Feedback (regole + Claude)
src/trips.js           trasferte da iCal
```

Endpoint principali (tutti con `Authorization: Bearer DASH_TOKEN`): `GET /api/state`, `POST /api/sync`, `POST /api/checkin`, `POST /api/override`, `POST /api/trips`, `POST /api/coach/ask`, `POST /api/coach/weekly`, `POST /api/plan`.

Per provarla senza backend: apri `index.html` servito da qualunque server statico con `?demo`.
