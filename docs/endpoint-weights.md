# Endpoint Weights And Queue Contracts

Riferimento ufficiale per priorita, risorse e policy dei task accodati dal server CMS.

Fonte unica: `config/taskDefinitions.js`
Generazione: `npm run docs:generate`
Verifica: `npm run docs:check`

## Regole Globali

- Peso piu basso = priorita piu alta.
- A parita di peso vale FIFO sulla sequenza di enqueue.
- Gli endpoint accodano solo `taskType` e payload; peso, timeout, retry, risorse, idempotenza e concorrenza sono letti dal registry.
- Task type sconosciuti o assenti dal registry vengono rifiutati da `services/requestQueue.js`.
- I task CardTrader dichiarano la risorsa `cardtrader`, un gruppo `cardtrader-*` e `rateLimitGroup: "cardtrader"`.

## Endpoint Che Accodano Task

| Task type | Endpoint | Metodo HTTP | Descrizione | Peso | Risorse richieste | Gruppo di concorrenza | Timeout | Max retry | Idempotenza | Note operative |
| --- | --- | --- | --- | ---: | --- | --- | ---: | ---: | --- | --- |
| cardtrader.align-prices | /api/cardtrader/run/align-prices | POST | Esegue l'allineamento prezzi completo per Pokemon, Dragon Ball e One Piece. | 10 | `cardtrader` | cardtrader-heavy | 45m | 0 | required; dedupe-by-tenant; generated:tenant-fingerprint | Aggiorna prezzi remoti su CardTrader e scrive CSV locali di supporto. |
| cardtrader.align-prices-dragonball | /api/cardtrader/run/align-prices-dragonball | POST | Esegue l'allineamento prezzi solo per Dragon Ball. | 8 | `cardtrader` | cardtrader-heavy | 20m | 0 | required; dedupe-by-tenant; generated:tenant-fingerprint | Aggiorna prezzi solo per il catalogo Dragon Ball. |
| cardtrader.align-prices-onepiece | /api/cardtrader/run/align-prices-onepiece | POST | Esegue l'allineamento prezzi solo per One Piece. | 8 | `cardtrader` | cardtrader-heavy | 20m | 0 | required; dedupe-by-tenant; generated:tenant-fingerprint | Aggiorna prezzi solo per il catalogo One Piece. |
| cardtrader.align-prices-pokemon | /api/cardtrader/run/align-prices-pokemon | POST | Esegue l'allineamento prezzi solo per Pokemon. | 8 | `cardtrader` | cardtrader-heavy | 20m | 0 | required; dedupe-by-tenant; generated:tenant-fingerprint | Aggiorna prezzi solo per il catalogo Pokemon. |
| cardtrader.sniff-cardtrader-products | /api/cardtrader/run/sniff-cardtrader-products | POST | Analizza il marketplace CardTrader e popola le segnalazioni di prezzo. | 5 | `cardtrader`, `database` | cardtrader-heavy | 30m | 1 | required; dedupe-by-tenant; generated:tenant-fingerprint | Rigenera le segnalazioni prezzo nel database; task intensivo su CardTrader. |
| cardtrader.update-booster | /api/cardtrader/run/update-booster | POST | Aggiorna i booster giapponesi in MongoDB. | 6 | `cardtrader`, `database` | cardtrader-maintenance | 20m | 2 | required; dedupe-by-tenant; generated:tenant-fingerprint | Usa upsert nel DB per evitare duplicati booster. |
| excel.convert-to-pdf | /api/excel/convert-to-pdf | POST | Converte un file Excel caricato in PDF. | 3 | `libreoffice`, `filesystem`, `cpu-heavy` | excel | 10m | 0 | optional; client-key; header:Idempotency-Key | Salva l'artefatto PDF su disco e lo rende scaricabile via task result. |

## Endpoint Operativi

| Endpoint | Metodo | Descrizione | Accoda task | Note |
| --- | --- | --- | --- | --- |
| `/api/tasks` | `GET` | Lista task con filtri `status`, `taskType`, `limit`. | No | Usa i metadati pubblici prodotti dalla coda. |
| `/api/tasks` | `POST` | Crea genericamente un task JSON supportato. | Si | Accetta solo task con `allowApiCreate: true`; ignora peso, retry e timeout inviati dal client. |
| `/api/tasks/definitions` | `GET` | Espone il catalogo task centralizzato. | No | Fonte per CMS admin e integrazioni interne. |
| `/api/tasks/:taskId` | `GET` | Legge stato dettagliato di un task. | No | Include eventi recenti e metadati di scheduling. |
| `/api/tasks/:taskId/result` | `GET` | Scarica il risultato del task completato. | No | Stream binario se esiste `artifactPath`, altrimenti JSON. |
| `/api/tasks/:taskId/cancel` | `POST` | Annulla un task se possibile. | No | Per i task running invia abort al worker. |
| `/api/tasks/:taskId/retry` | `POST` | Rilancia un task failed/cancelled se marcato safe. | Si | Il nuovo task riusa la definizione del registry. |
| `/api/resources/status` | `GET` | Stato risorse e rate limit CardTrader. | No | Mostra capacita e utilizzo delle risorse. |
| `/api/queue/stats` | `GET` | Statistiche complete della coda. | No | Snapshot operativo dello scheduler. |
| `/api/queue/status` | `GET` | Alias compatibile dello snapshot coda. | No | Mantiene compatibilita con endpoint precedente. |
| `/api/cardtrader/actions` | `GET` | Lista action CardTrader disponibili con metadata coda. | No | Deriva le action dal registry. |

## Header Operativi

- `Idempotency-Key`: usato quando la policy del task lo prevede o come dedupe key esplicita.
- `x-cardtrader-token`: obbligatorio per i task CardTrader.
- `x-mongodb-uri` oppure `x-mongo-uri`: obbligatorio per i task che scrivono su MongoDB.
- `x-db-name`: opzionale, default `CMS`.
- `x-soffice-binary-path`: opzionale per conversione Excel se LibreOffice non e nel PATH.
- `x-cardtrader-api-base-url`: opzionale per ambienti CardTrader non standard.
- `x-api-key` oppure `Authorization: Bearer <key>`: obbligatorio se `INTERNAL_API_KEY` e configurata sul server.

## Rischi Operativi

- I task CardTrader non devono bypassare la coda centrale.
- Il client non puo controllare priorita, peso, retry, timeout, risorse o gruppi di concorrenza.
- La coda attuale resta in memoria: dopo crash il tracking storico sopravvive solo finche il processo resta vivo.
- I file `api/*` legacy Vercel presenti in repo non sono la fonte primaria per il server Express e vanno considerati separatamente.
