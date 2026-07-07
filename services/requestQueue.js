const fsPromises = require("fs/promises");
const {
  REQUEST_QUEUE_CONCURRENCY,
  TASK_QUEUE_MAX_PENDING,
  TASK_QUEUE_HISTORY_LIMIT,
  TASK_QUEUE_DEFAULT_TIMEOUT_MS,
  TASK_RESOURCE_CAPACITIES,
  TASK_CONCURRENCY_GROUP_CAPACITIES,
} = require("../config/config");
const {
  assertValidTaskDefinitions,
  listTaskDefinitions,
} = require("../config/taskDefinitions");
const { isAbortError, createAbortError } = require("../utils/abort");
const { cardTraderRateLimiter } = require("./cardTraderService");
const alignPriceService = require("./alignPrice");
const snifferService = require("./snifferService");
const { executeExcelConversionTask } = require("./excelConversionService");
const { updateBooster } = require("../utils/updateBoosterInMongo");
const shopifySyncService = require("./shopifySyncService");

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const TASK_STATUSES = new Set([
  "pending",
  "queued",
  "running",
  "waiting_resource",
  "rate_limited",
  "retrying",
  "completed",
  "failed",
  "cancelled",
]);
const PENDING_STATUSES = new Set([
  "pending",
  "queued",
  "waiting_resource",
  "rate_limited",
  "retrying",
]);
const VALID_TASK_TRANSITIONS = {
  pending: new Set(["queued", "cancelled"]),
  queued: new Set(["running", "waiting_resource", "rate_limited", "cancelled"]),
  waiting_resource: new Set(["queued", "cancelled"]),
  rate_limited: new Set(["queued", "cancelled"]),
  retrying: new Set(["queued", "cancelled"]),
  running: new Set(["completed", "retrying", "failed", "cancelled"]),
  completed: new Set([]),
  failed: new Set([]),
  cancelled: new Set([]),
};

class QueueBackpressureError extends Error {
  constructor({ maxPendingTasks, pendingCount, retryAfterSeconds = 60 } = {}) {
    super(
      `Coda piena: ${pendingCount} task pendenti su massimo ${maxPendingTasks}.`,
    );
    this.name = "QueueBackpressureError";
    this.code = "QUEUE_FULL";
    this.statusCode = 429;
    this.userMessage =
      "La coda di elaborazione e temporaneamente piena. Riprova tra qualche minuto.";
    this.retryAfterSeconds = retryAfterSeconds;
    this.details = {
      maxPendingTasks,
      pendingCount,
    };
  }
}

const QueueCapacityError = QueueBackpressureError;

class TaskNotFoundError extends Error {
  constructor(taskId) {
    super(`Task non trovato: ${taskId}`);
    this.name = "TaskNotFoundError";
    this.statusCode = 404;
  }
}

class TaskConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = "TaskConflictError";
    this.statusCode = 409;
  }
}

class TaskTransitionError extends Error {
  constructor(message) {
    super(message);
    this.name = "TaskTransitionError";
    this.statusCode = 409;
  }
}

class UnsupportedTaskTypeError extends Error {
  constructor(taskType) {
    super(`Task type non supportato: ${taskType}`);
    this.name = "UnsupportedTaskTypeError";
    this.statusCode = 400;
  }
}

function toIso(value) {
  return value ? new Date(value).toISOString() : null;
}

function serializeError(error, { retryable = false } = {}) {
  if (!error) return null;

  return {
    message: error.message ?? "Errore sconosciuto",
    code: error.code ?? null,
    retryable,
    details: {
      name: error.name ?? "Error",
      statusCode: error.statusCode ?? error.response?.status ?? null,
    },
    occurredAt: toIso(Date.now()),
  };
}

function sanitizeResult(result) {
  if (typeof result === "undefined") return null;
  if (result === null) return null;
  if (typeof result === "string") return result;
  if (Array.isArray(result)) return result;
  if (typeof result === "object") return result;
  return { value: result };
}

function compareTasksForScheduling(left, right) {
  if (left.weight !== right.weight) {
    return left.weight - right.weight;
  }

  return left.sequence - right.sequence;
}

function sortTasksForScheduling(tasks = []) {
  return tasks.sort((left, right) => {
    return compareTasksForScheduling(left, right);
  });
}

function getRetryDelayMs(task) {
  const retryBackoff = task.retryBackoff ?? {};
  if (retryBackoff.strategy === "none") return 0;

  const baseDelayMs = Math.max(0, Number(retryBackoff.baseDelayMs) || 1_000);
  const maxDelayMs = Math.max(baseDelayMs, Number(retryBackoff.maxDelayMs) || 30_000);

  if (retryBackoff.strategy === "linear") {
    return Math.min(maxDelayMs, baseDelayMs * (task.retryCount + 1));
  }

  return Math.min(maxDelayMs, baseDelayMs * 2 ** task.retryCount);
}

function assertValidStatus(status) {
  if (!TASK_STATUSES.has(status)) {
    throw new TaskTransitionError(`Status task non valido: ${status}`);
  }
}

function canTransitionTask(currentStatus, nextStatus) {
  assertValidStatus(currentStatus);
  assertValidStatus(nextStatus);
  return VALID_TASK_TRANSITIONS[currentStatus]?.has(nextStatus) === true;
}

function normalizeCapacityConfig(capacities = {}) {
  const normalized = {};

  for (const [id, value] of Object.entries(capacities)) {
    const capacity =
      typeof value === "object" && value !== null ? value.capacity : value;
    const parsedCapacity = Math.floor(Number(capacity));
    normalized[id] = {
      capacity:
        Number.isFinite(parsedCapacity) && parsedCapacity > 0
          ? parsedCapacity
          : 1,
    };
  }

  return normalized;
}

class RequestQueue {
  constructor({
    concurrency = REQUEST_QUEUE_CONCURRENCY,
    maxPendingTasks = TASK_QUEUE_MAX_PENDING,
    historyLimit = TASK_QUEUE_HISTORY_LIMIT,
    defaultTimeoutMs = TASK_QUEUE_DEFAULT_TIMEOUT_MS,
    groupLimits = {},
    resourceLimits = {},
    taskDefinitions = listTaskDefinitions(),
    store = null,
  } = {}) {
    this.concurrency = Math.max(1, Number(concurrency) || 1);
    this.maxPendingTasks = Math.max(1, Number(maxPendingTasks) || 1);
    this.historyLimit = Math.max(10, Number(historyLimit) || 10);
    this.defaultTimeoutMs = Math.max(1_000, Number(defaultTimeoutMs) || 1_000);
    this.groupLimits = {
      ...Object.fromEntries(
        Object.entries(TASK_CONCURRENCY_GROUP_CAPACITIES).map(([id, capacity]) => [
          id,
          Math.max(1, Number(capacity) || 1),
        ]),
      ),
      ...groupLimits,
    };
    this.resourceLimits = {
      ...normalizeCapacityConfig(TASK_RESOURCE_CAPACITIES),
      ...normalizeCapacityConfig(resourceLimits),
    };

    this.sequence = 0;
    this.tasks = new Map();
    this.taskDefinitions = new Map();
    this.taskHandlers = new Map();
    this.dedupeIndex = new Map();
    this.activeTaskIds = new Set();
    this.resourceUsage = new Map();
    this.groupUsage = new Map();
    this.store = store;
    this.timingStats = new Map();
    this.schedulerTimer = null;
    this.schedulerScheduled = false;
    this.schedulerStarted = false;
    this.schedulerRunning = false;

    assertValidTaskDefinitions(taskDefinitions, {
      knownResources: new Set(Object.keys(this.resourceLimits)),
      knownConcurrencyGroups: new Set(Object.keys(this.groupLimits)),
    });

    for (const definition of taskDefinitions) {
      this.taskDefinitions.set(definition.taskType, definition);
    }

    this.recordQueueEvent("resource_capacity_config_loaded", {
      resources: Object.fromEntries(
        Object.entries(this.resourceLimits).map(([id, config]) => [
          id,
          config.capacity,
        ]),
      ),
      concurrencyGroups: this.groupLimits,
    });
  }

  registerHandler(taskType, handler) {
    this.taskHandlers.set(taskType, handler);
  }

  attachStore(store) {
    this.store = store;
  }

  serializeTaskForStore(task) {
    const { _execution, _payload, _requestEnv, ...persistedFields } = task;
    return {
      _id: task.id,
      ...persistedFields,
      payload: _payload ?? {},
      requestEnv: _requestEnv ?? {},
      events: task.events.slice(-100),
    };
  }

  persistTask(task) {
    if (!this.store) return;
    this.store.saveTask(this.serializeTaskForStore(task));
  }

  hydrateTaskFromStore(document) {
    const { _id, payload, requestEnv, ...taskFields } = document;
    return {
      ...taskFields,
      id: _id,
      events: Array.isArray(document.events) ? document.events : [],
      _payload: payload ?? {},
      _requestEnv: requestEnv ?? {},
      _execution: null,
    };
  }

  // Recovery post-restart (VN-16): ricarica i task dallo store. I task che
  // risultavano `pending` o `running` al momento del crash tornano `queued`;
  // gli altri stati non terminali vengono ripresi così com'erano e gestiti
  // dal normale ciclo dello scheduler (promoteDueTasks).
  async restoreFromStore() {
    if (!this.store) return { restoredCount: 0, requeuedCount: 0 };

    const documents = await this.store.loadTasks({
      historyLimit: this.historyLimit,
    });

    let requeuedCount = 0;
    for (const document of documents) {
      const task = this.hydrateTaskFromStore(document);
      if (!TASK_STATUSES.has(task.status)) continue;

      const isTerminal = TERMINAL_STATUSES.has(task.status);
      if (!isTerminal && !this.taskHandlers.has(task.taskType)) {
        task.status = "failed";
        task.failedAt = toIso(Date.now());
        task.error = serializeError(
          new Error(`Handler non registrato dopo il restart: ${task.taskType}`),
        );
      } else if (task.status === "running" || task.status === "pending") {
        task.status = "queued";
        task.waitingFor = null;
        task.rateLimitInfo = null;
        task.nextAttemptAt = null;
        requeuedCount += 1;
      }

      this.tasks.set(task.id, task);
      this.sequence = Math.max(this.sequence, Number(task.sequence) || 0);

      if (task.dedupeKey && !TERMINAL_STATUSES.has(task.status)) {
        this.dedupeIndex.set(task.dedupeKey, task.id);
      }

      if (task.status !== document.status) {
        this.recordEvent(task, "recovered_after_restart", {
          previousStatus: document.status,
        });
        this.persistTask(task);
      }
    }

    this.recordQueueEvent("queue_restored_from_store", {
      restoredCount: documents.length,
      requeuedCount,
      pendingCount: this.getPendingCount(),
      sequence: this.sequence,
    });
    this.scheduleScheduler();

    return { restoredCount: documents.length, requeuedCount };
  }

  recordTaskTiming(task) {
    const startedAt = task.startedAt ? Date.parse(task.startedAt) : null;
    const createdAt = task.createdAt ? Date.parse(task.createdAt) : null;
    const completedAt = task.completedAt ? Date.parse(task.completedAt) : null;
    if (!startedAt || !completedAt) return;

    const executionMs = Math.max(0, completedAt - startedAt);
    const waitMs = createdAt ? Math.max(0, startedAt - createdAt) : 0;

    for (const key of ["_global", task.taskType]) {
      const stats = this.timingStats.get(key) ?? {
        completedCount: 0,
        totalExecutionMs: 0,
        totalWaitMs: 0,
      };
      stats.completedCount += 1;
      stats.totalExecutionMs += executionMs;
      stats.totalWaitMs += waitMs;
      this.timingStats.set(key, stats);
    }
  }

  getTimingSnapshot() {
    const toAverages = (stats) => ({
      completedCount: stats.completedCount,
      avgExecutionMs: Math.round(stats.totalExecutionMs / stats.completedCount),
      avgWaitMs: Math.round(stats.totalWaitMs / stats.completedCount),
    });

    const byTaskType = {};
    let global = { completedCount: 0, avgExecutionMs: 0, avgWaitMs: 0 };

    for (const [key, stats] of this.timingStats.entries()) {
      if (stats.completedCount === 0) continue;
      if (key === "_global") {
        global = toAverages(stats);
      } else {
        byTaskType[key] = toAverages(stats);
      }
    }

    return { global, byTaskType };
  }

  getTaskDefinition(taskType) {
    return this.taskDefinitions.get(taskType) ?? null;
  }

  getPendingCount() {
    return [...this.tasks.values()].filter((task) => PENDING_STATUSES.has(task.status))
      .length;
  }

  getRunningCount() {
    return this.activeTaskIds.size;
  }

  getStatusCounts() {
    const statusCounts = {};
    for (const status of TASK_STATUSES) {
      statusCounts[status] = 0;
    }

    for (const task of this.tasks.values()) {
      statusCounts[task.status] = (statusCounts[task.status] ?? 0) + 1;
    }

    return statusCounts;
  }

  getQueueStats() {
    const statusCounts = this.getStatusCounts();
    const runningCount = this.getRunningCount();
    const pendingCount = this.getPendingCount();
    const availableSlots = Math.max(0, this.concurrency - runningCount);

    return {
      runningCount,
      pendingCount,
      queuedCount: statusCounts.queued ?? 0,
      waitingResourceCount: statusCounts.waiting_resource ?? 0,
      rateLimitedCount: statusCounts.rate_limited ?? 0,
      retryingCount: statusCounts.retrying ?? 0,
      completedCount: statusCounts.completed ?? 0,
      failedCount: statusCounts.failed ?? 0,
      cancelledCount: statusCounts.cancelled ?? 0,
      concurrencyLimit: this.concurrency,
      maxPending: this.maxPendingTasks,
      availableSlots,
      isBackpressureActive: pendingCount >= this.maxPendingTasks,
      resources: this.getResourceSnapshot(),
      concurrencyGroups: this.getConcurrencyGroupSnapshot(),
      timings: this.getTimingSnapshot(),
      statusCounts,
    };
  }

  getTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    return this.toPublicTask(task, { includeEvents: true });
  }

  listTasks({ statuses = null, taskType = null, requestId = null, limit = 50 } = {}) {
    const statusSet =
      Array.isArray(statuses) && statuses.length > 0 ? new Set(statuses) : null;

    if (statusSet) {
      for (const status of statusSet) {
        assertValidStatus(status);
      }
    }

    return [...this.tasks.values()]
      .filter((task) => {
        if (statusSet && !statusSet.has(task.status)) return false;
        if (taskType && task.taskType !== taskType) return false;
        if (requestId && task.requestId !== requestId) return false;
        return true;
      })
      .sort((left, right) => right.sequence - left.sequence)
      .slice(0, Math.max(1, Number(limit) || 50))
      .map((task) => this.toPublicTask(task));
  }

  toPublicTask(task, { includeEvents = false } = {}) {
    const pendingTasks = this.getPendingTasksSorted();
    const queuePosition = pendingTasks.findIndex((pendingTask) => pendingTask.id === task.id);

    const publicTask = {
      id: task.id,
      taskType: task.taskType,
      endpoint: task.endpoint,
      method: task.method,
      description: task.description,
      sourceEndpoint: task.sourceEndpoint,
      requestId: task.requestId,
      sequenceNumber: task.sequence,
      status: task.status,
      weight: task.weight,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      failedAt: task.failedAt,
      cancelledAt: task.cancelledAt,
      updatedAt: task.updatedAt,
      lastTransitionAt: task.lastTransitionAt,
      timeoutMs: task.timeoutMs,
      attempts: task.attempts,
      retryCount: task.retryCount,
      maxRetries: task.maxRetries,
      idempotency: task.idempotency,
      queuePosition: queuePosition >= 0 ? queuePosition + 1 : null,
      payloadSummary: task.payloadSummary,
      resources: task.resources,
      concurrencyGroup: task.concurrencyGroup,
      rateLimitGroup: task.rateLimitGroup,
      retryBackoff: task.retryBackoff,
      waitingFor: task.waitingFor,
      nextAttemptAt: task.nextAttemptAt,
      rateLimitInfo: task.rateLimitInfo,
      error: task.error,
      result: task.result,
      dedupeKey: task.dedupeKey ?? null,
    };

    if (includeEvents) {
      publicTask.events = task.events.slice(-30);
    }

    return publicTask;
  }

  buildTask({
    taskType,
    requestId,
    sourceEndpoint,
    payload = {},
    payloadSummary = null,
    requestEnv = {},
    idempotencyKey = "",
    forceNew = false,
  }) {
    const definition = this.getTaskDefinition(taskType);
    if (!definition) {
      throw new UnsupportedTaskTypeError(taskType);
    }

    if (definition.enabled === false) {
      throw new TaskConflictError(`Task type disabilitato: ${taskType}`);
    }

    if (!this.taskHandlers.has(taskType)) {
      throw new Error(`Handler non registrato per task type: ${taskType}`);
    }

    const sequence = ++this.sequence;
    const taskId = `task-${sequence}`;
    const dedupeKey =
      String(idempotencyKey || "").trim() ||
      definition.buildDedupeKey?.({ payload, requestEnv, taskType }) ||
      "";

    if (definition.idempotency?.required && !dedupeKey) {
      throw new TaskConflictError(
        `Idempotenza obbligatoria non soddisfatta per task type: ${taskType}`,
      );
    }

    return {
      id: taskId,
      sequence,
      taskType,
      endpoint: definition.endpoint,
      method: definition.method,
      description: definition.description,
      sourceEndpoint: sourceEndpoint || definition.endpoint,
      requestId: requestId ?? null,
      weight: Number(definition.weight),
      status: "pending",
      timeoutMs: Math.max(1_000, Number(definition.timeoutMs)),
      attempts: 0,
      retryCount: 0,
      maxRetries: Math.max(0, Number(definition.maxRetries)),
      idempotency: { ...definition.idempotency },
      allowManualRetry: definition.allowManualRetry === true,
      createdAt: toIso(Date.now()),
      startedAt: null,
      completedAt: null,
      failedAt: null,
      cancelledAt: null,
      updatedAt: toIso(Date.now()),
      lastTransitionAt: toIso(Date.now()),
      nextAttemptAt: null,
      waitingFor: null,
      rateLimitInfo: null,
      error: null,
      result: null,
      resources: Array.isArray(definition.resources)
        ? definition.resources.slice()
        : [],
      concurrencyGroup: definition.concurrencyGroup ?? null,
      rateLimitGroup: definition.rateLimitGroup ?? null,
      retryBackoff: definition.retryBackoff ?? { strategy: "exponential" },
      payloadSummary:
        payloadSummary ??
        definition.buildPayloadSummary?.(payload, requestEnv) ??
        null,
      dedupeKey: dedupeKey || null,
      forceNew,
      events: [],
      _payload: payload,
      _requestEnv: requestEnv,
      _execution: null,
    };
  }

  enqueue(taskInput) {
    return this.enqueueTask(taskInput);
  }

  enqueueTask(taskInput) {
    const queueStats = this.getQueueStats();
    if (queueStats.isBackpressureActive) {
      this.recordQueueEvent("backpressure_rejected", {
        pendingCount: queueStats.pendingCount,
        maxPending: queueStats.maxPending,
      });
      throw new QueueBackpressureError({
        maxPendingTasks: this.maxPendingTasks,
        pendingCount: queueStats.pendingCount,
      });
    }

    const task = this.buildTask(taskInput);
    if (!task.forceNew && task.dedupeKey && this.dedupeIndex.has(task.dedupeKey)) {
      const existingTaskId = this.dedupeIndex.get(task.dedupeKey);
      const existingTask = this.tasks.get(existingTaskId);
      if (existingTask) {
        this.recordEvent(existingTask, "deduplicated", {
          dedupedByRequestId: task.requestId,
        });
        this.persistTask(existingTask);
        return {
          task: this.toPublicTask(existingTask, { includeEvents: true }),
          deduplicated: true,
        };
      }
    }

    this.tasks.set(task.id, task);
    if (task.dedupeKey) {
      this.dedupeIndex.set(task.dedupeKey, task.id);
    }

    this.recordEvent(task, "created", {
      requestId: task.requestId,
      taskType: task.taskType,
    });
    this.transitionTask(task.id, "queued");
    this.scheduleScheduler();
    return {
      task: this.toPublicTask(task, { includeEvents: true }),
      deduplicated: false,
    };
  }

  async cancel(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new TaskNotFoundError(taskId);
    }

    if (TERMINAL_STATUSES.has(task.status)) {
      throw new TaskTransitionError(
        `Cancel non consentito per task in stato terminale: ${task.status}.`,
      );
    }

    if (task.status === "running") {
      task._execution?.abortController?.abort(
        createAbortError("Task annullato manualmente."),
      );
      this.recordEvent(task, "cancellation_requested");
      return this.toPublicTask(task, { includeEvents: true });
    }

    this.transitionTask(task.id, "cancelled");
    this.pruneHistory();
    return this.toPublicTask(task, { includeEvents: true });
  }

  retry(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new TaskNotFoundError(taskId);
    }

    if (!task.allowManualRetry) {
      throw new TaskConflictError(
        `Retry manuale non consentito per task ${task.taskType}.`,
      );
    }

    if (task.status !== "failed" && task.status !== "cancelled") {
      throw new TaskConflictError(
        `Retry consentito solo per task failed/cancelled. Stato attuale: ${task.status}.`,
      );
    }

    return this.enqueueTask({
      taskType: task.taskType,
      requestId: task.requestId,
      sourceEndpoint: task.sourceEndpoint,
      payload: task._payload,
      requestEnv: task._requestEnv,
      payloadSummary: task.payloadSummary,
      idempotencyKey: "",
      forceNew: true,
    });
  }

  startScheduler() {
    this.schedulerStarted = true;
    this.scheduleScheduler();
  }

  stopScheduler() {
    this.schedulerStarted = false;
    this.schedulerScheduled = false;
    if (this.schedulerTimer) {
      clearTimeout(this.schedulerTimer);
      this.schedulerTimer = null;
    }
  }

  schedule(delayMs = 0) {
    this.scheduleScheduler(delayMs);
  }

  scheduleScheduler(delayMs = 0) {
    if (!this.schedulerStarted) return;

    if (delayMs > 0) {
      if (this.schedulerTimer) {
        clearTimeout(this.schedulerTimer);
      }

      this.schedulerTimer = setTimeout(() => {
        this.schedulerTimer = null;
        this.scheduleScheduler();
      }, delayMs);
      return;
    }

    if (this.schedulerScheduled) return;
    this.schedulerScheduled = true;
    setImmediate(() => {
      this.schedulerScheduled = false;
      this.runScheduler();
    });
  }

  getPendingTasksSorted() {
    return sortTasksForScheduling(
      [...this.tasks.values()].filter((task) => PENDING_STATUSES.has(task.status)),
    );
  }

  getQueuedTasksSorted() {
    return sortTasksForScheduling(
      [...this.tasks.values()].filter((task) => task.status === "queued"),
    );
  }

  promoteDueTasks(now = Date.now()) {
    let nextWakeInMs = null;

    for (const task of this.getPendingTasksSorted()) {
      if (task.status === "waiting_resource") {
        this.transitionTask(task, "queued");
        continue;
      }

      if (task.status !== "rate_limited" && task.status !== "retrying") {
        continue;
      }

      const nextAttemptAt = task.nextAttemptAt ? Date.parse(task.nextAttemptAt) : null;
      if (nextAttemptAt && nextAttemptAt > now) {
        const wakeInMs = nextAttemptAt - now;
        nextWakeInMs =
          nextWakeInMs === null ? wakeInMs : Math.min(nextWakeInMs, wakeInMs);
        continue;
      }

      this.transitionTask(task, "queued");
    }

    return nextWakeInMs;
  }

  canUseGroup(task) {
    if (!task.concurrencyGroup) return { ok: true };
    const limit = this.groupLimits[task.concurrencyGroup];
    if (!limit) {
      return {
        ok: false,
        reason: "unknown_concurrency_group",
        waitUntil: null,
        waitingFor: {
          kind: "concurrency_group",
          id: task.concurrencyGroup,
          message: `Gruppo di concorrenza non configurato: ${task.concurrencyGroup}.`,
        },
      };
    }

    const currentUsage = this.groupUsage.get(task.concurrencyGroup) ?? 0;
    if (currentUsage >= limit) {
      return {
        ok: false,
        reason: "group_busy",
        waitUntil: null,
        waitingFor: {
          kind: "concurrency_group",
          id: task.concurrencyGroup,
          message: `Limite gruppo ${task.concurrencyGroup} raggiunto.`,
        },
      };
    }

    return { ok: true };
  }

  canUseResources(task, now = Date.now()) {
    for (const resourceId of task.resources) {
      const config = this.resourceLimits[resourceId];
      if (!config) {
        return {
          ok: false,
          reason: "unknown_resource",
          waitUntil: null,
          waitingFor: {
            kind: "resource",
            id: resourceId,
            message: `Risorsa non configurata: ${resourceId}.`,
          },
        };
      }

      const resourceTasks = this.resourceUsage.get(resourceId) ?? new Set();

      if (resourceTasks.size >= config.capacity) {
        return {
          ok: false,
          reason: "resource_busy",
          waitUntil: null,
          waitingFor: {
            kind: "resource",
            id: resourceId,
            message: `Risorsa occupata: ${resourceId}.`,
          },
        };
      }

      if (resourceId === "cardtrader") {
        const waitMs = cardTraderRateLimiter.getWaitMs(now);
        if (waitMs > 0) {
          const rateLimitState = cardTraderRateLimiter.getState(now);
          return {
            ok: false,
            reason: "rate_limit",
            waitUntil: now + waitMs,
            waitingFor: {
              kind: "rate_limit",
              id: resourceId,
              message: "Rate limit CardTrader attivo.",
            },
            rateLimitInfo: rateLimitState,
          };
        }
      }
    }

    return { ok: true };
  }

  canAcquireResources(task, now = Date.now()) {
    const resourceCheck = this.canUseResources(task, now);
    if (!resourceCheck.ok) return resourceCheck;
    return this.canUseGroup(task);
  }

  acquireResources(task) {
    if (task.concurrencyGroup) {
      const currentUsage = this.groupUsage.get(task.concurrencyGroup) ?? 0;
      this.groupUsage.set(task.concurrencyGroup, currentUsage + 1);
    }

    for (const resourceId of task.resources) {
      const resourceTasks = this.resourceUsage.get(resourceId) ?? new Set();
      resourceTasks.add(task.id);
      this.resourceUsage.set(resourceId, resourceTasks);
    }

    this.recordQueueEvent("resources_acquired", {
      taskId: task.id,
      taskType: task.taskType,
      resources: task.resources,
      concurrencyGroup: task.concurrencyGroup,
    });
  }

  releaseResources(task) {
    if (task.concurrencyGroup) {
      const currentUsage = this.groupUsage.get(task.concurrencyGroup) ?? 0;
      if (currentUsage <= 1) {
        this.groupUsage.delete(task.concurrencyGroup);
      } else {
        this.groupUsage.set(task.concurrencyGroup, currentUsage - 1);
      }
    }

    for (const resourceId of task.resources) {
      const resourceTasks = this.resourceUsage.get(resourceId);
      if (!resourceTasks) continue;
      resourceTasks.delete(task.id);
      if (resourceTasks.size === 0) {
        this.resourceUsage.delete(resourceId);
      }
    }

    this.recordQueueEvent("resources_released", {
      taskId: task.id,
      taskType: task.taskType,
      resources: task.resources,
      concurrencyGroup: task.concurrencyGroup,
    });
  }

  acquireExecutionSlots(task) {
    this.activeTaskIds.add(task.id);
    this.acquireResources(task);
  }

  releaseExecutionSlots(task) {
    this.activeTaskIds.delete(task.id);
    this.releaseResources(task);
    this.recordQueueEvent("slot_released", {
      taskId: task.id,
      taskType: task.taskType,
      runningCount: this.getRunningCount(),
      concurrencyLimit: this.concurrency,
      pendingCount: this.getPendingCount(),
    });
  }

  getBlockingResource(task, now = Date.now()) {
    const check = this.canAcquireResources(task, now);
    return check.ok ? null : check.waitingFor;
  }

  transitionTask(taskIdOrTask, nextStatus, metadata = {}) {
    const task =
      typeof taskIdOrTask === "string" ? this.tasks.get(taskIdOrTask) : taskIdOrTask;
    if (!task) {
      throw new TaskNotFoundError(taskIdOrTask);
    }

    assertValidStatus(nextStatus);

    const previousStatus = task.status;
    const nextAttemptAt = metadata.nextAttemptAt
      ? toIso(metadata.nextAttemptAt)
      : null;
    const waitingFor = metadata.waitingFor ?? null;
    const rateLimitInfo = metadata.rateLimitInfo ?? null;
    const statusUnchanged =
      previousStatus === nextStatus &&
      JSON.stringify(task.waitingFor) === JSON.stringify(waitingFor) &&
      JSON.stringify(task.rateLimitInfo) === JSON.stringify(rateLimitInfo) &&
      task.nextAttemptAt === nextAttemptAt;

    if (statusUnchanged) {
      return task;
    }

    if (previousStatus === nextStatus) {
      throw new TaskTransitionError(
        `Transizione task non valida: ${previousStatus} -> ${nextStatus}.`,
      );
    }

    if (!canTransitionTask(previousStatus, nextStatus)) {
      throw new TaskTransitionError(
        `Transizione task non consentita: ${previousStatus} -> ${nextStatus}.`,
      );
    }

    const now = toIso(Date.now());
    task.status = nextStatus;
    task.updatedAt = now;
    task.lastTransitionAt = now;
    task.nextAttemptAt = nextAttemptAt;

    if (nextStatus === "running") {
      task.startedAt = task.startedAt ?? now;
      task.attempts += 1;
      task.waitingFor = null;
      task.rateLimitInfo = null;
      task.nextAttemptAt = null;
      task.error = null;
    } else if (nextStatus === "waiting_resource") {
      task.waitingFor = waitingFor;
      task.rateLimitInfo = null;
    } else if (nextStatus === "rate_limited") {
      task.waitingFor = waitingFor;
      task.rateLimitInfo = rateLimitInfo;
    } else if (nextStatus === "retrying") {
      task.retryCount += 1;
      task.waitingFor = null;
      task.rateLimitInfo = null;
      task.error = serializeError(metadata.error, { retryable: true });
    } else if (nextStatus === "completed") {
      task.completedAt = now;
      task.waitingFor = null;
      task.rateLimitInfo = null;
      task.nextAttemptAt = null;
      task.error = null;
      task.result = sanitizeResult(metadata.result);
    } else if (nextStatus === "failed") {
      task.failedAt = now;
      task.waitingFor = null;
      task.rateLimitInfo = null;
      task.nextAttemptAt = null;
      task.error = serializeError(metadata.error, { retryable: false });
      task.result = null;
    } else if (nextStatus === "cancelled") {
      task.cancelledAt = now;
      task.waitingFor = null;
      task.rateLimitInfo = null;
      task.nextAttemptAt = null;
      task.error = null;
      task.result = null;
    } else if (nextStatus === "queued") {
      task.waitingFor = null;
      task.rateLimitInfo = null;
      task.nextAttemptAt = null;
    }

    if (nextStatus === "completed") {
      this.recordTaskTiming(task);
    }

    this.recordEvent(task, "status_changed", {
      from: previousStatus,
      to: nextStatus,
      waitingFor: task.waitingFor,
      nextAttemptAt: task.nextAttemptAt,
    });
    this.persistTask(task);

    return task;
  }

  recordEvent(task, event, details = {}) {
    const eventPayload = {
      event,
      timestamp: toIso(Date.now()),
      ...details,
    };
    task.events.push(eventPayload);

    if (task.events.length > 100) {
      task.events.shift();
    }

    const logPayload = {
      scope: "task-queue",
      taskId: task.id,
      taskType: task.taskType,
      status: task.status,
      event,
      ...details,
    };
    console.log(JSON.stringify(logPayload));
  }

  recordQueueEvent(event, details = {}) {
    console.log(
      JSON.stringify({
        scope: "task-queue",
        event,
        ...details,
      }),
    );
  }

  selectNextExecutableTask(now = Date.now()) {
    let nextWakeInMs = null;

    for (const task of this.getQueuedTasksSorted()) {
      const resourceCheck = this.canAcquireResources(task, now);
      if (!resourceCheck.ok) {
        this.recordQueueEvent("task_waiting_for_resource", {
          taskId: task.id,
          taskType: task.taskType,
          reason: resourceCheck.reason,
          waitingFor: resourceCheck.waitingFor,
        });
        this.transitionTask(
          task,
          resourceCheck.reason === "rate_limit"
            ? "rate_limited"
            : "waiting_resource",
          {
            waitingFor: resourceCheck.waitingFor,
            nextAttemptAt: resourceCheck.waitUntil,
            rateLimitInfo: resourceCheck.rateLimitInfo ?? null,
          },
        );

        if (resourceCheck.waitUntil) {
          const wakeInMs = resourceCheck.waitUntil - now;
          nextWakeInMs =
            nextWakeInMs === null ? wakeInMs : Math.min(nextWakeInMs, wakeInMs);
        }
        continue;
      }

      return { task, nextWakeInMs };
    }

    return { task: null, nextWakeInMs };
  }

  dispatchNextTask(task) {
    if (!task) return null;
    if (this.getRunningCount() >= this.concurrency) {
      this.recordQueueEvent("concurrency_limit_reached", {
        runningCount: this.getRunningCount(),
        concurrencyLimit: this.concurrency,
      });
      throw new TaskConflictError(
        `Limite globale di concorrenza raggiunto: ${this.concurrency}.`,
      );
    }

    if (task.status !== "queued") {
      throw new TaskTransitionError(
        `Dispatch consentito solo per task queued. Stato attuale: ${task.status}.`,
      );
    }

    this.acquireExecutionSlots(task);
    this.transitionTask(task, "running");
    this.recordQueueEvent("task_dispatched", {
      taskId: task.id,
      taskType: task.taskType,
      runningCount: this.getRunningCount(),
      concurrencyLimit: this.concurrency,
      pendingCount: this.getPendingCount(),
    });
    this.executeTask(task);
    return this.toPublicTask(task, { includeEvents: true });
  }

  runScheduler() {
    if (!this.schedulerStarted || this.schedulerRunning) return;

    this.schedulerRunning = true;
    let startedAny = false;
    let nextWakeInMs = null;

    try {
      while (this.activeTaskIds.size < this.concurrency) {
        const now = Date.now();
        const promotionWakeInMs = this.promoteDueTasks(now);
        if (promotionWakeInMs !== null) {
          nextWakeInMs =
            nextWakeInMs === null
              ? promotionWakeInMs
              : Math.min(nextWakeInMs, promotionWakeInMs);
        }

        const selection = this.selectNextExecutableTask(now);
        if (selection.nextWakeInMs !== null) {
          nextWakeInMs =
            nextWakeInMs === null
              ? selection.nextWakeInMs
              : Math.min(nextWakeInMs, selection.nextWakeInMs);
        }

        if (!selection.task) break;
        startedAny = true;
        this.dispatchNextTask(selection.task);
      }
    } finally {
      this.schedulerRunning = false;
    }

    if (!startedAny && nextWakeInMs !== null && nextWakeInMs > 0) {
      this.scheduleScheduler(nextWakeInMs);
    }
  }

  startTask(task) {
    return this.dispatchNextTask(task);
  }

  async executeTask(task) {
    const handler = this.taskHandlers.get(task.taskType);
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => {
      abortController.abort(createAbortError("Task scaduto per timeout."));
    }, task.timeoutMs);

    task._execution = {
      abortController,
      timeoutHandle,
    };

    try {
      const result = await handler({
        task: this.toPublicTask(task, { includeEvents: true }),
        payload: task._payload,
        requestEnv: task._requestEnv,
        signal: abortController.signal,
      });

      this.finalizeTask(task, {
        status: "completed",
        result: sanitizeResult(result),
      });
    } catch (error) {
      const retryable = task.retryCount < task.maxRetries && !isAbortError(error);
      if (retryable) {
        const nextRetryAt = Date.now() + getRetryDelayMs(task);
        this.releaseExecutionSlots(task);
        clearTimeout(timeoutHandle);
        task._execution = null;
        this.transitionTask(task, "retrying", {
          error,
          nextAttemptAt: nextRetryAt,
        });
        this.schedule(Math.max(250, nextRetryAt - Date.now()));
        return;
      }

      const wasCancelled = isAbortError(error);
      this.finalizeTask(task, {
        status: wasCancelled ? "cancelled" : "failed",
        error: wasCancelled ? null : error,
      });
    }
  }

  finalizeTask(
    task,
    { status, result = null, error = null } = {},
  ) {
    if (task._execution?.timeoutHandle) {
      clearTimeout(task._execution.timeoutHandle);
    }
    task._execution = null;
    this.releaseExecutionSlots(task);
    this.transitionTask(task, status, { result, error });
    this.pruneHistory();
    this.schedule();
  }

  pruneHistory() {
    const terminalTasks = [...this.tasks.values()]
      .filter((task) => TERMINAL_STATUSES.has(task.status))
      .sort((left, right) => right.sequence - left.sequence);

    for (const task of terminalTasks.slice(this.historyLimit)) {
      this.tasks.delete(task.id);
      if (task.dedupeKey && this.dedupeIndex.get(task.dedupeKey) === task.id) {
        this.dedupeIndex.delete(task.dedupeKey);
      }
      this.deleteTaskArtifact(task);
      if (this.store) {
        this.store.deleteTask(task.id);
      }
    }
  }

  deleteTaskArtifact(task) {
    const artifactPath = task.result?.artifactPath;
    if (!artifactPath) return;

    fsPromises.rm(artifactPath, { force: true }).catch((error) => {
      this.recordQueueEvent("artifact_delete_failed", {
        taskId: task.id,
        error: error.message,
      });
    });
  }

  getResourceSnapshot() {
    const resources = {};

    for (const [resourceId, config] of Object.entries(this.resourceLimits)) {
      const inUse = this.resourceUsage.get(resourceId)?.size ?? 0;
      const waitingCount = [...this.tasks.values()].filter(
        (task) =>
          (task.status === "waiting_resource" || task.status === "rate_limited") &&
          task.waitingFor?.id === resourceId,
      ).length;

      resources[resourceId] = {
        capacity: config.capacity,
        inUse,
        available: Math.max(0, config.capacity - inUse),
        waitingCount,
      };

      if (resourceId === "cardtrader") {
        resources[resourceId].rateLimit = cardTraderRateLimiter.getState();
      }
    }

    return resources;
  }

  getConcurrencyGroupSnapshot() {
    const concurrencyGroups = {};

    for (const [groupId, capacity] of Object.entries(this.groupLimits)) {
      const inUse = this.groupUsage.get(groupId) ?? 0;
      const waitingCount = [...this.tasks.values()].filter(
        (task) =>
          task.status === "waiting_resource" &&
          task.waitingFor?.kind === "concurrency_group" &&
          task.waitingFor?.id === groupId,
      ).length;

      concurrencyGroups[groupId] = {
        capacity,
        inUse,
        available: Math.max(0, capacity - inUse),
        waitingCount,
      };
    }

    return concurrencyGroups;
  }

  getSnapshot() {
    const queueStats = this.getQueueStats();
    const statusCounts = queueStats.statusCounts;

    return {
      concurrency: this.concurrency,
      activeCount: queueStats.runningCount,
      runningCount: queueStats.runningCount,
      pendingCount: queueStats.pendingCount,
      queuedCount: queueStats.queuedCount,
      waitingResourceCount: queueStats.waitingResourceCount,
      rateLimitedCount: queueStats.rateLimitedCount,
      retryingCount: queueStats.retryingCount,
      completedCount: queueStats.completedCount,
      failedCount: queueStats.failedCount,
      cancelledCount: queueStats.cancelledCount,
      maxPendingTasks: this.maxPendingTasks,
      maxPending: queueStats.maxPending,
      concurrencyLimit: queueStats.concurrencyLimit,
      availableSlots: queueStats.availableSlots,
      isBackpressureActive: queueStats.isBackpressureActive,
      historyLimit: this.historyLimit,
      schedulerStarted: this.schedulerStarted,
      schedulerRunning: this.schedulerRunning,
      validStatuses: [...TASK_STATUSES],
      validTransitions: Object.fromEntries(
        Object.entries(VALID_TASK_TRANSITIONS).map(([status, nextStatuses]) => [
          status,
          [...nextStatuses],
        ]),
      ),
      statusCounts,
      activeTasks: [...this.activeTaskIds]
        .map((taskId) => this.tasks.get(taskId))
        .filter(Boolean)
        .map((task) => this.toPublicTask(task)),
      queuePreview: this.getPendingTasksSorted()
        .slice(0, 20)
        .map((task) => this.toPublicTask(task)),
      resources: this.getResourceSnapshot(),
      concurrencyGroups: this.getConcurrencyGroupSnapshot(),
      taskDefinitions: listTaskDefinitions().map((definition) => ({
        taskType: definition.taskType,
        weight: definition.weight,
        resources: definition.resources,
        concurrencyGroup: definition.concurrencyGroup ?? null,
      })),
    };
  }
}

const queue = new RequestQueue();

queue.registerHandler("system.echo", async ({ payload, signal }) => {
  const delayMs = Math.min(30_000, Math.max(0, Number(payload?.delayMs) || 0));
  if (delayMs > 0) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, delayMs);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(signal.reason ?? createAbortError("Task annullato."));
        },
        { once: true },
      );
    });
  }
  return { echo: payload ?? {} };
});
queue.registerHandler("cardtrader.align-prices", async ({ requestEnv, signal }) =>
  alignPriceService.alignPrices({ ...requestEnv, signal }),
);
queue.registerHandler(
  "cardtrader.align-prices-pokemon",
  async ({ requestEnv, signal }) =>
    alignPriceService.alignPokemonPrices({ ...requestEnv, signal }),
);
queue.registerHandler(
  "cardtrader.align-prices-dragonball",
  async ({ requestEnv, signal }) =>
    alignPriceService.alignDragonBallPrices({ ...requestEnv, signal }),
);
queue.registerHandler(
  "cardtrader.align-prices-onepiece",
  async ({ requestEnv, signal }) =>
    alignPriceService.alignOnePiecePrices({ ...requestEnv, signal }),
);
queue.registerHandler(
  "cardtrader.sniff-cardtrader-products",
  async ({ requestEnv, signal }) =>
    snifferService.sniffCardtraderProducts({ ...requestEnv, signal }),
);
queue.registerHandler("cardtrader.update-booster", async ({ requestEnv, signal }) =>
  updateBooster({ ...requestEnv, signal }),
);
queue.registerHandler("excel.convert-to-pdf", async ({ payload, task, signal }) =>
  executeExcelConversionTask(payload, { task, signal }),
);
queue.registerHandler(
  "shopify.fetch-products",
  async ({ payload, requestEnv, signal }) =>
    shopifySyncService.fetchProductsSnapshot({ payload, requestEnv, signal }),
);
queue.registerHandler(
  "shopify.fetch-inventory",
  async ({ payload, requestEnv, signal }) =>
    shopifySyncService.fetchInventorySnapshot({ payload, requestEnv, signal }),
);
queue.registerHandler(
  "shopify.fetch-shop",
  async ({ payload, requestEnv, signal }) =>
    shopifySyncService.fetchShopSnapshot({ payload, requestEnv, signal }),
);

module.exports = queue;
module.exports.RequestQueue = RequestQueue;
module.exports.QueueBackpressureError = QueueBackpressureError;
module.exports.QueueCapacityError = QueueCapacityError;
module.exports.TaskConflictError = TaskConflictError;
module.exports.TaskNotFoundError = TaskNotFoundError;
module.exports.TaskTransitionError = TaskTransitionError;
module.exports.TASK_STATUSES = TASK_STATUSES;
module.exports.VALID_TASK_TRANSITIONS = VALID_TASK_TRANSITIONS;
module.exports.compareTasksForScheduling = compareTasksForScheduling;
module.exports.UnsupportedTaskTypeError = UnsupportedTaskTypeError;
