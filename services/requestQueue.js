const {
  REQUEST_QUEUE_CONCURRENCY,
  TASK_QUEUE_MAX_PENDING,
  TASK_QUEUE_HISTORY_LIMIT,
  TASK_QUEUE_DEFAULT_TIMEOUT_MS,
  CARDTRADER_RESOURCE_CONCURRENCY,
  DATABASE_RESOURCE_CONCURRENCY,
  LIBREOFFICE_RESOURCE_CONCURRENCY,
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

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const PENDING_STATUSES = new Set([
  "pending",
  "queued",
  "waiting_resource",
  "rate_limited",
  "retrying",
]);

class QueueCapacityError extends Error {
  constructor(message) {
    super(message);
    this.name = "QueueCapacityError";
    this.statusCode = 429;
  }
}

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

function serializeError(error) {
  if (!error) return null;

  return {
    name: error.name ?? "Error",
    message: error.message ?? "Errore sconosciuto",
    code: error.code ?? null,
    statusCode: error.statusCode ?? error.response?.status ?? null,
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

function sortTasksForScheduling(tasks = []) {
  return tasks.sort((left, right) => {
    if (left.weight !== right.weight) {
      return left.weight - right.weight;
    }

    return left.sequence - right.sequence;
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

class RequestQueue {
  constructor({
    concurrency = REQUEST_QUEUE_CONCURRENCY,
    maxPendingTasks = TASK_QUEUE_MAX_PENDING,
    historyLimit = TASK_QUEUE_HISTORY_LIMIT,
    defaultTimeoutMs = TASK_QUEUE_DEFAULT_TIMEOUT_MS,
    groupLimits = {},
    resourceLimits = {},
    taskDefinitions = listTaskDefinitions(),
  } = {}) {
    this.concurrency = Math.max(1, Number(concurrency) || 1);
    this.maxPendingTasks = Math.max(1, Number(maxPendingTasks) || 1);
    this.historyLimit = Math.max(10, Number(historyLimit) || 10);
    this.defaultTimeoutMs = Math.max(1_000, Number(defaultTimeoutMs) || 1_000);
    this.groupLimits = {
      "cardtrader-heavy": 1,
      "cardtrader-maintenance": 1,
      "excel-conversion": 1,
      ...groupLimits,
    };
    this.resourceLimits = {
      cardtrader: { capacity: CARDTRADER_RESOURCE_CONCURRENCY },
      database: { capacity: DATABASE_RESOURCE_CONCURRENCY },
      excel: { capacity: LIBREOFFICE_RESOURCE_CONCURRENCY },
      filesystem: { capacity: LIBREOFFICE_RESOURCE_CONCURRENCY },
      "cpu-heavy": { capacity: LIBREOFFICE_RESOURCE_CONCURRENCY },
      ...resourceLimits,
    };

    this.sequence = 0;
    this.tasks = new Map();
    this.taskDefinitions = new Map();
    this.taskHandlers = new Map();
    this.dedupeIndex = new Map();
    this.activeTaskIds = new Set();
    this.resourceUsage = new Map();
    this.groupUsage = new Map();
    this.schedulerTimer = null;
    this.schedulerScheduled = false;

    assertValidTaskDefinitions(taskDefinitions);

    for (const definition of taskDefinitions) {
      this.taskDefinitions.set(definition.taskType, definition);
    }
  }

  registerHandler(taskType, handler) {
    this.taskHandlers.set(taskType, handler);
  }

  getTaskDefinition(taskType) {
    return this.taskDefinitions.get(taskType) ?? null;
  }

  getPendingCount() {
    return [...this.tasks.values()].filter((task) => PENDING_STATUSES.has(task.status))
      .length;
  }

  getTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    return this.toPublicTask(task, { includeEvents: true });
  }

  listTasks({ statuses = null, taskType = null, limit = 50 } = {}) {
    const statusSet =
      Array.isArray(statuses) && statuses.length > 0 ? new Set(statuses) : null;

    return [...this.tasks.values()]
      .filter((task) => {
        if (statusSet && !statusSet.has(task.status)) return false;
        if (taskType && task.taskType !== taskType) return false;
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
      status: task.status,
      weight: task.weight,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      failedAt: task.failedAt,
      cancelledAt: task.cancelledAt,
      updatedAt: task.updatedAt,
      timeoutMs: task.timeoutMs,
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
    if (this.getPendingCount() >= this.maxPendingTasks) {
      throw new QueueCapacityError(
        `Coda satura: massimo ${this.maxPendingTasks} task pendenti raggiunto.`,
      );
    }

    const task = this.buildTask(taskInput);
    if (!task.forceNew && task.dedupeKey && this.dedupeIndex.has(task.dedupeKey)) {
      const existingTaskId = this.dedupeIndex.get(task.dedupeKey);
      const existingTask = this.tasks.get(existingTaskId);
      if (existingTask) {
        this.recordEvent(existingTask, "deduplicated", {
          dedupedByRequestId: task.requestId,
        });
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
    this.setTaskStatus(task, "queued");
    this.schedule();
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
      return this.toPublicTask(task, { includeEvents: true });
    }

    if (task.status === "running") {
      task._execution?.abortController?.abort(
        createAbortError("Task annullato manualmente."),
      );
      this.recordEvent(task, "cancellation_requested");
      return this.toPublicTask(task, { includeEvents: true });
    }

    this.finalizeTask(task, {
      status: "cancelled",
      completedAtField: "cancelledAt",
      error: null,
      result: null,
    });
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

    return this.enqueue({
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

  schedule(delayMs = 0) {
    if (delayMs > 0) {
      if (this.schedulerTimer) {
        clearTimeout(this.schedulerTimer);
      }

      this.schedulerTimer = setTimeout(() => {
        this.schedulerTimer = null;
        this.schedule();
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

  canUseGroup(task) {
    if (!task.concurrencyGroup) return { ok: true };
    const limit = this.groupLimits[task.concurrencyGroup];
    if (!limit) return { ok: true };

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
      const config = this.resourceLimits[resourceId] ?? { capacity: 1 };
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

  acquireExecutionSlots(task) {
    this.activeTaskIds.add(task.id);

    if (task.concurrencyGroup) {
      const currentUsage = this.groupUsage.get(task.concurrencyGroup) ?? 0;
      this.groupUsage.set(task.concurrencyGroup, currentUsage + 1);
    }

    for (const resourceId of task.resources) {
      const resourceTasks = this.resourceUsage.get(resourceId) ?? new Set();
      resourceTasks.add(task.id);
      this.resourceUsage.set(resourceId, resourceTasks);
    }
  }

  releaseExecutionSlots(task) {
    this.activeTaskIds.delete(task.id);

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
  }

  setTaskStatus(task, status, extra = {}) {
    const nextAttemptAt = extra.nextAttemptAt ? toIso(extra.nextAttemptAt) : null;
    const waitingFor = extra.waitingFor ?? null;
    const rateLimitInfo = extra.rateLimitInfo ?? null;
    const statusUnchanged =
      task.status === status &&
      JSON.stringify(task.waitingFor) === JSON.stringify(waitingFor) &&
      task.nextAttemptAt === nextAttemptAt;

    task.status = status;
    task.updatedAt = toIso(Date.now());
    task.waitingFor = waitingFor;
    task.nextAttemptAt = nextAttemptAt;
    task.rateLimitInfo = rateLimitInfo;

    if (statusUnchanged) {
      return;
    }

    this.recordEvent(task, "status_changed", {
      status,
      waitingFor: task.waitingFor,
      nextAttemptAt: task.nextAttemptAt,
    });
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

  runScheduler() {
    let startedAny = false;
    let nextWakeInMs = null;

    while (this.activeTaskIds.size < this.concurrency) {
      const pendingTasks = this.getPendingTasksSorted();
      let scheduledTask = null;

      for (const task of pendingTasks) {
        const now = Date.now();

        if (task.nextAttemptAt && Date.parse(task.nextAttemptAt) > now) {
          const wakeInMs = Date.parse(task.nextAttemptAt) - now;
          nextWakeInMs =
            nextWakeInMs === null ? wakeInMs : Math.min(nextWakeInMs, wakeInMs);
          continue;
        }

        const groupCheck = this.canUseGroup(task);
        if (!groupCheck.ok) {
          this.setTaskStatus(task, "waiting_resource", {
            waitingFor: groupCheck.waitingFor,
          });
          continue;
        }

        const resourceCheck = this.canUseResources(task, now);
        if (!resourceCheck.ok) {
          this.setTaskStatus(
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
              nextWakeInMs === null
                ? wakeInMs
                : Math.min(nextWakeInMs, wakeInMs);
          }
          continue;
        }

        scheduledTask = task;
        break;
      }

      if (!scheduledTask) break;
      startedAny = true;
      this.startTask(scheduledTask);
    }

    if (!startedAny && nextWakeInMs !== null && nextWakeInMs > 0) {
      this.schedule(nextWakeInMs);
    }
  }

  async startTask(task) {
    const handler = this.taskHandlers.get(task.taskType);
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => {
      abortController.abort(createAbortError("Task scaduto per timeout."));
    }, task.timeoutMs);

    task._execution = {
      abortController,
      timeoutHandle,
    };

    this.acquireExecutionSlots(task);
    if (!task.startedAt) {
      task.startedAt = toIso(Date.now());
    }
    this.setTaskStatus(task, "running");

    try {
      const result = await handler({
        task: this.toPublicTask(task, { includeEvents: true }),
        payload: task._payload,
        requestEnv: task._requestEnv,
        signal: abortController.signal,
      });

      this.finalizeTask(task, {
        status: "completed",
        completedAtField: "completedAt",
        result: sanitizeResult(result),
        error: null,
      });
    } catch (error) {
      const retryable = task.retryCount < task.maxRetries && !isAbortError(error);
      if (retryable) {
        const nextRetryAt = Date.now() + getRetryDelayMs(task);
        task.retryCount += 1;
        task.error = serializeError(error);
        this.releaseExecutionSlots(task);
        clearTimeout(timeoutHandle);
        task._execution = null;
        this.setTaskStatus(task, "retrying", {
          nextAttemptAt: nextRetryAt,
        });
        this.schedule(Math.max(250, nextRetryAt - Date.now()));
        return;
      }

      const wasCancelled = isAbortError(error);
      this.finalizeTask(task, {
        status: wasCancelled ? "cancelled" : "failed",
        completedAtField: wasCancelled ? "cancelledAt" : "failedAt",
        error: wasCancelled ? null : serializeError(error),
        result: null,
      });
    }
  }

  finalizeTask(
    task,
    { status, completedAtField, result = null, error = null } = {},
  ) {
    if (task._execution?.timeoutHandle) {
      clearTimeout(task._execution.timeoutHandle);
    }
    task._execution = null;
    this.releaseExecutionSlots(task);
    task[completedAtField] = toIso(Date.now());
    task.result = result;
    task.error = error;
    this.setTaskStatus(task, status);
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
    }
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
        waitingCount,
      };

      if (resourceId === "cardtrader") {
        resources[resourceId].rateLimit = cardTraderRateLimiter.getState();
      }
    }

    return resources;
  }

  getSnapshot() {
    const statusCounts = {};
    for (const task of this.tasks.values()) {
      statusCounts[task.status] = (statusCounts[task.status] ?? 0) + 1;
    }

    return {
      concurrency: this.concurrency,
      activeCount: this.activeTaskIds.size,
      pendingCount: this.getPendingCount(),
      maxPendingTasks: this.maxPendingTasks,
      historyLimit: this.historyLimit,
      statusCounts,
      activeTasks: [...this.activeTaskIds]
        .map((taskId) => this.tasks.get(taskId))
        .filter(Boolean)
        .map((task) => this.toPublicTask(task)),
      queuePreview: this.getPendingTasksSorted()
        .slice(0, 20)
        .map((task) => this.toPublicTask(task)),
      resources: this.getResourceSnapshot(),
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

module.exports = queue;
module.exports.RequestQueue = RequestQueue;
module.exports.QueueCapacityError = QueueCapacityError;
module.exports.TaskConflictError = TaskConflictError;
module.exports.TaskNotFoundError = TaskNotFoundError;
module.exports.UnsupportedTaskTypeError = UnsupportedTaskTypeError;
