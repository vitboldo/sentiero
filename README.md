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

## Limiti noti

- Con lo schermo bloccato iOS sospende il GPS: al ritorno l'app stima la posizione a partire dall'ultimo punto sicuro.
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
