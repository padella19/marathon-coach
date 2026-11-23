# Brief per Fable — Marathon Coach diventa "José"

Obiettivo: trasformare la dashboard Marathon Coach (Cloudflare Worker + intervals.icu + connettore MCP usato da Claude dell'abbonamento, nessuna API a pagamento) in un vero rapporto allenatore–atleta. Il coach si chiama **José**.

Contesto fisso: Luca, area manager con molte trasferte (camera d'hotel), soffre il freddo, Garmin collegato a intervals.icu, non dorme col Garmin. Gara: Maratona di Francoforte 31/10/2027, obiettivo **finirla**. Piano dal 10/12/2026. La mezza di Fuerteventura di dicembre **si salta** (resta solo vacanza dal 23/12).

Vincolo architetturale: José "pensa" solo quando Claude gira, cioè con due attività programmate al giorno (mattina e sera) che chiamano `coach_get_briefing` e seguono il `protocollo`. Tutto ciò che deve essere immediato (avvisi, badge, calcoli) lo fa il Worker a regole; José commenta e decide alla run successiva. Tempo di risposta massimo accettato: 12 ore.

---

## PRIORITÀ 1 — Il rapporto (da fare per primo)

### 1.1 Personalità di José
- Tono da **sergente**: diretto, esigente, ti spinge, **sgrida** quando serve (sessioni saltate senza motivo, uscite facili corse troppo forte, check-in mancati, volume aumentato di testa propria).
- Non sgrida mai su dolore, malattia o stanchezza reale: in quei casi resta il protocollo di sicurezza (dolore che altera l'appoggio, che peggiora correndo o dura oltre 48-72 h → stop e medico/fisio).
- Italiano, frasi brevi, numeri concreti, zero complimenti di circostanza. Riconosce i meriti veri, in modo asciutto.
- Aggiornare il campo `protocollo` del briefing con persona, nome e regole di tono.
- Nome "José" in tutta la UI. Niente faccia/avatar: al massimo un monogramma "J" sobrio, nello stile pista d'atletica.

### 1.2 Chat con José in dashboard
- Sezione chat: Luca scrive quando vuole, José risponde alla run successiva.
- Mostrare "José risponde entro stamattina/stasera" in base alla prossima run programmata.
- Nuovi tool MCP:
  - nel briefing: `chat_in_attesa` (messaggi di Luca non ancora risposti) e `chat_recente` (ultimi 20 scambi per contesto);
  - `coach_send_message({text, reply_to?, kind: "reply" | "spontaneous" | "scolding" | "praise"})`.
- Lo storico chat è anche memoria: José ci pesca informazioni e le promuove in `memory.add` quando sono durature.

### 1.3 Messaggi spontanei
- Il Worker calcola dei **trigger** e li passa nel briefing (`segnali`); José decide se scrivere. Esempi:
  - nessun check-in da 3 giorni;
  - sessione pianificata non fatta;
  - uscita facile con FC media sopra Z2 per più del 20% del tempo;
  - volume settimanale oltre il piano;
  - fastidio ≥5 in due check-in di fila;
  - trasferta domani con dotazioni hotel ignote (vedi 2.2);
  - meteo avverso domani (vedi 2.3);
  - badge sbloccato (vedi 3.3).
- Al massimo 1 messaggio spontaneo per run, così non diventa spam.

### 1.4 Voto ai feedback
- Su ogni commento/messaggio di José: 👍 / 👎 più una nota facoltativa.
- Nel briefing: `valutazioni_recenti`. Il protocollo dice a José di adattare stile e contenuti e di salvare in memoria cosa funziona ("preferisce X", "non gli serve Y").

### 1.5 Profilo e onboarding gestiti da José
Le 4 schermate di "Compila il profilo" vanno rifatte attorno a quello che José deve sapere:
- storia sportiva (corsa, palestra, altri sport, gare fatte);
- infortuni passati e punti deboli da monitorare (José li cita nei check-in quando è il caso);
- cosa lo motiva e cosa lo fa mollare;
- giorni e orari preferiti per correre, giorno del lungo, giorni impossibili;
- contesto di vita: settimane tipo, carico di lavoro, frequenza trasferte;
- obiettivo: finire la maratona (campo modificabile in futuro).

Il profilo diventa poi conversazionale: José può fare domande di approfondimento via chat o via `coach_ask_questions`, e aggiornare il profilo con un nuovo tool `coach_update_profile`.

### 1.6 Check-in più corto
- Togliere il **sonno**.
- Nuovo check-in in 3-4 tap, abbastanza per tarare l'allenamento:
  1. Energia 1-5
  2. Gambe (indolenzimento) 1-5
  3. Dolore/fastidio: no / sì → zona (lista) + intensità 1-10
  4. Giornata (stress/lavoro): leggera / normale / pesante
- Ricalibrare readiness e motore a regole su questi campi.

### 1.7 Commento alle uscite
- Default: **2-3 righe** (verdetto + 1 numero chiave + cosa cambia).
- Pulsante "Approfondisci" che apre l'analisi completa: passo, FC, zone, deriva cardiaca, confronto col pianificato. José la scrive subito in un campo `dettaglio`, così non serve una run in più.
- Niente questionario post-uscita.

### 1.8 Home e pulizia veloce
- Ordine della home: **sessione di oggi → messaggi di José → settimana → progressi verso la gara**. Readiness compatta dentro la card di oggi.
- Layout responsive vero, iPhone e PC con la stessa priorità.
- **Banner "Coach AI spento"**: eliminarlo. A ogni chiamata MCP salvare `last_mcp_call` e mostrare lo stato di José: "attivo · ultima visita stamattina 07:02". Se non c'è stata nessuna chiamata per più di 36 h: "José non si fa vivo da X ore: controlla le attività programmate".
- **Sicurezza**: spostare il token dal path dell'URL a un header (`Authorization: Bearer …`) e accettare entrambi per un periodo di transizione.

---

## PRIORITÀ 2 — Piano intelligente

### 2.1 Sessione saltata o da spostare
- Pulsante "Non riesco" sulla sessione. Il Worker genera subito 2 opzioni valide rispettando i limiti di sicurezza (es. "spostala a giovedì" / "accorciala a 25' domani"); Luca sceglie.
- José commenta la scelta alla run successiva (e sgrida, se diventa un'abitudine).

### 2.2 Memoria delle dotazioni hotel
- Per ogni trasferta senza dotazioni note, José chiede (via chat o domanda rapida): tapis roulant? palestra? parco/lungofiume vicino? colazione presto?
- Salvare per **hotel/città** in una tabella `luoghi` riusata automaticamente alle trasferte successive nella stessa città. Il briefing mostra `dotazioni` già compilate.
- Il piano usa le dotazioni: tapis → qualità possibile; solo camera → forza/mobilità o riposo.

### 2.3 Meteo
- Open-Meteo (gratis, senza chiave) sulla città del giorno: trasferta, altrimenti Milano.
- Il Worker passa nel briefing la previsione di oggi e domani (temperatura percepita, pioggia, vento) per la fascia oraria preferita.
- José suggerisce **l'azione migliore**: orario migliore, abbigliamento a strati, tapis roulant, oppure scambio con il giorno successivo. Luca soffre il freddo: soglia di attenzione intorno ai 5 °C percepiti (parametro configurabile).

### 2.4 Forza e mobilità
- Inserite nel piano: indicativamente 2 sessioni a settimana da 15-20', più mobilità breve dopo le corse; la frequenza la decide José.
- Libreria di esercizi a corpo libero **da camera d'hotel**, senza attrezzi, con nome, ripetizioni e una riga di descrizione.
- Check "fatto" in dashboard (il campo `forza_e_mobilita_14g` esiste già).

### 2.5 Push automatico su Garmin
- Ogni sessione con `steps` va su intervals.icu come workout programmato (API events) e da lì sincronizza sull'orologio. Niente più .fit manuali.
- Mostrare lo stato della sincronizzazione sulla card ("su Garmin ✓").

---

## PRIORITÀ 3 — Progressi e motivazione

### 3.1 Report settimanale — lunedì mattina, in dashboard
- Generato dalla run del lunedì mattina con un nuovo tool `coach_post_weekly_report`.
- Contenuto: settimana fatta vs pianificata, km, costanza, cosa è andato bene e cosa male, il voto di José, il focus della settimana nuova.

### 3.2 Test periodici e previsione
- Un test ogni 6-8 settimane (es. 5 km o 30' a sensazione), messo nel piano da José.
- Dopo ogni test: ricalcolo delle zone FC/passo e **previsione del tempo maratona** (es. Riegel o simile, con forchetta). Grafico dell'andamento delle previsioni nel tempo.
- L'obiettivo resta "finirla": la previsione è informativa e serve a fissare il passo di gara.

### 3.3 Badge e traguardi
- Calcolati dal Worker, commentati da José. Esempi: prima settimana completa, primo lungo da 10/15/20/25/30 km, 100 km nel mese, 4/8/12 settimane di fila complete, primo test, primo allenamento fatto in trasferta, 1000 km totali.
- Bacheca dei badge in una sezione dedicata.

### 3.4 Scarpe
- Anagrafica scarpe (modello, data inizio, km iniziali). Associazione all'uscita: scarpa predefinita, modificabile.
- Km per paio, avviso a 600 km (soglia configurabile per modello) e suggerimento di ruotare.

---

## PRIORITÀ 4 — Extra

### 4.1 Note vocali
- Pulsante microfono in chat: registrazione dal browser (MediaRecorder), trascrizione con **Cloudflare Workers AI Whisper** (`@cf/openai/whisper`, rientra nella quota gratuita), salvataggio come messaggio di chat con l'audio allegato.
- José legge la trascrizione come un normale messaggio.

### 4.2 Alimentazione — prudente e basata su fonti
- Niente diete, calorie o pesate. Solo indicazioni generali per la corsa, da linee guida consolidate (es. posizioni ACSM/ISSN sull'alimentazione negli sport di endurance):
  - pre e post corsa per tipo di sessione (facile, qualità, lungo);
  - giorni di lungo: idratazione e carboidrati prima e durante dai 90' in su;
  - **allenare l'intestino**: provare gel e ristori nei lunghi mesi prima della gara;
  - ultimi giorni prima della gara: carico di carboidrati in forma generale, niente novità.
- Ogni consiglio con una riga del tipo "perché" e, dove serve, la nota "per esigenze specifiche senti un nutrizionista".
- Il blocco "Cosa mangiare" mostra solo il consiglio pertinente alla sessione del giorno.

### 4.3 Area gara Francoforte
- Countdown, con le ultime 3 settimane (tapering) evidenziate.
- Piano di passo dalla previsione aggiornata, con passo a fasce e margine prudente.
- Strategia ristori e gel (collegata a 4.2, provata nei lunghi).
- Checklist valigia (abbigliamento per il freddo, pettorale, gel, ecc.).
- Logistica: hotel scelto (Maritim o Avani), come arrivare a partenza e arrivo, cosa fare il giorno prima. Niente dettagli del percorso inventati: solo info verificate o inserite a mano.

### 4.4 (Opzionale, bassa priorità) Craft
- Non indispensabile: il canale scelto è la dashboard. Si può aggiungere in seguito una riga "José oggi: …" nella daily note di Craft.

---

## Tool MCP: riepilogo modifiche
- `coach_get_briefing`: aggiungere `chat_in_attesa`, `chat_recente`, `segnali`, `valutazioni_recenti`, `meteo`, `luoghi/dotazioni`, `scarpe`, `badge_nuovi`, `test`, `previsione`; togliere il sonno dai check-in; aggiornare `protocollo` (persona José, chat, segnali, report del lunedì, alimentazione prudente).
- Nuovi: `coach_send_message`, `coach_update_profile`, `coach_post_weekly_report`, `coach_set_place_amenities`.
- Esistenti, invariati: `coach_post_feedback` (aggiungere il campo `dettaglio`), `coach_ask_questions`, `coach_apply_plan`, `coach_update_memory`.

## Attività programmate (lato Claude)
- Mattina (es. 07:00) e sera (es. 21:00): "Chiama coach_get_briefing del connettore Marathon coach e segui il protocollo." Il lunedì mattina il protocollo include il report settimanale.
