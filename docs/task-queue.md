# Task Queue Limits

Fonte runtime: `services/requestQueue.js`.

## Configurazione

| Env | Default | Significato |
| --- | ---: | --- |
| `REQUEST_QUEUE_CONCURRENCY` | `2` | Numero massimo di task `running` contemporanei. |
| `TASK_QUEUE_MAX_PENDING` | `100` | Numero massimo di task pendenti accettati prima della backpressure. |
| `TASK_RESOURCE_CARDTRADER_CAPACITY` | `1` | Slot per task che usano `cardtrader`. |
| `TASK_RESOURCE_DATABASE_CAPACITY` | `2` | Slot per task che usano `database`. |
| `TASK_RESOURCE_LIBREOFFICE_CAPACITY` | `1` | Slot per task che usano `libreoffice`. |
| `TASK_RESOURCE_FILESYSTEM_CAPACITY` | `2` | Slot per task che usano `filesystem`. |
| `TASK_RESOURCE_CPU_HEAVY_CAPACITY` | `1` | Slot per task che usano `cpu-heavy`. |
| `TASK_CONCURRENCY_GROUP_CARDTRADER_HEAVY_CAPACITY` | `1` | Slot per gruppo `cardtrader-heavy`. |
| `TASK_CONCURRENCY_GROUP_CARDTRADER_MAINTENANCE_CAPACITY` | `1` | Slot per gruppo `cardtrader-maintenance`. |
| `TASK_CONCURRENCY_GROUP_EXCEL_CAPACITY` | `1` | Slot per gruppo `excel`. |

| `TASK_PERSISTENCE_ENABLED` | `true` | Se `false`, la coda opera solo in memoria. |
| `TASK_PERSISTENCE_MONGO_URI` | `MONGODB_URI`/`MONGO_URI` | URI Mongo dello store della coda. |
| `TASK_PERSISTENCE_DB_NAME` | `DB_NAME` o `CMS` | Database dello store della coda. |
| `TASK_PERSISTENCE_COLLECTION` | `queue_tasks` | Collection dei documenti task. |
| `PDF_ARTIFACT_TTL_MS` | `86400000` (24h) | Retention degli artefatti PDF in `pdf_export/`. |

I valori vengono letti in `config/config.js`. Valori mancanti, non numerici o minori di `1` tornano al default.

## Stati Contati

`runningCount` conta i task attualmente in esecuzione e consuma slot globali.

`pendingCount` conta la profondita reale della coda e include:

- `pending`
- `queued`
- `waiting_resource`
- `rate_limited`
- `retrying`

Non include:

- `running`
- `completed`
- `failed`
- `cancelled`

Questa scelta protegge la memoria e la profondita operativa della coda: un task fermo per risorsa, rate limit o retry resta lavoro futuro da gestire.

## Backpressure

Quando `pendingCount >= TASK_QUEUE_MAX_PENDING`, `enqueueTask` rifiuta nuove richieste prima di creare il task.

Errore applicativo:

```json
{
  "ok": false,
  "code": "QUEUE_FULL",
  "error": "La coda di elaborazione e temporaneamente piena. Riprova tra qualche minuto."
}
```

HTTP:

- status `429`
- header `Retry-After: 60`

Gli endpoint non bypassano questo controllo: `routes/cardtrader.js`, `routes/excel.js` e `routes/tasks.js` passano da `requestQueue.enqueueTask`.

## Stats

`GET /api/tasks/queue/status`, `GET /api/queue/stats` e `GET /api/queue/status` espongono metriche operative tra cui:

- `runningCount`
- `pendingCount`
- `queuedCount`
- `waitingResourceCount`
- `rateLimitedCount`
- `retryingCount`
- `completedCount`
- `failedCount`
- `cancelledCount`
- `concurrencyLimit`
- `maxPending`
- `availableSlots`
- `isBackpressureActive`
- `resources`
- `concurrencyGroups`

`availableSlots = max(0, concurrencyLimit - runningCount)`.

Per ogni risorsa e gruppo sono esposti:

- `capacity`
- `inUse`
- `available`
- `waitingCount`

## Scheduler

Il limite globale non cambia la priorita: quando uno slot si libera, lo scheduler usa sempre `selectNextExecutableTask`, ordinando per `weight` crescente e poi `sequence` crescente.

Task in `waiting_resource`, `rate_limited` e `retrying` non consumano slot globali. Tornano a `queued` solo quando possono essere rivalutati.

## Resources E Gruppi

Le risorse e il `concurrencyGroup` arrivano solo da `config/taskDefinitions.js`.

Regole operative:

- task CardTrader: `resources` include `cardtrader`; `concurrencyGroup` inizia con `cardtrader`.
- task DB: `resources` include `database`.
- task Excel/PDF: `resources` include `libreoffice`, `filesystem`, `cpu-heavy`; `concurrencyGroup` e `excel`.
- un task fermo per risorsa passa a `waiting_resource` con `waitingFor.kind = "resource"` o `waitingFor.kind = "concurrency_group"`.
- un task bloccato da CardTrader rate limit passa a `rate_limited`.

## Persistenza E Recovery

Fonte runtime: `services/taskStore.js` (store) e `services/requestQueue.js` (hook).

Se `TASK_PERSISTENCE_ENABLED` e una Mongo URI sono configurate, ogni transizione
di stato viene salvata come documento nella collection `queue_tasks` (un
documento per task, incluse `payload` e `requestEnv` necessarie al recovery —
nota operativa: i token runtime dei tenant risiedono quindi nel db della coda).

All'avvio (`server.js`) il server:

1. collega lo store e ricarica tutti i task non terminali più gli ultimi
   `TASK_QUEUE_HISTORY_LIMIT` terminali (storico consultabile dopo restart);
2. riaccoda i task che risultavano `pending` o `running` al momento del crash
   (evento `recovered_after_restart`); `waiting_resource`, `rate_limited` e
   `retrying` riprendono così com'erano e vengono gestiti dallo scheduler;
3. ricostruisce il dedupe index (l'idempotenza sopravvive al restart) e la
   `sequence` (nessuna collisione di id);
4. avvia lo scheduler. Se lo store non è raggiungibile, la coda parte comunque
   in modalità solo-memoria (log di avvertimento, nessun crash).

`pruneHistory` elimina anche il documento persistito e l'eventuale artefatto su
disco (`result.artifactPath`). Gli artefatti PDF orfani in `pdf_export/` vengono
rimossi da uno sweep orario secondo `PDF_ARTIFACT_TTL_MS`.

## Tempi Medi

`getQueueStats()` espone `timings` con `completedCount`, `avgExecutionMs` e
`avgWaitMs`, globali e per `taskType`. Le medie sono calcolate in memoria dai
task completati dall'avvio del processo.

## Smoke Test

Il task `system.echo` (creabile via `POST /api/tasks`) non ha effetti esterni:
restituisce il payload dopo un `delayMs` opzionale (cap 30s). È usato dagli
integration test HTTP (`test/httpApi.test.js`) e utilizzabile come smoke test
end-to-end della coda in produzione.

Per aggiungere un nuovo task:

1. definire `resources` e `concurrencyGroup` nel registry;
2. assicurarsi che la resource sia configurata in `TASK_RESOURCE_CAPACITIES`;
3. assicurarsi che il gruppo sia configurato in `TASK_CONCURRENCY_GROUP_CAPACITIES`;
4. aggiungere test se introduce una nuova risorsa o un nuovo gruppo.
