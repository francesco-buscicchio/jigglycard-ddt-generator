# Endpoint Weights And Queue Contracts

Riferimento ufficiale per priorita, risorse e limiti dei task accodati dal server CMS.

Fonte macchina: `config/taskDefinitions.js`
Fonte operativa: questo file

## Regole globali

- Peso piu basso = priorita piu alta.
- A parita di peso vale FIFO sulla sequenza di enqueue.
- Tutti i task passano da `services/requestQueue.js`.
- Limite globale concorrente di default: `2` task.
- Lock CardTrader di default: `1` task alla volta.
- Lock LibreOffice di default: `1` task alla volta.
- Limite database di default: `2` task alla volta.
- Backpressure di default: rifiuto oltre `100` task pendenti.

## Endpoint Che Accodano Task

| Endpoint | Metodo | Descrizione | Task type | Peso | Risorse richieste | Limite concorrenza | Idempotenza | Note |
| --- | --- | --- | --- | ---: | --- | --- | --- | --- |
| `/api/cardtrader/run/align-prices` | `POST` | Allinea i prezzi per Pokemon, Dragon Ball e One Piece | `cardtrader.align-prices` | 10 | `CardTrader` | globale `2`, gruppo `cardtrader-heavy=1`, CardTrader `1` | No | Aggiorna prezzi remoti e scrive CSV locali. Duplicati concorrenti bloccati per tenant. |
| `/api/cardtrader/run/align-prices-pokemon` | `POST` | Allinea i prezzi solo per Pokemon | `cardtrader.align-prices-pokemon` | 8 | `CardTrader` | globale `2`, gruppo `cardtrader-heavy=1`, CardTrader `1` | No | Variante piu mirata del task completo. |
| `/api/cardtrader/run/align-prices-dragonball` | `POST` | Allinea i prezzi solo per Dragon Ball | `cardtrader.align-prices-dragonball` | 8 | `CardTrader` | globale `2`, gruppo `cardtrader-heavy=1`, CardTrader `1` | No | Variante piu mirata del task completo. |
| `/api/cardtrader/run/align-prices-onepiece` | `POST` | Allinea i prezzi solo per One Piece | `cardtrader.align-prices-onepiece` | 8 | `CardTrader` | globale `2`, gruppo `cardtrader-heavy=1`, CardTrader `1` | No | Variante piu mirata del task completo. |
| `/api/cardtrader/run/sniff-cardtrader-products` | `POST` | Scansiona CardTrader e rigenera gli alert prezzo | `cardtrader.sniff-cardtrader-products` | 5 | `CardTrader`, `database` | globale `2`, gruppo `cardtrader-heavy=1`, CardTrader `1`, DB `2` | No | Richiede header CardTrader e Mongo. Retry manuale consentito. |
| `/api/cardtrader/run/update-booster` | `POST` | Aggiorna la collezione `booster_jp` in MongoDB | `cardtrader.update-booster` | 6 | `CardTrader`, `database` | globale `2`, gruppo `cardtrader-maintenance=1`, CardTrader `1`, DB `2` | Si | Usa upsert in MongoDB. Retry manuale consentito. |
| `/api/excel/convert-to-pdf` | `POST` | Converte un file Excel in PDF in modo asincrono | `excel.convert-to-pdf` | 3 | `LibreOffice` | globale `2`, gruppo `excel-conversion=1`, LibreOffice `1` | Si con `Idempotency-Key` | Restituisce subito `taskId`; il PDF si scarica da `/api/tasks/:taskId/result`. |
| `/api/tasks` | `POST` | Crea genericamente un task JSON supportato | dipende da `taskType` | da catalogo | da catalogo | da catalogo | dipende dal task | Non supporta upload file; usato soprattutto da client interni JSON. |

## Endpoint Operativi

| Endpoint | Metodo | Descrizione | Accoda task | Note |
| --- | --- | --- | --- | --- |
| `/api/tasks` | `GET` | Lista task con filtri `status`, `taskType`, `limit` | No | Usare per coda, running e storico recente. |
| `/api/tasks/:taskId` | `GET` | Legge stato dettagliato di un task | No | Include eventi recenti e metadati di scheduling. |
| `/api/tasks/:taskId/result` | `GET` | Scarica il risultato del task completato | No | Stream binario se esiste `artifactPath`, altrimenti JSON. |
| `/api/tasks/:taskId/cancel` | `POST` | Annulla un task se possibile | No | Per i task running invia abort al worker. |
| `/api/tasks/:taskId/retry` | `POST` | Rilancia un task failed/cancelled se marcato safe | No | Non tutti i task consentono retry manuale. |
| `/api/tasks/definitions` | `GET` | Espone il catalogo task centralizzato | No | Utile per CMS admin e documentazione interna. |
| `/api/resources/status` | `GET` | Stato risorse e rate limit CardTrader | No | Mostra lock, capacita e attesa per risorsa. |
| `/api/queue/stats` | `GET` | Statistiche complete della coda | No | Snapshot operativo della scheduler queue. |
| `/api/queue/status` | `GET` | Alias compatibile del snapshot coda | No | Mantiene compatibilita con endpoint precedente. |
| `/api/cardtrader/actions` | `GET` | Lista action CardTrader disponibili con metadata coda | No | Espone peso, timeout e retry per azione. |

## Header Operativi

- `Idempotency-Key`: consigliato su tutti i task creati dal client.
- `x-cardtrader-token`: obbligatorio per i task CardTrader.
- `x-mongodb-uri` oppure `x-mongo-uri`: obbligatorio per i task che scrivono su MongoDB.
- `x-db-name`: opzionale, default `CMS`.
- `x-soffice-binary-path`: opzionale per conversione Excel se LibreOffice non e nel PATH.
- `x-cardtrader-api-base-url`: opzionale per ambienti CardTrader non standard.
- `x-api-key` oppure `Authorization: Bearer <key>`: obbligatorio se `INTERNAL_API_KEY` e configurata sul server.

## Rischi Operativi

- I task CardTrader non devono bypassare la coda centrale.
- `align-prices*` non e semanticamente idempotente: usare deduplica e mai retry automatico aggressivo.
- La coda attuale resta in memoria: dopo crash il tracking storico sopravvive solo finche il processo resta vivo.
- I file `api/*` legacy Vercel presenti in repo non sono la fonte primaria per il server Express e vanno considerati separatamente.
