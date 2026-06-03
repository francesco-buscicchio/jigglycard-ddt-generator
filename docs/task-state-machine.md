# Task State Machine

Fonte runtime: `services/requestQueue.js`.

## Stati

| Stato | Significato | Impostato quando | Timestamp/metadati |
| --- | --- | --- | --- |
| `pending` | Task creato internamente, non ancora confermato in coda. | `buildTask` costruisce il modello interno. | `createdAt`, `updatedAt`, `lastTransitionAt`. |
| `queued` | Task pronto per lo scheduler. | Enqueue confermato, retry/rate limit/risorsa sbloccati. | Pulisce `waitingFor`, `rateLimitInfo`, `nextAttemptAt`. |
| `running` | Worker in esecuzione. | Lo scheduler acquisisce slot e risorse. | Imposta `startedAt` al primo avvio, incrementa `attempts`, pulisce attese/errori temporanei. |
| `waiting_resource` | Task pronto ma bloccato da una risorsa occupata. | Concurrency group o risorsa richiesta non disponibili. | Valorizza `waitingFor`. |
| `rate_limited` | Task pronto ma bloccato da rate limit. | CardTrader rate limiter richiede attesa. | Valorizza `waitingFor`, `rateLimitInfo`, `nextAttemptAt`. |
| `retrying` | Errore temporaneo, retry pianificato. | Un worker fallisce e `retryCount < maxRetries`. | Incrementa `retryCount`, valorizza `error`, `nextAttemptAt`. |
| `completed` | Task completato con successo. | Worker termina senza errori. | Imposta `completedAt`, valorizza `result`, pulisce attese/errori. |
| `failed` | Task fallito definitivamente. | Worker fallisce senza retry disponibili. | Imposta `failedAt`, valorizza `error`, `result=null`. |
| `cancelled` | Task annullato. | Cancel manuale o abort del worker. | Imposta `cancelledAt`, pulisce attese/errori/result. |

## Transizioni Consentite

| Da | A |
| --- | --- |
| `pending` | `queued`, `cancelled` |
| `queued` | `running`, `waiting_resource`, `rate_limited`, `cancelled` |
| `waiting_resource` | `queued`, `cancelled` |
| `rate_limited` | `queued`, `cancelled` |
| `retrying` | `queued`, `cancelled` |
| `running` | `completed`, `retrying`, `failed`, `cancelled` |
| `completed` | nessuna |
| `failed` | nessuna |
| `cancelled` | nessuna |

Le transizioni non presenti sono rifiutate da `transitionTask`. Un retry manuale non riapre il task terminale: crea un nuovo task con lo stesso `taskType` e payload interno.

## Modello API

Ogni task restituito dalle API usa un formato uniforme:

```json
{
  "id": "task-1",
  "taskType": "excel.convert-to-pdf",
  "requestId": "request-id",
  "sourceEndpoint": "/api/excel/convert-to-pdf",
  "sequenceNumber": 1,
  "status": "queued",
  "weight": 3,
  "payloadSummary": {},
  "resources": ["libreoffice", "filesystem", "cpu-heavy"],
  "concurrencyGroup": "excel",
  "createdAt": "2026-06-03T00:00:00.000Z",
  "startedAt": null,
  "completedAt": null,
  "failedAt": null,
  "cancelledAt": null,
  "updatedAt": "2026-06-03T00:00:00.000Z",
  "lastTransitionAt": "2026-06-03T00:00:00.000Z",
  "attempts": 0,
  "retryCount": 0,
  "maxRetries": 0,
  "error": null,
  "result": null,
  "waitingFor": null,
  "rateLimitInfo": null
}
```

`payloadSummary` e il payload interno sono separati:

- `_payload` resta solo in memoria nella queue ed e passato al worker.
- `payloadSummary` e sintetico, sicuro e visibile nelle API.
- Le API task non restituiscono `_payload` o `payload`.
- `error` non contiene stack trace; usa `message`, `code`, `retryable`, `details`, `occurredAt`.
- `result` deve restare sintetico e utile per il client; per artefatti binari si usa `/api/tasks/:taskId/result`.

## API

- `GET /api/tasks`: lista task con filtri `status`, `taskType`, `requestId`, `limit`.
- `GET /api/tasks/:taskId`: dettaglio uniforme con eventi recenti.
- `POST /api/tasks/:taskId/cancel`: annulla task non terminali.
- `POST /api/tasks/:taskId/retry`: crea un nuovo task per failed/cancelled se il registry consente retry manuale.
