# Task Queue Limits

Fonte runtime: `services/requestQueue.js`.

## Configurazione

| Env | Default | Significato |
| --- | ---: | --- |
| `REQUEST_QUEUE_CONCURRENCY` | `2` | Numero massimo di task `running` contemporanei. |
| `TASK_QUEUE_MAX_PENDING` | `100` | Numero massimo di task pendenti accettati prima della backpressure. |

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

`availableSlots = max(0, concurrencyLimit - runningCount)`.

## Scheduler

Il limite globale non cambia la priorita: quando uno slot si libera, lo scheduler usa sempre `selectNextExecutableTask`, ordinando per `weight` crescente e poi `sequence` crescente.

Task in `waiting_resource`, `rate_limited` e `retrying` non consumano slot globali. Tornano a `queued` solo quando possono essere rivalutati.
