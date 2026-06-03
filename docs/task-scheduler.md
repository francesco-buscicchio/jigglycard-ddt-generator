# Task Scheduler

Fonte runtime: `services/requestQueue.js`.

## Responsabilita

`routes/*`:

- validano la richiesta;
- risolvono il `taskType`;
- chiamano `requestQueue.enqueueTask`;
- restituiscono subito il task al client;
- non scelgono peso, ordine o worker.

`server.js`:

- crea l'app Express;
- avvia `requestQueue.startScheduler()` quando il server parte;
- ferma `requestQueue.stopScheduler()` alla chiusura;
- non contiene logica di priorita o selezione task.

`services/requestQueue.js`:

- assegna `sequence` monotona alla creazione task;
- legge `weight` dal registry `config/taskDefinitions.js`;
- ordina con `compareTasksForScheduling`;
- promuove task pronti da `waiting_resource`, `rate_limited` e `retrying` a `queued`;
- seleziona solo task `queued`;
- fa dispatch controllato entro il limite globale di concorrenza;
- aggiorna gli stati via `transitionTask`.

## Ordinamento

La selezione usa una sola regola:

```js
if (a.weight !== b.weight) return a.weight - b.weight;
return a.sequence - b.sequence;
```

Peso piu basso significa priorita piu alta. A parita di peso, la sequence piu bassa parte prima.

## Flusso

1. `enqueueTask` crea il task in `pending`, assegna `sequence`, applica metadata dal registry e lo porta a `queued`.
2. `scheduleScheduler` pianifica il loop solo se `startScheduler` e stato chiamato.
3. `runScheduler` usa un lock interno (`schedulerRunning`) per evitare loop concorrenti.
4. `promoteDueTasks` riporta a `queued` i task pronti dopo risorse/rate limit/retry.
5. `selectNextExecutableTask` considera solo `queued`, in ordine `weight, sequence`.
6. `dispatchNextTask` acquisisce gli slot, porta il task a `running` e avvia il worker.
7. `executeTask` completa, fallisce, cancella o pianifica retry usando la state machine.

I task `completed`, `failed` e `cancelled` non vengono mai selezionati. I task `waiting_resource`, `rate_limited` e `retrying` non partono direttamente: tornano prima a `queued` quando sono pronti.
