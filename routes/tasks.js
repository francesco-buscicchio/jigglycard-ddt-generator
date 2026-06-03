const fs = require("fs");
const router = require("express").Router();
const requestQueue = require("../services/requestQueue");
const {
  getTaskDefinition,
  listTaskDefinitions,
  validateRequiredRequestEnv,
} = require("../config/taskDefinitions");

const REQUEST_ENV_FIELD_TO_HEADER = {
  cardTraderToken: "x-cardtrader-token",
  mongodbUri: "x-mongodb-uri",
  mongoUri: "x-mongo-uri",
  effectiveMongoUri: "x-mongodb-uri oppure x-mongo-uri",
  dbName: "x-db-name",
  sofficeBinaryPath: "x-soffice-binary-path",
  cardTraderApiBaseUrl: "x-cardtrader-api-base-url",
};

function parseStatuses(rawValue) {
  if (!rawValue) return null;
  return String(rawValue)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function getIdempotencyKey(req) {
  return String(req.headers["idempotency-key"] || "").trim();
}

router.get("/tasks/definitions", (req, res) => {
  res.status(200).json({
    requestId: req.requestId ?? null,
    definitions: listTaskDefinitions(),
  });
});

router.post("/tasks", (req, res) => {
  const taskType = String(req.body?.taskType || "").trim();
  const definition = getTaskDefinition(taskType);

  if (!definition) {
    return res.status(404).json({
      error: `Task type non supportato: ${taskType}`,
      requestId: req.requestId ?? null,
    });
  }

  if (!definition.allowApiCreate) {
    return res.status(400).json({
      error: `Task type non creabile via POST /api/tasks: ${taskType}`,
      requestId: req.requestId ?? null,
    });
  }

  const requestEnv = req.requestContext?.requestEnv ?? {};
  const missingFields = validateRequiredRequestEnv(definition, requestEnv);
  if (missingFields.length > 0) {
    return res.status(400).json({
      error: "Header runtime mancanti per il task richiesto.",
      missingHeaders: missingFields.map(
        (field) => REQUEST_ENV_FIELD_TO_HEADER[field] ?? field,
      ),
      requestId: req.requestId ?? null,
    });
  }

  try {
    const { task, deduplicated } = requestQueue.enqueueTask({
      taskType,
      requestId: req.requestId ?? null,
      sourceEndpoint: req.originalUrl,
      payload: req.body?.payload ?? {},
      requestEnv,
      idempotencyKey: getIdempotencyKey(req),
    });

    return res.status(deduplicated ? 200 : 202).json({
      ok: true,
      deduplicated,
      requestId: req.requestId ?? null,
      task,
      links: {
        self: `/api/tasks/${task.id}`,
        result: `/api/tasks/${task.id}/result`,
      },
    });
  } catch (error) {
    return res.status(error.statusCode ?? 500).json({
      ok: false,
      error: error.message,
      requestId: req.requestId ?? null,
    });
  }
});

router.get("/tasks", (req, res) => {
  const statuses = parseStatuses(req.query.status);
  const taskType = req.query.taskType ? String(req.query.taskType) : null;
  const requestId = req.query.requestId ? String(req.query.requestId) : null;
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));

  try {
    res.status(200).json({
      requestId: req.requestId ?? null,
      tasks: requestQueue.listTasks({ statuses, taskType, requestId, limit }),
    });
  } catch (error) {
    res.status(error.statusCode ?? 500).json({
      ok: false,
      error: error.message,
      requestId: req.requestId ?? null,
    });
  }
});

router.get("/tasks/:taskId", (req, res) => {
  const task = requestQueue.getTask(req.params.taskId);
  if (!task) {
    return res.status(404).json({
      error: `Task non trovato: ${req.params.taskId}`,
      requestId: req.requestId ?? null,
    });
  }

  return res.status(200).json({
    requestId: req.requestId ?? null,
    task,
  });
});

router.get("/tasks/:taskId/result", (req, res) => {
  const task = requestQueue.getTask(req.params.taskId);
  if (!task) {
    return res.status(404).json({
      error: `Task non trovato: ${req.params.taskId}`,
      requestId: req.requestId ?? null,
    });
  }

  if (task.status !== "completed") {
    return res.status(409).json({
      error: `Risultato non disponibile. Stato attuale: ${task.status}.`,
      requestId: req.requestId ?? null,
    });
  }

  const artifactPath = task.result?.artifactPath;
  if (artifactPath && fs.existsSync(artifactPath)) {
    res.setHeader(
      "Content-Type",
      task.result?.contentType || "application/octet-stream",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${task.result?.filename || `${task.id}.bin`}"`,
    );
    return fs.createReadStream(artifactPath).pipe(res);
  }

  return res.status(200).json({
    requestId: req.requestId ?? null,
    result: task.result,
  });
});

router.post("/tasks/:taskId/cancel", async (req, res) => {
  try {
    const task = await requestQueue.cancel(req.params.taskId);
    return res.status(200).json({
      ok: true,
      requestId: req.requestId ?? null,
      task,
    });
  } catch (error) {
    return res.status(error.statusCode ?? 500).json({
      ok: false,
      error: error.message,
      requestId: req.requestId ?? null,
    });
  }
});

router.post("/tasks/:taskId/retry", (req, res) => {
  try {
    const { task, deduplicated } = requestQueue.retry(req.params.taskId);
    return res.status(deduplicated ? 200 : 202).json({
      ok: true,
      deduplicated,
      requestId: req.requestId ?? null,
      task,
      links: {
        self: `/api/tasks/${task.id}`,
        result: `/api/tasks/${task.id}/result`,
      },
    });
  } catch (error) {
    return res.status(error.statusCode ?? 500).json({
      ok: false,
      error: error.message,
      requestId: req.requestId ?? null,
    });
  }
});

router.get("/resources/status", (req, res) => {
  res.status(200).json({
    requestId: req.requestId ?? null,
    resources: requestQueue.getResourceSnapshot(),
  });
});

router.get("/queue/stats", (req, res) => {
  res.status(200).json({
    requestId: req.requestId ?? null,
    queue: requestQueue.getSnapshot(),
  });
});

module.exports = router;
