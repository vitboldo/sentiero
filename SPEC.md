# Sentiero — PWA per seguire tracce GPX (iPhone, Safari, Home Screen)

Uso reale: trekking in montagna, spesso senza rete, sotto il sole, con una mano. UI interamente in italiano.
Non registra tracce. Apre, segue, modifica in modo basilare.

## Vincoli tecnici
- Solo file statici, nessun passo di build, ES modules nativi, JS con JSDoc. Tutti i percorsi RELATIVI (GitHub Pages in sottocartella).
- Nessuna dipendenza runtime da CDN: Leaflet 1.9.4 in `vendor/leaflet/`. Niente analytics, niente dati inviati a server.
- Target iOS Safari 16.4+. Test con `node --test` (Node 22). Solo devDependency ammesse: `@xmldom/xmldom`, `playwright`.
- `src/core/` è puro: niente DOM, niente `window`, niente IndexedDB. Deve restare riusabile da una futura app nativa.

## Struttura e proprietà dei file
```
index.html  styles.css                       [UI]
src/app/main.js store.js map.js profile.js ui.js  [UI]
src/app/offline.js  sw.js                     [OFFLINE]
src/core/gpx.js geo.js route.js edit.js matcher.js tracker.js tiles.js  [CORE]
test/*.test.js  test/fixtures/*.gpx          [CORE]
manifest.webmanifest icons/ vendor/ README.md package.json .gitignore  [ASSETS]
```
Ogni agente modifica solo i propri file. Se un contratto sotto non basta, adatta il minimo, e riportalo nel report finale.

## Modello dati
```js
// Track, persistita in IndexedDB. points è sempre nell'ordine originale del file.
{ id:string, name:string, color:string, visible:boolean, reversed:boolean,
  points:[{lat,lon,ele:number|null}], waypoints:[{lat,lon,ele:number|null,name:string}],
  original:{name,points}|null }   // per "Ripristina originale"; impostato alla prima modifica

// Route: percorso seguito, costruito dalle tracce visibili nell'ordine di sessione.
{ points:[{lat,lon,ele,trackId}], cumDist:number[] /*m*/, cumUp:number[], cumDown:number[],
  trackRanges:[{trackId,name,startIdx,endIdx,startDist,endDist,gapBeforeM}],
  totalDist, totalUp, totalDown, hasElevation:boolean }
```

## Contratti CORE
### `gpx.js`
- `parseGpx(xmlText, DOMParserImpl = globalThis.DOMParser)` → `{tracks:[{name,points,waypoints}]}`. Un elemento per ogni `<trk>` o `<rte>`, con i `trkseg` appiattiti in ordine. Ignora il namespace (GPX 1.0/1.1 e prefissi). I waypoint `<wpt>` vanno sulla prima traccia. Scarta punti senza lat/lon validi e duplicati consecutivi. Errori: lancia `GpxError` con messaggio in italiano se XML non valido o zero punti.
- `serializeGpx(track, {applyReverse=true})` → string GPX 1.1 con escape XML corretto.

### `geo.js`
`haversineM(a,b)`, `bearingDeg(a,b)`, `projectToSegment(p,a,b)` → `{t,lat,lon,distM}` (proiezione equirettangolare locale, t in [0,1]), `formatKm(m)`, `formatDuration(sec)`, `interpolate(a,b,t)`.

### `route.js`
- `effectivePoints(track)`: punti nella direzione di marcia.
- `buildRoute(tracks)`: solo `visible`, nell'ordine dato. I salti tra tracce NON contano nella distanza; `gapBeforeM` li riporta.
- Dislivelli: isteresi 5 m su quote lisciate (media mobile su finestra di 50 m), robusta a quote mancanti; `hasElevation=false` se meno del 50% dei punti ha quota. Calcolati nella direzione di marcia. L'inversione deve scambiare D+ e D- entro il 3%.
- `statsAt(route,dist)` → `{lat,lon,ele,up,down}` interpolati. `remainingFrom(route,dist,toDist=route.totalDist)` → `{dist,up,down}`.
- `reverseSession(tracks)` → nuovo array in ordine inverso, con `reversed` invertito per ciascuna traccia.
- `munterSeconds(dist,up,down)`: ore = dist/4000 + max(up/400, down/800) sommando per i contributi; `routeTimeSeconds(route,fromDist,toDist)`.

### `edit.js` (immutabili, restituiscono nuove Track; `original` salvato alla prima modifica)
`renameTrack(t,name)`, `toggleReverse(t)`, `trimTrack(t,startIdx,endIdx)` con indici su `effectivePoints` (il risultato deve rimanere coerente con `reversed`), `mergeTracks(a,b,newId)` (usa le direzioni effettive, risultato `reversed:false`), `removeWaypoint(t,i)`, `restoreOriginal(t)`.

### `matcher.js`
`matchPosition(route, fix, prev)`; `fix={lat,lon,accuracy,timestamp}`; `prev={distAlong,timestamp,pendingJump}|null`.
Ritorna `{distAlong,lat,lon,offTrackM,offTrack,segIdx,ambiguous,pendingJump}`.
- Più candidati: un minimo locale per ogni passaggio vicino della traccia entro `max(75, 3*accuracy)` m. Essenziale per andata e ritorno e anelli che si sovrappongono: **non deve mai saltare al ramo sbagliato** quando due rami sono vicini.
- Costo = distanza laterale + penalità sulla differenza da `prev.distAlong`, oltre a quanto percorribile a 3 m/s in `dt`; avanti è preferito a indietro.
- Prima posizione (`prev` null): il più vicino; a parità entro 30 m il primo sulla traccia, con `ambiguous:true`.
- Salto: se il candidato migliore è lontano da `prev` in modo non plausibile, resta sul progresso corrente e richiede 3 fix consecutivi coerenti (`pendingJump`) prima di saltare.
- `offTrack=true` se `offTrackM > max(50, 1.5*accuracy)`; in tal caso `distAlong` resta al miglior progresso noto, ma `lat/lon/offTrackM` indicano il punto più vicino.
- Max 50.000 punti, una chiamata < 20 ms su laptop.

### `tracker.js`
`createTracker(route, {restored=null}={})` → `{ingestFix(fix), snapshot(nowMs), serialize()}`. Il tempo è sempre passato esplicitamente, per i test. `fix` aggiunge `speed` opzionale.

Qualità:
- `good`: fix con età ≤ 15 s, accuracy ≤ 30 m, velocità implicita dall'ultimo punto sicuro ≤ 4 m/s. Diventa `lastSure`.
- `weak`: fix fresco con accuracy tra 30 e 100 m, oppure fresco ma implausibile. Mostra la posizione come approssimata, non aggiorna `lastSure`. Può avanzare `distAlong` solo se plausibile rispetto al progresso.
- `lost`: nessun fix utilizzabile da > 45 s dall'ultimo fix buono, o accuracy > 100 m. Attiva la stima.
- `none`: nessun fix mai.
Un fix con `timestamp` più vecchio di 15 s rispetto a `nowMs` (iOS li rende al risveglio) non conta come fresco.

Stima (solo in `lost`, e solo se `lastSure` era sulla traccia):
- Il tempo trascorso avanza lungo la route con `routeTimeSeconds` × `pace`. `pace` è il rapporto osservato tra tempo reale e tempo Munter sul tratto camminato con fix buoni negli ultimi 30 min, soste escluse, limitato a [0.5, 2.0]; default 1.0 con meno di 500 m di campione.
- `estimate={distAlong,lat,lon,minDist,maxDist,ageSec,pace,paceSource:'osservato'|'predefinito'}`. `minDist = lastSure.distAlong` (potresti esserti fermato). `maxDist` = avanzamento a pace/1.4. Tutto limitato alla fine della route.
- Se `lastSure` era fuori traccia: `estimate=null` e `estimateUnavailableReason='fuori traccia'`. Mai inventare una posizione.

`snapshot(now)` →
```js
{ quality, accuracy, ageSec,
  gps:{lat,lon,accuracy,timestamp}|null,          // ultimo fix ricevuto, grezzo
  lastSure:{lat,lon,distAlong,timestamp,accuracy,onTrack}|null,
  estimate, estimateUnavailableReason,
  distAlong,             // miglior valore: gps se good/weak, estimate.distAlong se lost
  source:'gps'|'approssimata'|'stima'|'nessuna',
  offTrack, offTrackM, nearest:{lat,lon}|null, bearingToTrackDeg, ambiguous,
  done:{dist,up,down}, remaining:{dist,up,down,etaSec},
  currentTrack:{trackId,name,index,remaining:{dist,up,down,etaSec}}|null,
  justRecovered:{deltaM}|null }                   // per 30 s dopo il rientro da lost
```
`serialize()` restituisce JSON persistibile. `restored` permette di riprendere dopo la chiusura dell'app; un buco di tempo porta correttamente in `lost`.

### `tiles.js`
`tilesForCorridor(points,{minZoom,maxZoom,bufferM})` → `[{z,x,y}]` senza duplicati: solo le tile entro `bufferM` dalla traccia, MAI il bounding box. `estimateBytes(tiles)` usa 40 KB a tile. `PRECISION_PRESETS=[{id:'bassa',label:'Bassa',maxZoom:13},{id:'media',label:'Media',maxZoom:14},{id:'alta',label:'Alta',maxZoom:15},{id:'massima',label:'Massima',maxZoom:16}]`, `minZoom` 10, `bufferM` scelto dall'utente: 500/1000/2000, default 1000. `MAX_TILES=10000`. `tileUrl({z,x,y})`.

## Mappe
`TILE_URL='https://a.tile.opentopomap.org/{z}/{x}/{y}.png'`, unico host per avere chiavi di cache stabili; definito in `tiles.js`. Attribuzione sempre visibile: `Kartendaten: © OpenStreetMap-Mitwirkende, SRTM | Kartendarstellung: © OpenTopoMap (CC-BY-SA)`. CORS verificato: `Access-Control-Allow-Origin: *`. Non usare mai tile.openstreetmap.org per il download: la policy lo vieta.

## Contratto OFFLINE (`src/app/offline.js`, usato da UI)
```js
registerServiceWorker()
planDownload(tracks,{presetId,bufferM}) // {tiles,count,bytes,tooMany}
startDownload(name,plan,{onProgress({done,total,failed,skipped}),signal}) // Promise<{done,failed,skipped,aborted}>
listPackages()       // [{id,name,count,bytes,failed,createdAt,presetId}]
deletePackage(id)    // non elimina tile condivise con altri pacchetti
storageInfo()        // {usageBytes,quotaBytes,persisted}
requestPersist()
```
- Pacchetti in IndexedDB `sentiero-offline`, store `packages`, con la lista di tile. Tile nella Cache `tiles-offline-v1`. Riprendibile: salta quelle già presenti.
- Rispetto del server: max 2 richieste contemporanee, almeno 150 ms tra un avvio e l'altro. Su 429/5xx: backoff esponenziale, e sospensione se persiste. 3 tentativi. Mai oltre `MAX_TILES`.
- `sw.js`: precache di tutta l'app, cache-first con aggiornamento in background per la shell. Per le tile: cache offline, poi `tiles-runtime-v1` (massimo 2000 voci, FIFO), poi rete; se tutto fallisce risponde 504 così Leaflet genera `tileerror`. Versionare con `CACHE_VERSION`. La nuova versione non deve mai rompere l'app in uso: `skipWaiting` solo su messaggio dalla UI.

## Contratto UI
- Mappa a tutto schermo. Leaflet, `maxZoom` 17. Sottoclasse di `L.TileLayer`: su errore tile usa la tile antenata (fino a z-5) ritagliata su canvas, così a zoom superiori a quelli scaricati la mappa resta visibile. Linee delle tracce vettoriali, sempre visibili anche senza mappa.
- Tracce con colori distinti, frecce di direzione ogni ~500 m (per vedere il verso dopo un'inversione) e marker inizio/fine. Parte già fatta attenuata. Waypoint con nome.
- Marker: GPS blu con cerchio di accuracy; **ultimo punto sicuro** come marker distinto con ora; **stima** tratteggiata arancione, con arco [minDist,maxDist] evidenziato sulla traccia. Mai confondibili tra loro.
- Pillola di stato sempre visibile: verde `GPS ok ±8 m`, giallo `GPS debole ±60 m`, rosso `Stima: ultimo punto sicuro 12 min fa`, grigio `In attesa del GPS`. Al rientro: `GPS recuperato, eri 180 m oltre la stima`.
- Pannello in basso sempre visibile, con numeri grandi: **km mancanti, D+ mancante, D− mancante, tempo stimato**. Selettore `Tappa / Totale` se le tracce sono più di una. Se la fonte è la stima, prefisso `~` e colore arancione.
- Profilo altimetrico su canvas nel pannello: parte fatta scurita, indicatore posizione, banda stima, tacca ultimo punto sicuro, separatori tra tracce. Etichette `fatti X km · mancano Y km`. Tocco e trascinamento mostrano km, quota, D+ e D− da qui, e un mirino sulla mappa.
- Banner fuori traccia: `Sei a 120 m dalla traccia` con freccia ruotata verso il punto più vicino.
- Bottoni grandi (min 48 px): centra su di me/segui, tracce, mappe offline. La mappa smette di seguire al trascinamento.
- Foglio Tracce: importazione multipla (`<input type=file multiple>` SENZA `accept`: iOS disabilita i .gpx altrimenti), lista con colore, visibilità, sposta su/giù, Inverti, Modifica, Esporta GPX, Elimina con conferma. Bottone `Inverti tutto il percorso`. Avviso se c'è un salto > 200 m tra tracce consecutive.
- Modifica: rinomina, taglia inizio/fine con due cursori e anteprima su mappa e profilo, unisci con la traccia successiva, elimina waypoint, ripristina originale.
- Foglio Mappe offline: nome del pacchetto, Precisione, Fascia, stima tile e MB aggiornata dal vivo, barra di avanzamento, annulla, lista pacchetti con elimina, spazio usato. `tooMany` blocca il download con una spiegazione. A fine download segnala se ci sono tile fallite e offre di riprovare.
- Screen Wake Lock: attivo per default durante il tracciamento, riacquisito su `visibilitychange`. Se non disponibile: indicazione di impostare il Blocco automatico su Mai. Al ritorno in primo piano, riavvio di `watchPosition`.
- Avviso alla prima apertura, una sola volta: a schermo bloccato iOS sospende il GPS, l'app stimerà la posizione al ritorno. Se non è in modalità standalone: guida a `Condividi > Aggiungi alla schermata Home`.
- Persistenza (`store.js`, IndexedDB `sentiero`): tracce, ordine, stato tracker, `Tappa/Totale`, ultima vista mappa. All'apertura ripristina tutto. Tutte le chiamate tollerano errori di storage e li mostrano.
- Stile: tema chiaro ad alto contrasto, leggibile al sole, testo minimo 16 px, numeri principali almeno 28 px, safe-area iOS, layout solo verticale ma non rotto in orizzontale. Nessun grigio chiaro su bianco.
- Rendering: l'aggiornamento è guidato da un tick di 1 s su `tracker.snapshot(Date.now())`. Il profilo si ridisegna solo se cambia qualcosa.
- Per i test E2E, `window.__sentiero` espone `{tracks(), snapshot(), injectFix(fix)}`.
