# Brief — Marathon Coach: fix + redesign della dashboard

> **Aggiornamento:** Strava è stato sostituito da Intervals.icu (API key, controllo ogni 10 minuti). Il fix 2 resta valido per il token nell'header e il confronto a tempo costante; il link monouso per l'OAuth di Strava non esiste più.

> Da leggere per primo. Lavora in due fasi separate: **prima i fix (Fase 1), poi il redesign (Fase 2)**. Un commit per ogni punto. Non toccare la logica del motore (`public/lib/engine.js`) salvo dove indicato. Lingua dell'interfaccia: italiano.

Contesto: dashboard personale per preparare la maratona del **31/10/2027** (inizio preparazione 10/12/2026, da zero). Un solo utente, Luca. La userà soprattutto da **iPhone** (al mattino per il check-in, dopo la corsa per vedere il feedback) e da PC Windows con Chrome. Stack: Cloudflare Worker + KV, front-end HTML/JS vanilla senza build, Chart.js da CDN. **Resta senza build step e senza framework.**

---

## FASE 1 — Fix (in ordine di priorità)

### 1. Il polling cancella quello che stai scrivendo — `public/app.js`, `refresh()` (riga ~620)
Ogni 60 s (4 s in "burst") `refresh()` chiama `render()`, che riscrive tutto `#app` con `innerHTML`. Effetti: testo perso nel campo "Chiedi al coach" e nel form trasferte, `<select>` RPE che si chiude mentre lo apri, grafici distrutti e ridisegnati, focus perso.
**Fix:**
- Se i dati non sono cambiati, non renderizzare. Calcola una firma leggera (es. `feed[0].id + activities.length + meta.lastSync + hash di overrides/checkins/trips`) e salta `render()` se è uguale; aggiorna solo l'indicatore live.
- Se è cambiato qualcosa ma c'è un elemento con il focus dentro `#app` (`document.activeElement` è input/select/textarea), rimanda il render a quando perde il focus (`focusout`).
- Ridisegna i grafici solo se cambiano i dati che usano (attività/piano/impostazioni), non a ogni render.

### 2. Il token della dashboard finisce nell'URL — `app.js` righe ~177 e ~538, `src/index.js` `authed()`
Il link "Collega Strava" è `/auth/strava?k=<DASH_TOKEN>`: il token resta nella cronologia di Chrome/Safari e nei log. 
**Fix:** nuovo endpoint `POST /api/auth/strava-link` (autenticato con header Bearer) che genera un codice monouso (UUID, salvato in KV con `expirationTtl: 120`) e restituisce l'URL `/auth/strava?c=<codice>`. `/auth/strava` accetta solo il codice, lo cancella e procede. In `authed()` togli il fallback `url.searchParams.get('k')`. I pulsanti "Collega/Ricollega Strava" diventano `button` che chiamano l'endpoint e poi fanno `location.href = url`.
Già che ci sei: confronto del token a tempo costante (confronta gli hash SHA-256 con `crypto.subtle.digest`, poi byte per byte).

### 3. Un errore del backend mostra la demo come se fosse vera — `app.js` `boot()` (riga ~662)
Qualsiasi errore diverso da 401 (es. 500 del Worker) fa partire `startDemo()`: Luca vede dati finti credendoli suoi.
**Fix:** se c'è un token salvato e la chiamata fallisce, mostra una schermata di errore chiara ("Backend non raggiungibile" / messaggio dell'errore) con pulsanti **Riprova** e **Guarda la demo**. La demo parte solo se richiesta o con `?demo`.

### 4. `meta` sovrascritto dopo l'OAuth — `src/index.js` riga ~83
`put(env, 'meta', { subscription, lastSync })` cancella gli altri campi di `meta`. **Fix:** leggi `meta`, fai merge, salva.

### 5. "Applica" ignora l'azione `move` — `app.js` `bindActions()`, ramo `apply` (riga ~586)
Lo schema del coach prevede `move`, ma il codice lo tratta come una modifica sul posto. **Fix:** per `move` serve una data di destinazione: aggiungi `to_date` a `FEEDBACK_SCHEMA` e `WEEKLY_SCHEMA` in `src/coach.js` (validata contro le date di `next7` in `sanitizeFeedback`), poi in "Applica" metti la sessione in `to_date` e un riposo nella data originale (due override). Se `to_date` manca, il pulsante mostra "Apri giornata" e apre `dayDlg(date)`.

### 6. Scritture concorrenti su KV perdono dati — `src/store.js` `pushFeed()`, `api()` check-in/override
Webhook Strava e check-in possono girare insieme: entrambi leggono `feed`, aggiungono, riscrivono → uno dei due si perde. **Fix minimo (senza Durable Objects):** salva ogni elemento del feed in una chiave propria `feed:<ts>-<uuid>` e in `state()` leggi con `KV.list({ prefix: 'feed:' })` le ultime 80 (ordina per nome in ordine inverso). Stessa idea per i check-in (`checkin:<data>`). Scrivi una migrazione che al primo avvio sposta il vecchio array nelle nuove chiavi.

### 7. `/api/settings` accetta qualsiasi campo — `src/index.js` riga ~141
**Fix:** whitelist dei campi (`age, weightKg, hrMax, hrRest, longRunDay, raceName, icalUrls`) con validazione di tipo e intervallo (stessi min/max dei campi del form). Gli URL iCal: solo `https://`, massimo 5.

### 8. Manca il manifest per installarla come app
Il README dice "Installa app", ma in `public/` non ci sono `manifest.webmanifest` né icone. **Fix:** aggiungi manifest (`display: standalone`, `theme_color`/`background_color` coerenti col nuovo tema, `start_url: "/"`), icone 192/512 + `apple-touch-icon` 180 (SVG → PNG, soggetto: corsia di pista stilizzata con "42" — niente loghi di terzi), meta `apple-mobile-web-app-capable` e `apple-mobile-web-app-status-bar-style`. Niente service worker per ora (i dati devono essere sempre freschi).

**Verifica Fase 1:** `npx wrangler dev`, apri `/?demo` e la versione live; scrivi nel campo "Chiedi al coach" e aspetta 2 cicli di polling (forza `burst()` dalla console): il testo deve restare. Controlla che `/auth/strava?k=...` ora risponda 401.

---

## FASE 2 — Redesign: "Night Track"

### Obiettivo
Oggi la dashboard è corretta ma sembra un pannello di controllo: tutto ha lo stesso peso, la pagina è lunghissima e su iPhone la settimana scorre in orizzontale. Deve diventare **la cosa che Luca ha voglia di aprire ogni mattina**: in 3 secondi capisce cosa fare oggi, quanto manca alla gara e se sta andando bene.

### Direzione visiva
Mantieni l'idea della pista d'atletica, ma portala al livello successivo:
- **Tema scuro come predefinito** ("pista di notte sotto i riflettori"), chiaro disponibile. Aggiungi un interruttore tema nella barra in alto (salva la scelta in `localStorage`, l'attributo `data-theme` è già gestito in CSS).
- Palette scura: fondo `#0b0f14`, superfici `#121820` / `#18202a`, linee `#232d38`, testo `#eef2f6` / `#a7b3bf` / `#6f7c89`. Accento **rosso tartan** `#ff5a3c` (unico colore "caldo" forte, usato con parsimonia: sessione di oggi, CTA principale, dati eseguiti). Secondario **blu corsia** `#5aa9e6` per il pianificato. Stati: verde `#3ddc97`, ambra `#ffb547`, rosso `#ff4d6d`. Zone FC: mantieni la scala esistente, ricalibrata sul fondo scuro.
- Tipografia: tieni Barlow Condensed per titoli e numeri grandi, IBM Plex Sans per il testo, IBM Plex Mono per i dati. I numeri chiave (km, minuti, readiness, countdown) in stile **pettorale**: grandi, condensati, cifre tabulari.
- Dettaglio firma: **linee di corsia** sottili (2 px, a coppie) come divisori di sezione e una texture tartan quasi invisibile (rumore SVG all'1-2% di opacità) solo nella card "Oggi". Niente gradienti viola, niente glassmorphism, niente emoji nell'interfaccia.
- Bordi: raggio 14 px sulle card, 10 px sui controlli. Ombre quasi assenti nel tema scuro: la profondità la danno i livelli di superficie.

### Nuova struttura (navigazione a sezioni)
Niente più pagina infinita. Quattro sezioni:
1. **Oggi** (predefinita)
2. **Settimana**
3. **Analisi** (KPI + grafici + tabella attività)
4. **Coach** (feed + domanda libera)
5. *(dentro "Altro" o in fondo a Coach)* **Libreria**: forza in camera, integrazione e scarico

- **iPhone (< 760 px):** barra di navigazione in basso fissa con 4 icone + etichetta (rispetta `safe-area-inset-bottom`), pulsante Check-in come azione principale nella sezione Oggi.
- **Desktop (≥ 1100 px):** layout a due colonne: a sinistra la sezione attiva, a destra una colonna fissa con il feed del coach sempre visibile. Navigazione a tab nella barra in alto.
- La sezione attiva sta nell'hash dell'URL (`#oggi`, `#settimana`, `#analisi`, `#coach`) così il tasto indietro funziona.
- Il render deve produrre solo la sezione attiva (aiuta anche il fix 1).

### Sezione "Oggi" — il cuore
Dall'alto:
1. **Testata gara**: "Maratona · 31.10.2027" + **countdown a pettorale** (giorni rimanenti, numero enorme) + **barra di avanzamento della preparazione** divisa nelle fasi del piano (`phaseAt`/fasi dell'engine) con un marcatore "sei qui" e la settimana corrente ("sett. 12/47 · Base aerobica"). Prima del 10/12/2026: countdown all'inizio della preparazione.
2. **Card sessione di oggi** (la più grande della pagina): tipo, titolo grande, durata, km stimati, RPE, fascia FC in bpm, descrizione, chip "Adattata"/"Trasferta". A destra (sotto, su iPhone) l'**anello Readiness** più grande e animato all'apertura (0 → valore in 600 ms, rispetta `prefers-reduced-motion`). Se manca il check-in: CTA rossa "Check-in · 30 secondi".
3. **Cosa mangiare** (prima/durante/dopo) come tre pillole compatte e apribili, non come testo lungo.
4. **Striscia dei prossimi 7 giorni**: 7 mini-card orizzontali (giorno, colore per tipo di sessione, durata, icona valigia se trasferta). Tocco → apre il dettaglio del giorno.
5. **3 KPI essenziali** con mini-sparkline: Volume settimana (eseguito / piano, con barra di avanzamento), ACWR (con fascia colorata), Z1-Z2 28 gg. Gli altri KPI vanno in Analisi.
6. **Ultimo feedback del coach** (solo il più recente, con "Applica" se ci sono proposte) + link "Vedi tutto".

### Sezione "Settimana"
- Su iPhone: **lista verticale** dei 7 giorni (niente scroll orizzontale). Ogni riga: giorno + data a sinistra, barra colorata per tipo, titolo e durata pianificati, sotto l'eseguito (km · passo · FC) e lo stato (Fatta / Parziale / Saltata / Extra) come chip. Oggi evidenziato con bordo rosso.
- Su desktop: la griglia a 7 colonne attuale, rifinita.
- In cima: riepilogo della settimana (km eseguiti/pianificati, sessioni fatte/totali, minuti in Z1-Z2) e frecce per vedere la settimana precedente/successiva (serve `weekView` con lunedì diverso: è già parametrizzato).
- Le trasferte (striscia 14 giorni + form) si spostano qui, in un blocco richiudibile.

### Sezione "Analisi"
- Griglia di 8 KPI con sparkline delle ultime 8 settimane dove ha senso.
- Grafici: stesso contenuto, nuovo stile coerente → nessuna griglia verticale, griglia orizzontale tenue, etichette in mono, tooltip scuri custom, barre arrotondate, colori dalle variabili CSS (rileggile al cambio tema, già fatto). Abilita animazioni leggere solo al primo disegno. Selettore periodo **4 sett. / 12 sett. / Tutto** in alto che filtra tutti i grafici.
- Tabella attività: su iPhone diventa una lista di card (data, nome, km, passo, FC, barra zone, RPE modificabile); su desktop resta tabella.

### Sezione "Coach"
- Feed in stile timeline: icona per tipo (uscita, check-in, focus, risposta), verdetto come bordo colorato a sinistra, KPI come chip, proposte di modifica con pulsante "Applica" ben visibile e stato "Applicato".
- Campo domanda fisso in basso (sopra la nav su iPhone), con 3 suggerimenti rapidi cliccabili: "Domani sono in trasferta, cosa faccio?", "Come sto andando questo mese?", "Ho un fastidio al polpaccio".
- Il focus della settimana sta in cima a questa sezione come card ripiegabile.

### Micro-interazioni (sobrie)
- Nuovo feedback in arrivo: toast in alto + pallino rosso sull'icona Coach della nav.
- Indicatore "Live": pallino verde che pulsa piano ogni volta che arriva un aggiornamento.
- Transizioni tra sezioni: fade + slide di 8 px, 180 ms. Tutto disattivato con `prefers-reduced-motion`.
- Stati vuoti curati (prima uscita, nessun check-in, nessuna trasferta) con una riga di testo utile, non "Nessun dato".
- Skeleton al caricamento invece di "Carico la dashboard…".

### Accessibilità e qualità
- Contrasto AA in entrambi i temi (verifica in particolare il testo `--ink-3` e i chip).
- Target touch ≥ 44 px su iPhone; nav e pulsanti raggiungibili col pollice.
- Navigazione da tastiera nei tab e nel dialog; `aria-current` sulla sezione attiva.
- Nessun overflow orizzontale a 375 px di larghezza.

### Vincoli
- Niente framework, niente build. Puoi dividere il CSS in `public/styles.css` e le sezioni in moduli (`public/ui/today.js`, `week.js`, `analysis.js`, `coach.js`), importati da `app.js`.
- La **modalità demo** (`?demo`) deve continuare a funzionare e mostrare tutte le sezioni: è il modo per controllare il risultato.
- Non cambiare le API del Worker per il redesign (salvo i fix della Fase 1).

### Verifica Fase 2
Apri `/?demo` e fai screenshot a **390×844** (iPhone) e **1440×900** (desktop), tema chiaro e scuro, per ognuna delle 4 sezioni. Controlla: niente scroll orizzontale, numeri allineati, contrasto leggibile, anello e countdown corretti. Correggi quello che non convince prima di dichiarare finito.
