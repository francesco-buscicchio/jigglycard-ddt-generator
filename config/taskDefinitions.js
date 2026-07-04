const { createHash } = require("crypto");

const VALID_HTTP_METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

const REQUIRED_FIELDS = [
  "taskType",
  "endpoint",
  "method",
  "weight",
  "resources",
  "concurrencyGroup",
  "timeoutMs",
  "maxRetries",
  "idempotency",
  "description",
  "operationalNotes",
];
const KNOWN_TASK_RESOURCES = new Set([
  "cardtrader",
  "database",
  "libreoffice",
  "filesystem",
  "cpu-heavy",
  "shopify",
  "default",
]);
const KNOWN_CONCURRENCY_GROUPS = new Set([
  "default",
  "cardtrader-heavy",
  "cardtrader-maintenance",
  "excel",
  "cpu-heavy",
  "shopify",
]);

class TaskDefinitionValidationError extends Error {
  constructor(errors) {
    super(`Catalogo task non valido: ${errors.join("; ")}`);
    this.name = "TaskDefinitionValidationError";
    this.errors = errors;
  }
}

function buildTenantFingerprint(requestEnv = {}) {
  const source = [
    requestEnv.effectiveMongoUri,
    requestEnv.dbName,
    requestEnv.cardTraderApiBaseUrl,
  ]
    .filter(Boolean)
    .join("|");

  if (!source) return "global";
  return createHash("sha1").update(source).digest("hex").slice(0, 12);
}

function summarizeFilePayload(payload = {}) {
  return {
    originalFilename: payload.originalFilename ?? null,
    uploadedFilePath: payload.uploadedFilePath ?? null,
  };
}

const TASK_DEFINITIONS = [
  {
    taskType: "cardtrader.align-prices",
    actionName: "align-prices",
    endpoint: "/api/cardtrader/run/align-prices",
    method: "POST",
    description:
      "Esegue l'allineamento prezzi completo per Pokemon, Dragon Ball e One Piece.",
    enabled: true,
    weight: 10,
    resources: ["cardtrader"],
    concurrencyGroup: "cardtrader-heavy",
    rateLimitGroup: "cardtrader",
    queueName: "default",
    estimatedDuration: "30-45m",
    timeoutMs: 45 * 60 * 1000,
    maxRetries: 0,
    retryBackoff: { strategy: "exponential", baseDelayMs: 1_000, maxDelayMs: 30_000 },
    allowApiCreate: true,
    allowManualRetry: false,
    idempotency: {
      required: true,
      strategy: "dedupe-by-tenant",
      keySource: "generated:tenant-fingerprint",
      dedupeWindowMs: null,
    },
    requiredPermissions: ["cardtrader:write-prices"],
    allowedSources: ["api", "cardtrader-route"],
    requiredRequestEnv: ["cardTraderToken"],
    operationalNotes:
      "Aggiorna prezzi remoti su CardTrader e scrive CSV locali di supporto.",
    risks:
      "Task molto lungo con molte chiamate esterne; evitare duplicati concorrenti.",
    buildPayloadSummary: () => ({}),
    buildDedupeKey: ({ requestEnv }) =>
      `cardtrader.align-prices:${buildTenantFingerprint(requestEnv)}`,
  },
  {
    taskType: "cardtrader.align-prices-pokemon",
    actionName: "align-prices-pokemon",
    endpoint: "/api/cardtrader/run/align-prices-pokemon",
    method: "POST",
    description: "Esegue l'allineamento prezzi solo per Pokemon.",
    enabled: true,
    weight: 8,
    resources: ["cardtrader"],
    concurrencyGroup: "cardtrader-heavy",
    rateLimitGroup: "cardtrader",
    queueName: "default",
    estimatedDuration: "10-20m",
    timeoutMs: 20 * 60 * 1000,
    maxRetries: 0,
    retryBackoff: { strategy: "exponential", baseDelayMs: 1_000, maxDelayMs: 30_000 },
    allowApiCreate: true,
    allowManualRetry: false,
    idempotency: {
      required: true,
      strategy: "dedupe-by-tenant",
      keySource: "generated:tenant-fingerprint",
      dedupeWindowMs: null,
    },
    requiredPermissions: ["cardtrader:write-prices"],
    allowedSources: ["api", "cardtrader-route"],
    requiredRequestEnv: ["cardTraderToken"],
    operationalNotes: "Aggiorna prezzi solo per il catalogo Pokemon.",
    risks: "Task con effetti esterni su prezzi CardTrader.",
    buildPayloadSummary: () => ({}),
    buildDedupeKey: ({ requestEnv }) =>
      `cardtrader.align-prices-pokemon:${buildTenantFingerprint(requestEnv)}`,
  },
  {
    taskType: "cardtrader.align-prices-dragonball",
    actionName: "align-prices-dragonball",
    endpoint: "/api/cardtrader/run/align-prices-dragonball",
    method: "POST",
    description: "Esegue l'allineamento prezzi solo per Dragon Ball.",
    enabled: true,
    weight: 8,
    resources: ["cardtrader"],
    concurrencyGroup: "cardtrader-heavy",
    rateLimitGroup: "cardtrader",
    queueName: "default",
    estimatedDuration: "10-20m",
    timeoutMs: 20 * 60 * 1000,
    maxRetries: 0,
    retryBackoff: { strategy: "exponential", baseDelayMs: 1_000, maxDelayMs: 30_000 },
    allowApiCreate: true,
    allowManualRetry: false,
    idempotency: {
      required: true,
      strategy: "dedupe-by-tenant",
      keySource: "generated:tenant-fingerprint",
      dedupeWindowMs: null,
    },
    requiredPermissions: ["cardtrader:write-prices"],
    allowedSources: ["api", "cardtrader-route"],
    requiredRequestEnv: ["cardTraderToken"],
    operationalNotes: "Aggiorna prezzi solo per il catalogo Dragon Ball.",
    risks: "Task con effetti esterni su prezzi CardTrader.",
    buildPayloadSummary: () => ({}),
    buildDedupeKey: ({ requestEnv }) =>
      `cardtrader.align-prices-dragonball:${buildTenantFingerprint(
        requestEnv,
      )}`,
  },
  {
    taskType: "cardtrader.align-prices-onepiece",
    actionName: "align-prices-onepiece",
    endpoint: "/api/cardtrader/run/align-prices-onepiece",
    method: "POST",
    description: "Esegue l'allineamento prezzi solo per One Piece.",
    enabled: true,
    weight: 8,
    resources: ["cardtrader"],
    concurrencyGroup: "cardtrader-heavy",
    rateLimitGroup: "cardtrader",
    queueName: "default",
    estimatedDuration: "10-20m",
    timeoutMs: 20 * 60 * 1000,
    maxRetries: 0,
    retryBackoff: { strategy: "exponential", baseDelayMs: 1_000, maxDelayMs: 30_000 },
    allowApiCreate: true,
    allowManualRetry: false,
    idempotency: {
      required: true,
      strategy: "dedupe-by-tenant",
      keySource: "generated:tenant-fingerprint",
      dedupeWindowMs: null,
    },
    requiredPermissions: ["cardtrader:write-prices"],
    allowedSources: ["api", "cardtrader-route"],
    requiredRequestEnv: ["cardTraderToken"],
    operationalNotes: "Aggiorna prezzi solo per il catalogo One Piece.",
    risks: "Task con effetti esterni su prezzi CardTrader.",
    buildPayloadSummary: () => ({}),
    buildDedupeKey: ({ requestEnv }) =>
      `cardtrader.align-prices-onepiece:${buildTenantFingerprint(requestEnv)}`,
  },
  {
    taskType: "cardtrader.sniff-cardtrader-products",
    actionName: "sniff-cardtrader-products",
    endpoint: "/api/cardtrader/run/sniff-cardtrader-products",
    method: "POST",
    description:
      "Analizza il marketplace CardTrader e popola le segnalazioni di prezzo.",
    enabled: true,
    weight: 5,
    resources: ["cardtrader", "database"],
    concurrencyGroup: "cardtrader-heavy",
    rateLimitGroup: "cardtrader",
    queueName: "default",
    estimatedDuration: "20-30m",
    timeoutMs: 30 * 60 * 1000,
    maxRetries: 1,
    retryBackoff: { strategy: "exponential", baseDelayMs: 1_000, maxDelayMs: 30_000 },
    allowApiCreate: true,
    allowManualRetry: true,
    idempotency: {
      required: true,
      strategy: "dedupe-by-tenant",
      keySource: "generated:tenant-fingerprint",
      dedupeWindowMs: null,
    },
    requiredPermissions: ["cardtrader:read-marketplace", "database:write"],
    allowedSources: ["api", "cardtrader-route"],
    requiredRequestEnv: ["cardTraderToken", "effectiveMongoUri"],
    operationalNotes:
      "Rigenera le segnalazioni prezzo nel database; task intensivo su CardTrader.",
    risks: "Se duplicato, può cancellare/rigenerare alert in parallelo.",
    buildPayloadSummary: () => ({}),
    buildDedupeKey: ({ requestEnv }) =>
      `cardtrader.sniff-cardtrader-products:${buildTenantFingerprint(
        requestEnv,
      )}`,
  },
  {
    taskType: "cardtrader.update-booster",
    actionName: "update-booster",
    endpoint: "/api/cardtrader/run/update-booster",
    method: "POST",
    description: "Aggiorna i booster giapponesi in MongoDB.",
    enabled: true,
    weight: 6,
    resources: ["cardtrader", "database"],
    concurrencyGroup: "cardtrader-maintenance",
    rateLimitGroup: "cardtrader",
    queueName: "default",
    estimatedDuration: "10-20m",
    timeoutMs: 20 * 60 * 1000,
    maxRetries: 2,
    retryBackoff: { strategy: "exponential", baseDelayMs: 1_000, maxDelayMs: 30_000 },
    allowApiCreate: true,
    allowManualRetry: true,
    idempotency: {
      required: true,
      strategy: "dedupe-by-tenant",
      keySource: "generated:tenant-fingerprint",
      dedupeWindowMs: null,
    },
    requiredPermissions: ["cardtrader:read-catalog", "database:write"],
    allowedSources: ["api", "cardtrader-route"],
    requiredRequestEnv: ["cardTraderToken", "effectiveMongoUri"],
    operationalNotes: "Usa upsert nel DB per evitare duplicati booster.",
    risks: "Molte richieste verso CardTrader durante scansione espansioni.",
    buildPayloadSummary: () => ({}),
    buildDedupeKey: ({ requestEnv }) =>
      `cardtrader.update-booster:${buildTenantFingerprint(requestEnv)}`,
  },
  {
    taskType: "excel.convert-to-pdf",
    endpoint: "/api/excel/convert-to-pdf",
    method: "POST",
    description: "Converte un file Excel caricato in PDF.",
    enabled: true,
    weight: 3,
    resources: ["libreoffice", "filesystem", "cpu-heavy"],
    concurrencyGroup: "excel",
    rateLimitGroup: null,
    queueName: "default",
    estimatedDuration: "1-10m",
    timeoutMs: 10 * 60 * 1000,
    maxRetries: 0,
    retryBackoff: { strategy: "none" },
    allowApiCreate: false,
    allowManualRetry: false,
    idempotency: {
      required: false,
      strategy: "client-key",
      keySource: "header:Idempotency-Key",
      dedupeWindowMs: null,
    },
    requiredPermissions: ["excel:convert"],
    allowedSources: ["excel-route"],
    requiredRequestEnv: [],
    operationalNotes:
      "Salva l'artefatto PDF su disco e lo rende scaricabile via task result.",
    risks: "Può saturare CPU e I/O se eseguito in parallelo senza limiti.",
    buildPayloadSummary: summarizeFilePayload,
  },
  {
    taskType: "shopify.fetch-products",
    actionName: "shopify-fetch-products",
    endpoint: "/api/tasks (taskType shopify.fetch-products)",
    method: "POST",
    description:
      "Scarica da Shopify prodotti, collezioni e membership prodotto-collezione e salva uno snapshot a chunk nel database del tenant, poi notifica il CMS via callback.",
    enabled: true,
    weight: 6,
    resources: ["shopify", "database"],
    concurrencyGroup: "shopify",
    rateLimitGroup: null,
    queueName: "default",
    estimatedDuration: "5-30m",
    timeoutMs: 45 * 60 * 1000,
    maxRetries: 1,
    retryBackoff: { strategy: "exponential", baseDelayMs: 5_000, maxDelayMs: 60_000 },
    allowApiCreate: true,
    allowManualRetry: true,
    idempotency: {
      required: true,
      strategy: "dedupe-by-tenant",
      keySource: "generated:tenant-fingerprint",
      dedupeWindowMs: null,
    },
    requiredPermissions: ["shopify:fetch"],
    allowedSources: ["api"],
    requiredRequestEnv: [
      "effectiveMongoUri",
      "dbName",
      "shopifyShop",
      "shopifyAccessToken",
    ],
    operationalNotes:
      "Solo lettura verso Shopify; scrive snapshot in shopify_sync_snapshots / shopify_sync_snapshot_chunks nel db del tenant. L'applicazione dei dati resta nel CMS (callback).",
    risks:
      "Molte chiamate esterne (una paginazione per collezione); rispettare il rate limit Shopify ed evitare esecuzioni duplicate per lo stesso tenant.",
  },
  {
    taskType: "shopify.fetch-inventory",
    actionName: "shopify-fetch-inventory",
    endpoint: "/api/tasks (taskType shopify.fetch-inventory)",
    method: "POST",
    description:
      "Scarica da Shopify prodotti (varianti), locations e livelli di inventario e salva uno snapshot a chunk nel database del tenant, poi notifica il CMS via callback.",
    enabled: true,
    weight: 5,
    resources: ["shopify", "database"],
    concurrencyGroup: "shopify",
    rateLimitGroup: null,
    queueName: "default",
    estimatedDuration: "3-20m",
    timeoutMs: 30 * 60 * 1000,
    maxRetries: 1,
    retryBackoff: { strategy: "exponential", baseDelayMs: 5_000, maxDelayMs: 60_000 },
    allowApiCreate: true,
    allowManualRetry: true,
    idempotency: {
      required: true,
      strategy: "dedupe-by-tenant",
      keySource: "generated:tenant-fingerprint",
      dedupeWindowMs: null,
    },
    requiredPermissions: ["shopify:fetch"],
    allowedSources: ["api"],
    requiredRequestEnv: [
      "effectiveMongoUri",
      "dbName",
      "shopifyShop",
      "shopifyAccessToken",
    ],
    operationalNotes:
      "Solo lettura verso Shopify; una paginazione inventory_levels per location. L'applicazione al ledger inventario resta nel CMS (callback).",
    risks:
      "Chiamate esterne proporzionali al numero di location; evitare esecuzioni duplicate per lo stesso tenant.",
  },
  {
    taskType: "shopify.fetch-shop",
    actionName: "shopify-fetch-shop",
    endpoint: "/api/tasks (taskType shopify.fetch-shop)",
    method: "POST",
    description:
      "Scarica le proprietà del negozio Shopify (shop.json) e salva uno snapshot nel database del tenant, poi notifica il CMS via callback.",
    enabled: true,
    weight: 1,
    resources: ["shopify", "database"],
    concurrencyGroup: "shopify",
    rateLimitGroup: null,
    queueName: "default",
    estimatedDuration: "<1m",
    timeoutMs: 5 * 60 * 1000,
    maxRetries: 2,
    retryBackoff: { strategy: "exponential", baseDelayMs: 2_000, maxDelayMs: 30_000 },
    allowApiCreate: true,
    allowManualRetry: true,
    idempotency: {
      required: true,
      strategy: "dedupe-by-tenant",
      keySource: "generated:tenant-fingerprint",
      dedupeWindowMs: null,
    },
    requiredPermissions: ["shopify:fetch"],
    allowedSources: ["api"],
    requiredRequestEnv: [
      "effectiveMongoUri",
      "dbName",
      "shopifyShop",
      "shopifyAccessToken",
    ],
    operationalNotes:
      "Una singola chiamata Shopify; snapshot minimale con le proprietà del negozio.",
    risks: "Nessun rischio particolare: task breve e di sola lettura.",
  },
];

function describeIdempotency(idempotency = {}) {
  const required = idempotency.required ? "required" : "optional";
  return [
    required,
    idempotency.strategy,
    idempotency.keySource,
    idempotency.dedupeWindowMs
      ? `window=${idempotency.dedupeWindowMs}ms`
      : null,
  ]
    .filter(Boolean)
    .join("; ");
}

function validateTaskDefinitions(
  definitions = TASK_DEFINITIONS,
  {
    knownResources = KNOWN_TASK_RESOURCES,
    knownConcurrencyGroups = KNOWN_CONCURRENCY_GROUPS,
  } = {},
) {
  const errors = [];
  const taskTypes = new Set();
  const endpoints = new Set();

  definitions.forEach((definition, index) => {
    const label = definition?.taskType || `definition[${index}]`;

    for (const field of REQUIRED_FIELDS) {
      if (definition?.[field] === undefined || definition?.[field] === null) {
        errors.push(`${label}: campo obbligatorio mancante ${field}`);
      }
    }

    if (taskTypes.has(definition?.taskType)) {
      errors.push(`${label}: taskType duplicato`);
    }
    if (definition?.taskType) taskTypes.add(definition.taskType);

    const endpointKey = `${definition?.method || ""} ${definition?.endpoint || ""}`;
    if (endpoints.has(endpointKey)) {
      errors.push(`${label}: endpoint duplicato ${endpointKey}`);
    }
    if (definition?.method && definition?.endpoint) endpoints.add(endpointKey);

    if (!VALID_HTTP_METHODS.has(definition?.method)) {
      errors.push(`${label}: method non valido ${definition?.method}`);
    }

    if (!Number.isFinite(Number(definition?.weight))) {
      errors.push(`${label}: weight mancante o non numerico`);
    }

    if (!Array.isArray(definition?.resources) || definition.resources.length === 0) {
      errors.push(`${label}: resources mancante o vuoto`);
    } else {
      for (const resourceId of definition.resources) {
        if (!knownResources.has(resourceId)) {
          errors.push(`${label}: resource sconosciuta ${resourceId}`);
        }
      }
    }

    if (typeof definition?.concurrencyGroup !== "string" || !definition.concurrencyGroup) {
      errors.push(`${label}: concurrencyGroup mancante`);
    } else if (!knownConcurrencyGroups.has(definition.concurrencyGroup)) {
      errors.push(`${label}: concurrencyGroup sconosciuto ${definition.concurrencyGroup}`);
    }

    if (!Number.isFinite(Number(definition?.timeoutMs)) || Number(definition.timeoutMs) <= 0) {
      errors.push(`${label}: timeoutMs mancante o non valido`);
    }

    if (
      !Number.isInteger(Number(definition?.maxRetries)) ||
      Number(definition.maxRetries) < 0
    ) {
      errors.push(`${label}: maxRetries mancante o non valido`);
    }

    if (
      typeof definition?.idempotency !== "object" ||
      typeof definition.idempotency?.required !== "boolean" ||
      typeof definition.idempotency?.strategy !== "string" ||
      !definition.idempotency.strategy
    ) {
      errors.push(`${label}: idempotency mancante o non valida`);
    }

    if (definition?.resources?.includes("cardtrader")) {
      if (!String(definition.concurrencyGroup).startsWith("cardtrader")) {
        errors.push(`${label}: concurrencyGroup CardTrader non coerente`);
      }
      if (definition.rateLimitGroup !== "cardtrader") {
        errors.push(`${label}: rateLimitGroup CardTrader mancante`);
      }
    }

    if (
      String(definition?.taskType || "").startsWith("excel.") &&
      !definition?.resources?.includes("libreoffice")
    ) {
      errors.push(`${label}: task Excel senza resource libreoffice`);
    }
  });

  return errors;
}

function assertValidTaskDefinitions(definitions = TASK_DEFINITIONS, options = {}) {
  const errors = validateTaskDefinitions(definitions, options);
  if (errors.length > 0) {
    throw new TaskDefinitionValidationError(errors);
  }
}

assertValidTaskDefinitions(TASK_DEFINITIONS);

const TASK_DEFINITION_BY_TYPE = new Map(
  TASK_DEFINITIONS.map((definition) => [definition.taskType, definition]),
);

const CARDTRADER_TASK_BY_ACTION = new Map(
  TASK_DEFINITIONS.filter((definition) => definition.actionName).map(
    (definition) => [definition.actionName, definition],
  ),
);

function listTaskDefinitions() {
  return TASK_DEFINITIONS.slice();
}

function getTaskDefinition(taskType) {
  return TASK_DEFINITION_BY_TYPE.get(taskType) ?? null;
}

function getCardTraderTaskDefinition(actionName) {
  return CARDTRADER_TASK_BY_ACTION.get(actionName) ?? null;
}

function validateRequiredRequestEnv(definition, requestEnv = {}) {
  const missing = [];

  for (const field of definition?.requiredRequestEnv ?? []) {
    const value = requestEnv?.[field];
    if (typeof value !== "string" || value.trim() === "") {
      missing.push(field);
    }
  }

  return missing;
}

module.exports = {
  KNOWN_CONCURRENCY_GROUPS,
  KNOWN_TASK_RESOURCES,
  REQUIRED_FIELDS,
  TaskDefinitionValidationError,
  buildTenantFingerprint,
  describeIdempotency,
  getCardTraderTaskDefinition,
  getTaskDefinition,
  listTaskDefinitions,
  assertValidTaskDefinitions,
  validateTaskDefinitions,
  validateRequiredRequestEnv,
};
