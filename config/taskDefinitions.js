const { createHash } = require("crypto");

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
    weight: 10,
    resources: ["cardtrader"],
    concurrencyGroup: "cardtrader-heavy",
    timeoutMs: 45 * 60 * 1000,
    maxRetries: 0,
    allowApiCreate: true,
    allowManualRetry: false,
    idempotent: false,
    requiredRequestEnv: ["cardTraderToken"],
    notes:
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
    weight: 8,
    resources: ["cardtrader"],
    concurrencyGroup: "cardtrader-heavy",
    timeoutMs: 20 * 60 * 1000,
    maxRetries: 0,
    allowApiCreate: true,
    allowManualRetry: false,
    idempotent: false,
    requiredRequestEnv: ["cardTraderToken"],
    notes: "Aggiorna prezzi solo per il catalogo Pokemon.",
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
    weight: 8,
    resources: ["cardtrader"],
    concurrencyGroup: "cardtrader-heavy",
    timeoutMs: 20 * 60 * 1000,
    maxRetries: 0,
    allowApiCreate: true,
    allowManualRetry: false,
    idempotent: false,
    requiredRequestEnv: ["cardTraderToken"],
    notes: "Aggiorna prezzi solo per il catalogo Dragon Ball.",
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
    weight: 8,
    resources: ["cardtrader"],
    concurrencyGroup: "cardtrader-heavy",
    timeoutMs: 20 * 60 * 1000,
    maxRetries: 0,
    allowApiCreate: true,
    allowManualRetry: false,
    idempotent: false,
    requiredRequestEnv: ["cardTraderToken"],
    notes: "Aggiorna prezzi solo per il catalogo One Piece.",
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
    weight: 5,
    resources: ["cardtrader", "database"],
    concurrencyGroup: "cardtrader-heavy",
    timeoutMs: 30 * 60 * 1000,
    maxRetries: 1,
    allowApiCreate: true,
    allowManualRetry: true,
    idempotent: false,
    requiredRequestEnv: ["cardTraderToken", "effectiveMongoUri"],
    notes:
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
    weight: 6,
    resources: ["cardtrader", "database"],
    concurrencyGroup: "cardtrader-maintenance",
    timeoutMs: 20 * 60 * 1000,
    maxRetries: 2,
    allowApiCreate: true,
    allowManualRetry: true,
    idempotent: true,
    requiredRequestEnv: ["cardTraderToken", "effectiveMongoUri"],
    notes: "Usa upsert nel DB per evitare duplicati booster.",
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
    weight: 3,
    resources: ["libreoffice"],
    concurrencyGroup: "excel-conversion",
    timeoutMs: 10 * 60 * 1000,
    maxRetries: 0,
    allowApiCreate: false,
    allowManualRetry: false,
    idempotent: true,
    requiredRequestEnv: [],
    notes: "Salva l'artefatto PDF su disco e lo rende scaricabile via task result.",
    risks: "Può saturare CPU e I/O se eseguito in parallelo senza limiti.",
    buildPayloadSummary: summarizeFilePayload,
  },
];

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
  buildTenantFingerprint,
  getCardTraderTaskDefinition,
  getTaskDefinition,
  listTaskDefinitions,
  validateRequiredRequestEnv,
};
