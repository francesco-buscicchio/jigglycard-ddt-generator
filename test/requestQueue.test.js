const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const path = require("path");
const requestQueueModule = require("../services/requestQueue");
const {
  RequestQueue,
} = requestQueueModule;
const {
  listTaskDefinitions,
  validateTaskDefinitions,
} = require("../config/taskDefinitions");
const {
  generateEndpointWeightsDoc,
} = require("../scripts/generateEndpointWeightsDoc");
const cardTraderRateLimiter = require("../services/cardTraderRateLimiter");
const { createApp } = require("../server");

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate, { timeoutMs = 2_000, intervalMs = 10 } = {}) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error("Timeout in attesa della condizione di test.");
}

function taskDefinition(overrides = {}) {
  const taskType = overrides.taskType || "test.task";
  return {
    taskType,
    endpoint: overrides.endpoint || `/${taskType}`,
    method: "POST",
    description: overrides.description || `Task ${taskType}`,
    weight: 5,
    resources: ["local"],
    concurrencyGroup: "default",
    timeoutMs: 2_000,
    maxRetries: 0,
    idempotency: { required: false, strategy: "none" },
    operationalNotes: "Definizione task usata dai test.",
    ...overrides,
  };
}

function createQueue(taskDefinitions, options = {}) {
  const { autoStart = true, ...queueOptions } = options;
  const resourceLimits = {
    local: { capacity: 100 },
    ...(queueOptions.resourceLimits ?? {}),
  };
  const queue = new RequestQueue({
    concurrency: 1,
    maxPendingTasks: 20,
    historyLimit: 50,
    ...queueOptions,
    resourceLimits,
    taskDefinitions,
  });
  if (autoStart) {
    queue.startScheduler();
  }

  return queue;
}

function createQueuedTask(queue, input = {}) {
  const taskType = input.taskType || "stateful";
  if (!queue.taskHandlers.has(taskType)) {
    queue.registerHandler(taskType, async () => ({ ok: true }));
  }
  const task = queue.buildTask({
    taskType,
    requestId: input.requestId || "test-request",
    sourceEndpoint: input.sourceEndpoint || "/stateful",
    payload: input.payload || { secret: "internal" },
    payloadSummary: input.payloadSummary || { safe: true },
  });
  queue.tasks.set(task.id, task);
  queue.transitionTask(task.id, "queued");
  return task;
}

test.beforeEach(() => {
  cardTraderRateLimiter.reset();
});

test("esegue prima il task con peso piu basso", async () => {
  const order = [];
  const queue = createQueue([
    taskDefinition({
      taskType: "heavy",
      endpoint: "/heavy",
      description: "Heavy",
      weight: 10,
    }),
    taskDefinition({
      taskType: "urgent",
      endpoint: "/urgent",
      description: "Urgent",
      weight: 1,
    }),
  ]);

  queue.registerHandler("heavy", async () => {
    order.push("heavy");
  });
  queue.registerHandler("urgent", async () => {
    order.push("urgent");
  });

  queue.enqueue({ taskType: "heavy" });
  queue.enqueue({ taskType: "urgent" });

  await waitFor(() => order.length === 2);
  assert.deepEqual(order, ["urgent", "heavy"]);
});

test("mantiene FIFO a parita di peso", async () => {
  const order = [];
  const queue = createQueue([
    taskDefinition({
      taskType: "a",
      endpoint: "/a",
      description: "A",
      weight: 5,
    }),
    taskDefinition({
      taskType: "b",
      endpoint: "/b",
      description: "B",
      weight: 5,
    }),
  ]);

  queue.registerHandler("a", async () => {
    order.push("a");
  });
  queue.registerHandler("b", async () => {
    order.push("b");
  });

  queue.enqueue({ taskType: "a" });
  queue.enqueue({ taskType: "b" });

  await waitFor(() => order.length === 2);
  assert.deepEqual(order, ["a", "b"]);
});

test("selectNextExecutableTask ordina per peso e poi sequence", () => {
  const queue = createQueue(
    [
      taskDefinition({ taskType: "a", endpoint: "/a", weight: 10 }),
      taskDefinition({ taskType: "b", endpoint: "/b", weight: 1 }),
      taskDefinition({ taskType: "c", endpoint: "/c", weight: 1 }),
    ],
    { autoStart: false, concurrency: 1 },
  );

  for (const taskType of ["a", "b", "c"]) {
    queue.registerHandler(taskType, async () => ({ taskType }));
    const task = queue.buildTask({ taskType });
    queue.tasks.set(task.id, task);
    queue.transitionTask(task.id, "queued");
  }

  let selected = queue.selectNextExecutableTask().task;
  assert.equal(selected.taskType, "b");
  queue.transitionTask(selected.id, "running");
  queue.transitionTask(selected.id, "completed", { result: { ok: true } });

  selected = queue.selectNextExecutableTask().task;
  assert.equal(selected.taskType, "c");
  queue.transitionTask(selected.id, "running");
  queue.transitionTask(selected.id, "completed", { result: { ok: true } });

  selected = queue.selectNextExecutableTask().task;
  assert.equal(selected.taskType, "a");
});

test("selectNextExecutableTask seleziona solo task queued", () => {
  const queue = createQueue(
    [
      taskDefinition({ taskType: "queued", endpoint: "/queued", weight: 10 }),
      taskDefinition({ taskType: "waiting", endpoint: "/waiting", weight: 1 }),
      taskDefinition({ taskType: "limited", endpoint: "/limited", weight: 1 }),
      taskDefinition({ taskType: "retrying", endpoint: "/retrying", weight: 1 }),
      taskDefinition({ taskType: "done", endpoint: "/done", weight: 1 }),
      taskDefinition({ taskType: "failed", endpoint: "/failed", weight: 1 }),
      taskDefinition({ taskType: "cancelled", endpoint: "/cancelled", weight: 1 }),
    ],
    { autoStart: false },
  );

  const queuedTask = createQueuedTask(queue, { taskType: "queued" });
  const waitingTask = createQueuedTask(queue, { taskType: "waiting" });
  queue.transitionTask(waitingTask.id, "waiting_resource", {
    waitingFor: { kind: "resource", id: "database", message: "busy" },
  });

  const limitedTask = createQueuedTask(queue, { taskType: "limited" });
  queue.transitionTask(limitedTask.id, "rate_limited", {
    waitingFor: { kind: "rate_limit", id: "cardtrader", message: "limited" },
    rateLimitInfo: { blocked: true },
    nextAttemptAt: Date.now() + 60_000,
  });

  const retryingTask = createQueuedTask(queue, { taskType: "retrying" });
  queue.transitionTask(retryingTask.id, "running");
  queue.transitionTask(retryingTask.id, "retrying", {
    error: new Error("temporary"),
    nextAttemptAt: Date.now() + 60_000,
  });

  const doneTask = createQueuedTask(queue, { taskType: "done" });
  queue.transitionTask(doneTask.id, "running");
  queue.transitionTask(doneTask.id, "completed", { result: { ok: true } });

  const failedTask = createQueuedTask(queue, { taskType: "failed" });
  queue.transitionTask(failedTask.id, "running");
  queue.transitionTask(failedTask.id, "failed", { error: new Error("fail") });

  const cancelledTask = createQueuedTask(queue, { taskType: "cancelled" });
  queue.transitionTask(cancelledTask.id, "cancelled");

  assert.equal(queue.selectNextExecutableTask().task.id, queuedTask.id);
});

test("rispetta il limite massimo di task concorrenti", async () => {
  let active = 0;
  let maxActive = 0;
  let started = 0;
  const taskDeferred = createDeferred();
  const queue = createQueue(
    [
      taskDefinition({
        taskType: "work",
        endpoint: "/work",
        description: "Work",
        weight: 5,
        timeoutMs: 5_000,
      }),
    ],
    { concurrency: 2 },
  );

  queue.registerHandler("work", async () => {
    started += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    await taskDeferred.promise;
    active -= 1;
  });

  queue.enqueue({ taskType: "work" });
  queue.enqueue({ taskType: "work" });
  queue.enqueue({ taskType: "work" });

  await waitFor(() => started === 2);
  assert.equal(maxActive, 2);

  taskDeferred.resolve();
  await waitFor(() => started === 3);
});

test("backpressure rifiuta nuovi task senza creare task parziali", () => {
  const queue = createQueue(
    [
      taskDefinition({
        taskType: "limited-queue",
        endpoint: "/limited-queue",
      }),
    ],
    { autoStart: false, maxPendingTasks: 3 },
  );
  queue.registerHandler("limited-queue", async () => ({ ok: true }));

  queue.enqueueTask({ taskType: "limited-queue" });
  queue.enqueueTask({ taskType: "limited-queue" });
  queue.enqueueTask({ taskType: "limited-queue" });

  assert.equal(queue.getQueueStats().isBackpressureActive, true);
  assert.throws(
    () => queue.enqueueTask({ taskType: "limited-queue" }),
    (error) => {
      assert.equal(error.name, "QueueBackpressureError");
      assert.equal(error.statusCode, 429);
      assert.equal(error.code, "QUEUE_FULL");
      assert.equal(error.retryAfterSeconds, 60);
      return true;
    },
  );
  assert.equal(queue.listTasks({ limit: 10 }).length, 3);
  assert.equal(queue.sequence, 3);
});

test("getQueueStats espone running, pending, limiti e slot disponibili", async () => {
  const runningDeferred = createDeferred();
  const queue = createQueue(
    [
      taskDefinition({ taskType: "running", endpoint: "/running" }),
      taskDefinition({ taskType: "queued", endpoint: "/queued" }),
      taskDefinition({ taskType: "waiting", endpoint: "/waiting" }),
      taskDefinition({ taskType: "limited", endpoint: "/limited" }),
      taskDefinition({ taskType: "retrying", endpoint: "/retrying", maxRetries: 1 }),
      taskDefinition({ taskType: "done", endpoint: "/done" }),
      taskDefinition({ taskType: "failed", endpoint: "/failed" }),
      taskDefinition({ taskType: "cancelled", endpoint: "/cancelled" }),
    ],
    { autoStart: false, concurrency: 2, maxPendingTasks: 5 },
  );
  queue.registerHandler("running", async () => {
    await runningDeferred.promise;
  });

  const runningTask = createQueuedTask(queue, { taskType: "running" });
  queue.dispatchNextTask(runningTask);

  createQueuedTask(queue, { taskType: "queued" });

  const waitingTask = createQueuedTask(queue, { taskType: "waiting" });
  queue.transitionTask(waitingTask.id, "waiting_resource", {
    waitingFor: { kind: "resource", id: "database", message: "busy" },
  });

  const rateLimitedTask = createQueuedTask(queue, { taskType: "limited" });
  queue.transitionTask(rateLimitedTask.id, "rate_limited", {
    waitingFor: { kind: "rate_limit", id: "cardtrader", message: "limited" },
    rateLimitInfo: { blocked: true },
    nextAttemptAt: Date.now() + 60_000,
  });

  const retryingTask = createQueuedTask(queue, { taskType: "retrying" });
  queue.transitionTask(retryingTask.id, "running");
  queue.transitionTask(retryingTask.id, "retrying", {
    error: new Error("temporary"),
    nextAttemptAt: Date.now() + 60_000,
  });

  const doneTask = createQueuedTask(queue, { taskType: "done" });
  queue.transitionTask(doneTask.id, "running");
  queue.transitionTask(doneTask.id, "completed", { result: { ok: true } });

  const failedTask = createQueuedTask(queue, { taskType: "failed" });
  queue.transitionTask(failedTask.id, "running");
  queue.transitionTask(failedTask.id, "failed", { error: new Error("fail") });

  const cancelledTask = createQueuedTask(queue, { taskType: "cancelled" });
  queue.transitionTask(cancelledTask.id, "cancelled");

  const stats = queue.getQueueStats();
  assert.equal(stats.runningCount, 1);
  assert.equal(stats.pendingCount, 4);
  assert.equal(stats.queuedCount, 1);
  assert.equal(stats.waitingResourceCount, 1);
  assert.equal(stats.rateLimitedCount, 1);
  assert.equal(stats.retryingCount, 1);
  assert.equal(stats.completedCount, 1);
  assert.equal(stats.failedCount, 1);
  assert.equal(stats.cancelledCount, 1);
  assert.equal(stats.concurrencyLimit, 2);
  assert.equal(stats.maxPending, 5);
  assert.equal(stats.availableSlots, 1);
  assert.equal(stats.isBackpressureActive, false);

  runningDeferred.resolve();
  await waitFor(() => queue.getTask(runningTask.id).status === "completed");
});

test("un task rate-limited su CardTrader non blocca un task non CardTrader", async () => {
  cardTraderRateLimiter.blockedUntil = Date.now() + 250;

  let cardStarted = false;
  let localStarted = false;
  const localDeferred = createDeferred();

  const queue = createQueue(
    [
      taskDefinition({
        taskType: "card",
        endpoint: "/card",
        description: "Card",
        weight: 1,
        resources: ["cardtrader"],
        concurrencyGroup: "cardtrader-test",
        rateLimitGroup: "cardtrader",
        timeoutMs: 5_000,
      }),
      taskDefinition({
        taskType: "local",
        endpoint: "/local",
        description: "Local",
        weight: 5,
        timeoutMs: 5_000,
      }),
    ],
    { concurrency: 2 },
  );

  queue.registerHandler("card", async () => {
    cardStarted = true;
  });
  queue.registerHandler("local", async () => {
    localStarted = true;
    await localDeferred.promise;
  });

  queue.enqueue({ taskType: "card" });
  queue.enqueue({ taskType: "local" });

  await waitFor(() => localStarted === true);
  assert.equal(cardStarted, false);

  localDeferred.resolve();
  await waitFor(() => queue.listTasks({ statuses: ["completed"] }).length === 2, {
    timeoutMs: 3_000,
  });
});

test("il lock CardTrader lascia partire altri task senza quella risorsa", async () => {
  let cardStarted = 0;
  let localStarted = false;
  const firstCardDeferred = createDeferred();
  const localDeferred = createDeferred();

  const queue = createQueue(
    [
      taskDefinition({
        taskType: "card",
        endpoint: "/card",
        description: "Card",
        weight: 1,
        resources: ["cardtrader"],
        concurrencyGroup: "cardtrader-test",
        rateLimitGroup: "cardtrader",
        timeoutMs: 5_000,
      }),
      taskDefinition({
        taskType: "local",
        endpoint: "/local",
        description: "Local",
        weight: 2,
        timeoutMs: 5_000,
      }),
    ],
    { concurrency: 2 },
  );

  queue.registerHandler("card", async () => {
    cardStarted += 1;
    if (cardStarted === 1) {
      await firstCardDeferred.promise;
    }
  });
  queue.registerHandler("local", async () => {
    localStarted = true;
    await localDeferred.promise;
  });

  const first = queue.enqueue({ taskType: "card" });
  const second = queue.enqueue({ taskType: "card" });
  queue.enqueue({ taskType: "local" });

  await waitFor(() => localStarted === true);
  assert.equal(cardStarted, 1);

  const secondTask = queue.getTask(second.task.id);
  assert.equal(secondTask.status, "waiting_resource");

  localDeferred.resolve();
  firstCardDeferred.resolve();

  await waitFor(() => cardStarted === 2);
  const firstTask = queue.getTask(first.task.id);
  assert.equal(firstTask.status, "completed");
});

test("retry e backoff controllato completano il task al secondo tentativo", async () => {
  let attempts = 0;
  const queue = createQueue([
    taskDefinition({
      taskType: "retryable",
      endpoint: "/retryable",
      description: "Retryable",
      weight: 3,
      timeoutMs: 5_000,
      maxRetries: 1,
    }),
  ]);

  queue.registerHandler("retryable", async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new Error("boom");
    }
    return { ok: true };
  });

  const { task } = queue.enqueue({ taskType: "retryable" });
  await waitFor(() => {
    const latestTask = queue.getTask(task.id);
    return latestTask?.status === "completed";
  }, {
    timeoutMs: 4_000,
  });

  const completedTask = queue.getTask(task.id);
  assert.equal(completedTask.retryCount, 1);
  assert.deepEqual(completedTask.result, { ok: true });
});

test("deduplica due enqueue con la stessa idempotency key", async () => {
  const deferred = createDeferred();
  const queue = createQueue([
    taskDefinition({
      taskType: "dedupe",
      endpoint: "/dedupe",
      description: "Dedupe",
      weight: 1,
      timeoutMs: 5_000,
    }),
  ]);

  queue.registerHandler("dedupe", async () => {
    await deferred.promise;
  });

  const first = queue.enqueue({
    taskType: "dedupe",
    idempotencyKey: "same-key",
  });
  const second = queue.enqueue({
    taskType: "dedupe",
    idempotencyKey: "same-key",
  });

  assert.equal(second.deduplicated, true);
  assert.equal(second.task.id, first.task.id);
  assert.equal(queue.listTasks({ limit: 10 }).length, 1);

  deferred.resolve();
  await waitFor(() => queue.getTask(first.task.id)?.status === "completed");
});

test("state machine aggiorna timestamp e modello pubblico in modo coerente", () => {
  const queue = createQueue(
    [
      taskDefinition({
        taskType: "stateful",
        endpoint: "/stateful",
        maxRetries: 1,
      }),
    ],
    { autoStart: false },
  );
  const task = createQueuedTask(queue);

  let publicTask = queue.getTask(task.id);
  assert.equal(publicTask.status, "queued");
  assert.ok(publicTask.createdAt);
  assert.ok(publicTask.lastTransitionAt);
  assert.deepEqual(publicTask.payloadSummary, { safe: true });
  assert.equal(publicTask._payload, undefined);

  queue.transitionTask(task.id, "running");
  publicTask = queue.getTask(task.id);
  assert.equal(publicTask.status, "running");
  assert.ok(publicTask.startedAt);
  assert.equal(publicTask.attempts, 1);
  assert.equal(publicTask.waitingFor, null);

  queue.transitionTask(task.id, "completed", { result: { ok: true } });
  publicTask = queue.getTask(task.id);
  assert.equal(publicTask.status, "completed");
  assert.ok(publicTask.completedAt);
  assert.deepEqual(publicTask.result, { ok: true });
  assert.equal(publicTask.error, null);
});

test("state machine gestisce failed, retrying, waiting_resource, rate_limited e cancelled", () => {
  const queue = createQueue(
    [
      taskDefinition({
        taskType: "stateful",
        endpoint: "/stateful",
        maxRetries: 2,
      }),
    ],
    { autoStart: false },
  );

  const failedTask = createQueuedTask(queue);
  queue.transitionTask(failedTask.id, "running");
  queue.transitionTask(failedTask.id, "failed", {
    error: Object.assign(new Error("boom"), { code: "TEST" }),
  });
  let publicTask = queue.getTask(failedTask.id);
  assert.equal(publicTask.status, "failed");
  assert.ok(publicTask.failedAt);
  assert.deepEqual(publicTask.error, {
    message: "boom",
    code: "TEST",
    retryable: false,
    details: {
      name: "Error",
      statusCode: null,
    },
    occurredAt: publicTask.error.occurredAt,
  });
  assert.ok(publicTask.error.occurredAt);

  const retryingTask = createQueuedTask(queue);
  queue.transitionTask(retryingTask.id, "running");
  queue.transitionTask(retryingTask.id, "retrying", {
    error: new Error("temporary"),
    nextAttemptAt: Date.now() + 1_000,
  });
  publicTask = queue.getTask(retryingTask.id);
  assert.equal(publicTask.status, "retrying");
  assert.equal(publicTask.retryCount, 1);
  assert.equal(publicTask.error.retryable, true);
  assert.ok(publicTask.nextAttemptAt);

  const waitingTask = createQueuedTask(queue);
  queue.transitionTask(waitingTask.id, "waiting_resource", {
    waitingFor: { kind: "resource", id: "database", message: "busy" },
  });
  publicTask = queue.getTask(waitingTask.id);
  assert.equal(publicTask.status, "waiting_resource");
  assert.deepEqual(publicTask.waitingFor, {
    kind: "resource",
    id: "database",
    message: "busy",
  });

  queue.transitionTask(waitingTask.id, "queued");
  assert.equal(queue.getTask(waitingTask.id).waitingFor, null);

  const rateLimitedTask = createQueuedTask(queue);
  queue.transitionTask(rateLimitedTask.id, "rate_limited", {
    waitingFor: { kind: "rate_limit", id: "cardtrader", message: "limited" },
    rateLimitInfo: { blockedUntil: "soon" },
    nextAttemptAt: Date.now() + 1_000,
  });
  publicTask = queue.getTask(rateLimitedTask.id);
  assert.equal(publicTask.status, "rate_limited");
  assert.deepEqual(publicTask.rateLimitInfo, { blockedUntil: "soon" });

  const cancelledTask = createQueuedTask(queue);
  queue.transitionTask(cancelledTask.id, "cancelled");
  publicTask = queue.getTask(cancelledTask.id);
  assert.equal(publicTask.status, "cancelled");
  assert.ok(publicTask.cancelledAt);
});

test("state machine rifiuta status e transizioni non validi", () => {
  const queue = createQueue(
    [
      taskDefinition({
        taskType: "stateful",
        endpoint: "/stateful",
      }),
    ],
    { autoStart: false },
  );
  const task = createQueuedTask(queue);

  assert.throws(
    () => queue.transitionTask(task.id, "completed"),
    /Transizione task non consentita: queued -> completed/,
  );

  assert.throws(
    () => queue.transitionTask(task.id, "unknown"),
    /Status task non valido: unknown/,
  );
});

test("rifiuta taskType sconosciuti prima di accodare", () => {
  const queue = createQueue([
    taskDefinition({
      taskType: "known",
      endpoint: "/known",
    }),
  ]);
  queue.registerHandler("known", async () => ({ ok: true }));

  assert.throws(
    () => queue.enqueue({ taskType: "unknown" }),
    /Task type non supportato: unknown/,
  );
});

test("peso, risorse, concorrenza, timeout e retry arrivano dal registry", () => {
  const queue = createQueue([
    taskDefinition({
      taskType: "catalogued",
      endpoint: "/catalogued",
      weight: 2,
      resources: ["local", "database"],
      concurrencyGroup: "catalogued-group",
      timeoutMs: 7_000,
      maxRetries: 4,
      retryBackoff: { strategy: "linear", baseDelayMs: 200, maxDelayMs: 1_000 },
      idempotency: {
        required: false,
        strategy: "client-key",
        keySource: "header:Idempotency-Key",
      },
    }),
  ]);
  queue.registerHandler("catalogued", async () => ({ ok: true }));

  const { task } = queue.enqueue({
    taskType: "catalogued",
    weight: 99,
    timeoutMs: 1,
    maxRetries: 99,
    resources: ["client-controlled"],
    concurrencyGroup: "client-controlled",
  });

  assert.equal(task.weight, 2);
  assert.deepEqual(task.resources, ["local", "database"]);
  assert.equal(task.concurrencyGroup, "catalogued-group");
  assert.equal(task.timeoutMs, 7_000);
  assert.equal(task.maxRetries, 4);
  assert.deepEqual(task.retryBackoff, {
    strategy: "linear",
    baseDelayMs: 200,
    maxDelayMs: 1_000,
  });
  assert.deepEqual(task.idempotency, {
    required: false,
    strategy: "client-key",
    keySource: "header:Idempotency-Key",
  });
});

test("il registry ufficiale e valido e i task CardTrader dichiarano le policy richieste", () => {
  const definitions = listTaskDefinitions();
  assert.deepEqual(validateTaskDefinitions(definitions), []);

  const cardTraderDefinitions = definitions.filter((definition) =>
    definition.resources.includes("cardtrader"),
  );

  assert.ok(cardTraderDefinitions.length > 0);
  for (const definition of cardTraderDefinitions) {
    assert.equal(definition.rateLimitGroup, "cardtrader");
    assert.match(definition.concurrencyGroup, /^cardtrader/);
    assert.equal(definition.idempotency.required, true);
  }
});

test("gli endpoint Express che accodano task usano taskType registrati", async () => {
  const registryTaskTypes = new Set(
    listTaskDefinitions().map((definition) => definition.taskType),
  );
  const cardTraderRoute = await fs.readFile(
    path.join(__dirname, "..", "routes", "cardtrader.js"),
    "utf8",
  );
  const excelRoute = await fs.readFile(
    path.join(__dirname, "..", "routes", "excel.js"),
    "utf8",
  );

  assert.match(cardTraderRoute, /getCardTraderTaskDefinition/);
  assert.match(cardTraderRoute, /taskType: definition\.taskType/);
  assert.match(excelRoute, /getTaskDefinition\(taskType\)/);
  assert.ok(registryTaskTypes.has("excel.convert-to-pdf"));
});

test("API task espone payloadSummary ma non payload interno", async () => {
  const task = requestQueueModule.buildTask({
    taskType: "excel.convert-to-pdf",
    requestId: "api-payload-test",
    sourceEndpoint: "/api/excel/convert-to-pdf",
    payload: {
      uploadedFilePath: "/tmp/private/input.xlsx",
      secretToken: "non-deve-uscire",
    },
    payloadSummary: {
      originalFilename: "input.xlsx",
      uploadedFilePath: "/tmp/private/input.xlsx",
    },
  });
  requestQueueModule.tasks.set(task.id, task);
  requestQueueModule.transitionTask(task.id, "queued");

  const app = createApp();
  const server = await new Promise((resolve) => {
    const nextServer = app.listen(0, "127.0.0.1", () => resolve(nextServer));
  });

  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/tasks/${task.id}`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.task.requestId, "api-payload-test");
    assert.deepEqual(body.task.payloadSummary, {
      originalFilename: "input.xlsx",
      uploadedFilePath: "/tmp/private/input.xlsx",
    });
    assert.equal(body.task._payload, undefined);
    assert.equal(body.task.payload, undefined);
    assert.equal(JSON.stringify(body).includes("non-deve-uscire"), false);
  } finally {
    requestQueueModule.tasks.delete(task.id);
    if (
      task.dedupeKey &&
      requestQueueModule.dedupeIndex.get(task.dedupeKey) === task.id
    ) {
      requestQueueModule.dedupeIndex.delete(task.dedupeKey);
    }
    await new Promise((resolve) => server.close(resolve));
  }
});

test("API enqueue restituisce 429 quando la coda e piena", async () => {
  const originalMaxPendingTasks = requestQueueModule.maxPendingTasks;
  requestQueueModule.maxPendingTasks = 0;

  const app = createApp();
  const server = await new Promise((resolve) => {
    const nextServer = app.listen(0, "127.0.0.1", () => resolve(nextServer));
  });

  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-cardtrader-token": "test-token",
      },
      body: JSON.stringify({
        taskType: "cardtrader.align-prices",
        payload: {},
      }),
    });
    const body = await response.json();

    assert.equal(response.status, 429);
    assert.equal(response.headers.get("Retry-After"), "60");
    assert.equal(body.ok, false);
    assert.equal(body.code, "QUEUE_FULL");
    assert.match(body.error, /coda di elaborazione/i);
  } finally {
    requestQueueModule.maxPendingTasks = originalMaxPendingTasks;
    await new Promise((resolve) => server.close(resolve));
  }
});

test("la documentazione endpoint/pesi e coerente con il registry", async () => {
  const documentationPath = path.join(
    __dirname,
    "..",
    "docs",
    "endpoint-weights.md",
  );
  const fileContent = await fs.readFile(documentationPath, "utf8");

  assert.equal(fileContent, generateEndpointWeightsDoc());
  assert.match(fileContent, /\| Task type \| Endpoint \| Metodo HTTP \|/);
  assert.match(fileContent, /cardtrader\.align-prices/);
  assert.match(fileContent, /\/api\/tasks\/:taskId\/result/);
});
