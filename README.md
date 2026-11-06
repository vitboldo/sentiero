# Sentiero

Web app (PWA) per seguire tracce GPX in montagna, pensata per iPhone e per l'uso senza rete. Apre le tracce, mostra la posizione sul percorso, il km e il dislivello che mancano e il tempo stimato. Non registra tracce e non invia dati a nessun server.

## Installazione su iPhone

1. Apri il link dell'app in **Safari**.
2. Tocca **Condividi** > **Aggiungi alla schermata Home**.
3. Apri Sentiero dall'icona nella schermata Home.
4. Consenti l'accesso alla posizione.

## Prima di partire

- [ ] Carica le tracce GPX.
- [ ] Scarica le mappe offline per la zona.
- [ ] Attiva la **modalità aereo** e verifica che mappa e GPS funzionino ancora.
- [ ] Imposta **Impostazioni > Schermo e luminosità > Blocco automatico** su **Mai**.
- [ ] Porta una power bank.
- [ ] Tieni una copia del percorso in un'altra app o su carta.

## Aspetto

Il pulsante rotondo in basso a sinistra sulla mappa sceglie il tema: Chiaro (predefinito, il più leggibile al sole), Scuro o Automatico (segue l'iPhone). Nel tema scuro si scurisce anche la mappa.

## Navigazione

Il pulsante di posizione ha tre stati: al primo tocco la mappa ti segue con il nord in alto, al secondo gira con l'iPhone (**Navigazione**), al terzo torna libera. Con due dita puoi ruotarla e ingrandirla; la bussolina in alto a destra riporta il nord in alto. Al primo tocco iOS chiede il permesso per la bussola: va consentito per vedere il cono di direzione e usare la Navigazione.

## Limiti noti

- Con lo schermo bloccato iOS sospende il GPS: al ritorno l'app stima la posizione a partire dall'ultimo punto sicuro.
- La bussola indica il nord magnetico (in Italia lo scarto dal nord geografico è di pochi gradi) e risente di metalli e magneti vicini: non sostituisce una bussola vera. iOS può richiedere il permesso a ogni apertura dell'app.
- Le mappe sono di [OpenTopoMap](https://opentopomap.org). Attribuzione: Kartendaten: © OpenStreetMap-Mitwirkende, SRTM | Kartendarstellung: © OpenTopoMap (CC-BY-SA).

## Test

```sh
npm install
npm test
```

Test end-to-end (Playwright, iPhone 15; tile stubbate, nessuna richiesta reale a opentopomap.org):

```sh
npx playwright install webkit chromium
npm run e2e
```

## Licenza

[GPL-3.0](LICENSE). Include [Leaflet](https://leafletjs.com) (BSD-2-Clause) e [leaflet-rotate](https://github.com/Raruto/leaflet-rotate) (GPL-3.0).
