const router = require("express").Router();
const requestQueue = require("../services/requestQueue");
const {
  getCardTraderTaskDefinition,
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

function getIdempotencyKey(req) {
  return String(req.headers["idempotency-key"] || "").trim();
}

function sendError(res, error, requestId) {
  if (error.retryAfterSeconds) {
    res.setHeader("Retry-After", String(error.retryAfterSeconds));
  }

  return res.status(error.statusCode ?? 500).json({
    ok: false,
    code: error.code ?? null,
    error: error.userMessage ?? error.message,
    requestId: requestId ?? null,
  });
}

router.get("/actions", (req, res) => {
  const actions = listTaskDefinitions()
    .filter((definition) => definition.actionName)
    .map((definition) => ({
      name: definition.actionName,
      taskType: definition.taskType,
      description: definition.description,
      weight: definition.weight,
      resources: definition.resources,
      timeoutMs: definition.timeoutMs,
      allowManualRetry: definition.allowManualRetry,
    }));

  res.status(200).json({
    requestId: req.requestId ?? null,
    actions,
  });
});

router.post("/run/:action", (req, res) => {
  const actionName = String(req.params.action || "").trim();
  const definition = getCardTraderTaskDefinition(actionName);

  if (!definition) {
    return res.status(404).json({
      error: `Azione CardTrader non supportata: ${actionName}`,
      availableActions: listTaskDefinitions()
        .filter((taskDefinition) => taskDefinition.actionName)
        .map((taskDefinition) => taskDefinition.actionName),
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
      taskType: definition.taskType,
      requestId: req.requestId ?? null,
      sourceEndpoint: req.originalUrl,
      payload: req.body ?? {},
      requestEnv,
      idempotencyKey: getIdempotencyKey(req),
    });

    return res.status(deduplicated ? 200 : 202).json({
      ok: true,
      deduplicated,
      requestId: req.requestId ?? null,
      task,
      links: {
        task: `/api/tasks/${task.id}`,
        result: `/api/tasks/${task.id}/result`,
      },
    });
  } catch (error) {
    return sendError(res, error, req.requestId);
  }
});

module.exports = router;
