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

Per aggiungere un nuovo task:

1. definire `resources` e `concurrencyGroup` nel registry;
2. assicurarsi che la resource sia configurata in `TASK_RESOURCE_CAPACITIES`;
3. assicurarsi che il gruppo sia configurato in `TASK_CONCURRENCY_GROUP_CAPACITIES`;
4. aggiungere test se introduce una nuova risorsa o un nuovo gruppo.
