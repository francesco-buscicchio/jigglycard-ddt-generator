const test = require("node:test");
const assert = require("node:assert/strict");
const { RequestQueue } = require("../services/requestQueue");

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

// Store finto con la stessa interfaccia di MongoTaskStore: permette di testare
// persistenza e recovery senza un'istanza Mongo reale.
class FakeTaskStore {
  constructor() {
    this.documents = new Map();
  }

  isReady() {
    return true;
  }

  saveTask(taskDocument) {
    this.documents.set(taskDocument._id, structuredClone(taskDocument));
    return Promise.resolve();
  }

  deleteTask(taskId) {
    this.documents.delete(taskId);
    return Promise.resolve();
  }

  async loadTasks({ historyLimit = 250 } = {}) {
    const allDocuments = [...this.documents.values()];
    const openTasks = allDocuments.filter(
      (document) => !TERMINAL_STATUSES.has(document.status),
    );
    const terminalTasks = allDocuments
      .filter((document) => TERMINAL_STATUSES.has(document.status))
      .sort((left, right) => right.sequence - left.sequence)
      .slice(0, historyLimit);

    return [...openTasks, ...terminalTasks].sort(
      (left, right) => left.sequence - right.sequence,
    );
  }

  async flush() {}
}

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

test("persiste il task nello store ad ogni transizione di stato", async () => {
  const store = new FakeTaskStore();
  const queue = createQueue([taskDefinition({ taskType: "persist.me" })], {
    store,
  });
  queue.registerHandler("persist.me", async () => ({ done: true }));

  const { task } = queue.enqueueTask({
    taskType: "persist.me",
    requestId: "req-1",
    payload: { alpha: 1 },
    requestEnv: { dbName: "CMS" },
  });

  await waitFor(() => store.documents.get(task.id)?.status === "completed");

  const persistedDocument = store.documents.get(task.id);
  assert.equal(persistedDocument._id, task.id);
  assert.deepEqual(persistedDocument.payload, { alpha: 1 });
  assert.deepEqual(persistedDocument.requestEnv, { dbName: "CMS" });
  assert.deepEqual(persistedDocument.result, { done: true });
  assert.equal(persistedDocument._execution, undefined);
  queue.stopScheduler();
});

test("recovery post-restart: un task running torna queued e viene rieseguito", async () => {
  const store = new FakeTaskStore();
  const blockForever = createDeferred();

  const crashedQueue = createQueue([taskDefinition({ taskType: "long.job" })], {
    store,
  });
  crashedQueue.registerHandler("long.job", () => blockForever.promise);
  const { task } = crashedQueue.enqueueTask({
    taskType: "long.job",
    requestId: "req-crash",
    payload: { round: 1 },
  });

  await waitFor(() => store.documents.get(task.id)?.status === "running");
  crashedQueue.stopScheduler();

  // "Restart": nuova coda, stesso store.
  const recoveredQueue = createQueue([taskDefinition({ taskType: "long.job" })], {
    store,
    autoStart: false,
  });
  recoveredQueue.registerHandler("long.job", async ({ payload }) => ({
    resumed: payload.round,
  }));

  const { restoredCount, requeuedCount } = await recoveredQueue.restoreFromStore();
  assert.equal(restoredCount, 1);
  assert.equal(requeuedCount, 1);
  assert.equal(recoveredQueue.getTask(task.id).status, "queued");

  recoveredQueue.startScheduler();
  await waitFor(
    () => recoveredQueue.getTask(task.id)?.status === "completed",
  );
  assert.deepEqual(recoveredQueue.getTask(task.id).result, { resumed: 1 });

  // La sequence riparte dal massimo ripristinato: nessuna collisione di id.
  const { task: nextTask } = recoveredQueue.enqueueTask({
    taskType: "long.job",
    requestId: "req-next",
  });
  assert.notEqual(nextTask.id, task.id);
  assert.ok(nextTask.sequenceNumber > recoveredQueue.getTask(task.id).sequenceNumber);
  recoveredQueue.stopScheduler();
});

test("recovery ripristina il dedupe index: stessa idempotency key non duplica", async () => {
  const store = new FakeTaskStore();

  const firstQueue = createQueue([taskDefinition({ taskType: "dedupe.job" })], {
    store,
    autoStart: false,
  });
  firstQueue.registerHandler("dedupe.job", async () => ({ ok: true }));
  const { task } = firstQueue.enqueueTask({
    taskType: "dedupe.job",
    requestId: "req-a",
    idempotencyKey: "stessa-chiave",
  });

  const recoveredQueue = createQueue([taskDefinition({ taskType: "dedupe.job" })], {
    store,
    autoStart: false,
  });
  recoveredQueue.registerHandler("dedupe.job", async () => ({ ok: true }));
  await recoveredQueue.restoreFromStore();

  const { task: dedupedTask, deduplicated } = recoveredQueue.enqueueTask({
    taskType: "dedupe.job",
    requestId: "req-b",
    idempotencyKey: "stessa-chiave",
  });

  assert.equal(deduplicated, true);
  assert.equal(dedupedTask.id, task.id);
});

test("recovery conserva la storia terminale con i risultati", async () => {
  const store = new FakeTaskStore();
  store.documents.set("task-7", {
    _id: "task-7",
    id: "task-7",
    sequence: 7,
    taskType: "old.job",
    status: "completed",
    weight: 5,
    createdAt: "2026-07-01T10:00:00.000Z",
    startedAt: "2026-07-01T10:00:01.000Z",
    completedAt: "2026-07-01T10:00:05.000Z",
    retryCount: 0,
    maxRetries: 0,
    result: { archived: true },
    events: [],
    payload: {},
    requestEnv: {},
    resources: [],
    concurrencyGroup: null,
  });

  const queue = createQueue([taskDefinition({ taskType: "old.job" })], {
    store,
    autoStart: false,
  });
  queue.registerHandler("old.job", async () => ({ ok: true }));
  await queue.restoreFromStore();

  const restoredTask = queue.getTask("task-7");
  assert.equal(restoredTask.status, "completed");
  assert.deepEqual(restoredTask.result, { archived: true });
  assert.equal(queue.sequence, 7);
});

test("pruneHistory elimina i documenti persistiti oltre il limite", async () => {
  const store = new FakeTaskStore();
  const queue = createQueue([taskDefinition({ taskType: "prune.job" })], {
    store,
    autoStart: false,
    historyLimit: 10,
  });
  queue.registerHandler("prune.job", async () => ({ ok: true }));

  for (let index = 0; index < 15; index += 1) {
    const { task } = queue.enqueueTask({
      taskType: "prune.job",
      requestId: `req-${index}`,
    });
    queue.transitionTask(task.id, "cancelled");
  }

  queue.pruneHistory();
  assert.equal(queue.tasks.size, 10);
  assert.equal(store.documents.size, 10);
});
