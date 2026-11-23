# Marathon Coach — setup

Dashboard live per la maratona del 31/10/2027. Gira tutto su **Cloudflare Workers** (piano gratuito): il Worker serve la dashboard, legge le uscite da Intervals.icu ogni 10 minuti, calcola il carico e chiede a Claude il feedback.

```
Garmin ──sync──▶ Intervals.icu ◀──ogni 10 min── Worker Cloudflare ──▶ Claude (feedback)
                                                    │  KV (dati)
Google Calendar (iCal trasferte) ──cron giornaliero─┘
                                                    ▼
                                    Dashboard in Chrome (polling live)
```

Tempo di setup: circa 20 minuti, una volta sola.

---

## 0. Cosa ti serve

- **Node.js LTS** sul PC (nodejs.org). Su Windows i comandi sotto vanno in PowerShell.
- Garmin Connect collegato **direttamente** a Intervals.icu (Intervals.icu → Settings → Garmin). Le uscite che arrivano a Intervals passando da Strava non sono leggibili via API.
- Un account **Cloudflare** gratuito (dash.cloudflare.com).

## 1. API key di Intervals.icu

1. Vai su https://intervals.icu/settings e scorri fino a **Developer Settings**.
2. Crea (o copia) la **API key**: è il secret `INTERVALS_API_KEY` del punto 3.
3. L'ID atleta (tipo `i123456`, è nella stessa sezione) è facoltativo: se non lo imposti vale l'atleta della chiave.

## 2. Il coach: Claude col tuo abbonamento (niente API a pagamento)

Il coach vero è Claude, collegato alla dashboard con un **connettore** che il Worker espone a un indirizzo segreto. Due **attività programmate** in Claude (mattina e sera) fanno tutto da sole: commentano uscite e check-in, rispondono alle domande, preparano i check-up e ricalibrano il piano. I feedback istantanei dopo ogni corsa li dà il motore a regole, gratis.

Ti serve solo inventare un segreto lungo (almeno 40 caratteri a caso, es. da un generatore di password): è il secret `MCP_SECRET` del punto 3.

> Facoltativo: se un giorno vuoi anche il coach via API a pagamento, aggiungi `ANTHROPIC_API_KEY` (console.anthropic.com, con un limite di spesa mensile). Non serve per il connettore.

## 3. Deploy del Worker

Dalla cartella del progetto:

```bash
npm install
npx wrangler login                       # apre il browser, autorizzi Cloudflare
npx wrangler kv namespace create KV      # copia l'id che stampa
```

Apri `wrangler.toml` e sostituisci `INCOLLA_QUI_ID_KV` con quell'id. Poi i secret (ognuno ti chiede il valore):

```bash
npx wrangler secret put INTERVALS_API_KEY       # la API key del punto 1
npx wrangler secret put DASH_TOKEN              # la "password" della dashboard, lunga
npx wrangler secret put MCP_SECRET              # il segreto del connettore (punto 2)
npx wrangler deploy
```

Il deploy stampa l'URL, tipo `https://marathon-coach.<tuo-account>.workers.dev`.

## 4. Collega tutto

1. Apri l'URL in Chrome, incolla il `DASH_TOKEN`.
2. Clicca **Sync** (o aspetta al massimo 10 minuti): il Worker importa gli ultimi 120 giorni da Intervals.icu. In **Impostazioni → Collegamenti** c'è **Verifica collegamento** se qualcosa non torna.
3. **Impostazioni**: età, peso, FC a riposo (e FC max se la conosci) per tarare le zone. Incolla l'**indirizzo segreto iCal** del calendario delle trasferte (Google Calendar → impostazioni del calendario → Integra calendario → "Indirizzo segreto in formato iCal"). Puoi metterne fino a 5, uno per riga.
4. **Profilo atleta**: al primo accesso la dashboard te lo propone (4 schermate). Si modifica da Impostazioni → Profilo e coach.
5. **Workout sul Garmin**: su intervals.icu → Settings → Garmin attiva **"Upload planned workouts"**. Da lì i prossimi 14 giorni del piano arrivano sul Fenix come workout guidati (target di FC con le zone di intervals.icu). Gli esercizi di forza arrivano come promemoria con l'elenco esercizi.
6. **Connettore in Claude**: Impostazioni → Connettori → Aggiungi connettore personalizzato → nome "Marathon Coach", URL `https://marathon-coach.<tuo-account>.workers.dev/mcp` con header `Authorization: Bearer <MCP_SECRET>`. Se la schermata del connettore non ti lascia impostare un header, usa ancora il vecchio indirizzo `…/mcp/<MCP_SECRET>` (vedi "José" più sotto). Poi crea in Claude due attività programmate, mattina (07:00) e sera (21:00), con il testo: *"Chiama coach_get_briefing del connettore Marathon coach e segui il protocollo."*
7. Aggiungi la dashboard ai preferiti di Chrome (o "Installa app" dal menu per averla come finestra a sé; su iPhone: Condividi → Aggiungi alla schermata Home).

## 5. Come si usa ogni giorno

- **Corri** col Garmin: entro una decina di minuti dal salvataggio l'uscita compare, con analisi del coach nel feed. Con **Sync** la scarichi subito.
- **RPE**: compilalo su Intervals.icu, oppure scrivi `RPE 6` nella descrizione, oppure sceglilo nella tabella attività. Senza RPE il carico viene stimato dalla FC.
- **Check-in** (4 tocchi): energia, gambe, fastidio (zona e intensità), giornata. Niente sonno. La sessione di oggi si ricalcola subito.
- **Trasferte**: arrivano dal calendario; puoi aggiungerle a mano. Le sessioni di quei giorni passano in versione hotel, il lungo slitta al primo giorno libero.
- **Feed coach**: le proposte di modifica hanno il bottone *Applica*. Puoi anche fare domande libere.
- **Domenica sera** arriva in automatico il focus della settimana successiva.

## Opzionale: notifiche Telegram

Subito solo le cose importanti (domande del check-up, piano ricalibrato, avvisi su fastidi o carico, focus della domenica); alle 21:45 un riepilogo dei commenti del giorno. Niente messaggi tra le 22:30 e le 07:00. Ogni messaggio ha il link alla dashboard.

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
public/lib/jose.js     José: segnali, badge, test e previsione, "Non riesco", scarpe, meteo
src/jose.js            José lato Worker: chat, meteo, report, test, scarpe, note vocali, area gara
src/index.js           Worker: routing, API, cron
src/intervals.js       connettore Intervals.icu
src/sync.js            sincronizzazione attività
src/store.js           accesso a KV (feed e check-in a chiavi singole)
src/coach.js           Coach Live Feedback (regole + Claude)
src/trips.js           trasferte da iCal
```

Endpoint principali (tutti con `Authorization: Bearer DASH_TOKEN`): `GET /api/state`, `POST /api/sync`, `POST /api/checkin`, `POST /api/override`, `POST /api/trips`, `POST /api/coach/ask`, `POST /api/coach/weekly`, `POST /api/plan`, `POST /api/intervals/test`, `POST /api/intervals/backfill`.

Per provarla senza backend: apri `index.html` servito da qualunque server statico con `?demo`.

## Novità (blocco 2)

- **Grafica "Pista rifinita"**: tema automatico (segue iPhone/PC), si può forzare chiaro o scuro in Impostazioni → Aspetto.
- **Esercizi in camera**: se registri sul Garmin un'attività "Forza" (o Yoga per la mobilità) si segna da sola; altrimenti tocca **Fatto** sulla sessione. Nel carico la forza pesa la metà della corsa, la mobilità un quarto.
- **Corsa senza orologio**: nel dettaglio del giorno, "Aggiungi corsa a mano" (la crea anche su intervals.icu).
- **Mi fermo**: in fondo alla card di oggi. I giorni di pausa non contano come saltati; "Riprendo" quando torni.
- **Trasferte**: due giorni prima la dashboard ti chiede cosa trovi (solo camera, tapis roulant, parco). Le **vacanze** (tipo "Vacanza" nel form, o eventi del calendario con "ferie/vacanza" nel titolo) non attivano la versione hotel.

## Novità (blocco 3): il coach che ti conosce

- **Connettore per Claude** (`/mcp/<MCP_SECRET>`): 5 strumenti (`coach_get_briefing`, `coach_post_feedback`, `coach_ask_questions`, `coach_apply_plan`, `coach_update_memory`). Il briefing contiene il **protocollo** che le attività programmate seguono: il comportamento del coach si aggiorna dal codice, non dal prompt.
- **Check-up** ogni 8 allenamenti, a ogni cambio di fase, al rientro da una pausa o prima se arrivano segnali (fastidio ricorrente, 2 sessioni saltate, ACWR > 1,3 o readiness < 50 per 3 giorni). Le domande compaiono in **Oggi**; al giro successivo (o dopo 72 ore senza risposta) il coach ricalibra le prossime 4 settimane. **Annulla** per 7 giorni.
- **Limiti di sicurezza nel codice** (`validatePlan` in `public/lib/engine.js`, con test): volume +12% al massimo, lungo +10', max 2 qualità non consecutive, 1 riposo, niente aumenti con fastidio ≥5, niente lunghi in trasferta, scarico finale solo in riduzione, dopo una pausa ≥7 giorni volume al 70% per 2 settimane, corse a settimana +1 al massimo per check-up.
- **Memoria**: fino a 30 note che il coach scrive su di te (le vedi e le cancelli in Impostazioni). Sotto ogni commento: **Utile / Non mi torna**.
- **Domande libere** senza API: restano in coda e il coach risponde al giro successivo.
- **Corse a settimana**: le decide il coach (parte da 3).
- **Garmin**: i workout dei prossimi 14 giorni vengono riscritti su intervals.icu a ogni cambio (check-up, modifica, check-in, pausa) e ogni mattina. Se la sessione di oggi cambia dopo l'invio, la card di oggi ti dice di sincronizzare Garmin Connect.
- **Cron unico** ogni 10 minuti: i lavori a orario seguono l'ora di Roma (anche con l'ora legale).
- `npm test`: 28 test su motore, limiti di sicurezza e check-up.

Nota: gli endpoint di intervals.icu per calendario e attività manuali (`events/bulk`, `events`, `activities/manual`) e la sintassi testuale dei workout sono scritti secondo la documentazione pubblica e provati contro un finto server locale: alla prima esecuzione reale controlla in Impostazioni che l'invio risulti riuscito e che i workout compaiano su intervals.icu.

## Novità (blocco 4): José

Il coach ha un nome e un carattere: **José**, tono da sergente. Pensa solo quando gira Claude (le due attività programmate): tutto ciò che è immediato lo fa il Worker a regole, José commenta e decide al giro dopo (al massimo 12 ore).

- **Chat** (sezione José, su PC nella colonna a destra): scrivi quando vuoi, José risponde al giro successivo. Sotto il campo c'è scritto entro quando. Con il microfono mandi una **nota vocale** (trascritta da Workers AI Whisper: serve il blocco `[ai]` in `wrangler.toml`).
- **Messaggi spontanei**: il Worker calcola i `segnali` (nessun check-in da 3 giorni, sessione saltata, facile corso troppo forte, volume oltre il piano, fastidio ≥5 due volte, trasferta con dotazioni ignote, meteo avverso, badge, scarpe, test da pianificare); José ne sceglie al massimo uno per giro (il limite è nel codice).
- **Voto 👍/👎 con nota** su commenti, messaggi e report: José li legge in `valutazioni_recenti`.
- **Commento alle uscite**: 2-3 righe, più "Approfondisci" con l'analisi completa (campo `dettaglio`).
- **"Non riesco"** sulla sessione: due opzioni valide subito (spostare o accorciare) più "la salto".
- **Luoghi**: le dotazioni dell'hotel si salvano per città e valgono per le trasferte successive. Solo camera → forza e mobilità; tapis roulant → la qualità si può fare.
- **Meteo** (Open-Meteo, senza chiave) nella tua fascia oraria, nella città del giorno. Città di casa, ora di corsa e soglia del freddo sono in Impostazioni → Meteo e orari.
- **Report del lunedì**, **test ogni 6-8 settimane con previsione maratona** (Riegel, con forchetta), **badge**, **scarpe** (avviso a 600 km): in Progressi e in José → Report.
- **Area gara**: conto alla rovescia, piano di passo, ristori, checklist valigia, logistica (solo quello che scrivi tu).
- **Stato di José** in alto: "attivo · ultima visita stamattina 07:02". Se non si fa vivo da più di 36 ore compare un avviso.
- **Sicurezza del connettore**: il token va nell'header `Authorization: Bearer <MCP_SECRET>` su `/mcp`. Il vecchio `/mcp/<MCP_SECRET>` resta valido in transizione; per spegnerlo aggiungi `MCP_PATH_AUTH = "off"` sotto `[vars]`.
- Nuovi strumenti MCP: `coach_send_message`, `coach_update_profile`, `coach_post_weekly_report`, `coach_set_place_amenities`. `coach_post_feedback` accetta `dettaglio`.
- `npm test`: 43 test.

Da controllare al primo uso reale (qui non erano raggiungibili): la risposta di Open-Meteo e la trascrizione Whisper con l'audio registrato dall'iPhone.
