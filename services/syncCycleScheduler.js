// Ciclo di sincronizzazione CardTrader -> Vemlora -> eBay.
//
// A ogni tick (SYNC_CYCLE_CRON, default ogni 30 minuti), in sequenza:
//   1. prezzi CardTrader: task `cardtrader.align-prices` nella coda
//   2. Vemlora: prodotti del gestionale e catalogo e-commerce, con il sync a
//      passi del CMS (vedi vemloraSyncService: il CMS gira su Netlify)
//   3. eBay: vendite, quantità e prezzi (runEbayQuantitySync)
//
// L'ordine conta: Vemlora ed eBay leggono da CardTrader i prezzi appena
// aggiornati. Un passo fallito non blocca i successivi, perché le giacenze
// aggiornate servono anche con i prezzi del giro prima.
//
// Opt-in con SYNC_CYCLE_ENABLED=true: con il ciclo attivo eBay ne è l'ultimo
// passo e lo scheduler eBay autonomo non parte (vedi server.js).
const cron = require("node-cron");
const {
  CARDTRADER_TOKEN,
  CMS_URL,
  CMS_CRON_SECRET,
  EBAY_SYNC_ENABLED,
  SYNC_CYCLE_ENABLED,
  SYNC_CYCLE_CRON,
  SYNC_CYCLE_TIMEZONE,
  SYNC_CYCLE_ALIGN_PRICES,
  SYNC_CYCLE_ALIGN_WAIT_MS,
} = require("../config/config");

const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "cancelled"]);
const TASK_POLL_MS = 2_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForTask(queue, taskId, { pollMs, maxWaitMs }) {
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    const task = queue.getTask(taskId);
    if (!task || TERMINAL_TASK_STATUSES.has(task.status)) return task;
    if (Date.now() >= deadline) return task;
    await sleep(pollMs);
  }
}

// Il task passa dalla coda come le esecuzioni manuali: stessa deduplica e
// stesso gruppo `cardtrader-heavy`, quindi mai due allineamenti in parallelo.
// Se ne è già in corso uno avviato a mano si aspetta quello.
async function runAlignPricesStep({
  queue = require("./requestQueue"),
  token = CARDTRADER_TOKEN,
  pollMs = TASK_POLL_MS,
  maxWaitMs = SYNC_CYCLE_ALIGN_WAIT_MS,
} = {}) {
  const { task, deduplicated } = queue.enqueueTask({
    taskType: "cardtrader.align-prices",
    sourceEndpoint: "sync-cycle",
    requestEnv: { cardTraderToken: token },
  });
  const finalTask = await waitForTask(queue, task.id, { pollMs, maxWaitMs });
  const status = finalTask?.status ?? "unknown";

  if (status !== "completed") {
    const reason = finalTask?.error?.message ?? (TERMINAL_TASK_STATUSES.has(status)
      ? status
      : `ancora ${status} dopo ${Math.round(maxWaitMs / 60_000)} minuti`);
    throw new Error(`task ${task.id}${deduplicated ? " (già in corso)" : ""}: ${reason}`);
  }

  return { taskId: task.id, deduplicated, games: finalTask.result ?? null };
}

function buildDefaultSteps() {
  const { createVemloraSync } = require("./vemloraSyncService");
  const { runEbayQuantitySync } = require("./ebaySyncScheduler");
  const cmsConfigured = Boolean(CMS_URL && CMS_CRON_SECRET);

  return [
    {
      name: "prezzi CardTrader",
      enabled: SYNC_CYCLE_ALIGN_PRICES && Boolean(CARDTRADER_TOKEN),
      disabledReason: SYNC_CYCLE_ALIGN_PRICES
        ? "CARDTRADER_TOKEN mancante"
        : "SYNC_CYCLE_ALIGN_PRICES=false",
      run: () => runAlignPricesStep(),
    },
    {
      name: "Vemlora",
      enabled: cmsConfigured && Boolean(CARDTRADER_TOKEN),
      disabledReason: cmsConfigured
        ? "CARDTRADER_TOKEN mancante"
        : "CMS_URL o CMS_CRON_SECRET mancanti",
      run: createVemloraSync(),
    },
    {
      name: "eBay",
      enabled: EBAY_SYNC_ENABLED,
      disabledReason: "EBAY_SYNC_ENABLED != true",
      // runEbayQuantitySync registra da sé esito ed errori; null vuol dire
      // che il giro non è avvenuto.
      run: async () => {
        const outcome = await runEbayQuantitySync();
        if (!outcome) {
          throw new Error("nessun esito: account non collegato, run in corso o errore (vedi [EBAY-SYNC])");
        }
        return outcome;
      },
    },
  ];
}

function createSyncCycle({ steps = buildDefaultSteps, log = console } = {}) {
  let running = false;

  return async function runSyncCycle() {
    if (running) {
      log.warn("[SYNC-CYCLE] Ciclo precedente ancora in corso, salto il tick.");
      return null;
    }

    running = true;
    const startedAt = Date.now();
    const outcomes = [];
    try {
      for (const step of typeof steps === "function" ? steps() : steps) {
        if (!step.enabled) {
          outcomes.push({ step: step.name, status: "skipped", reason: step.disabledReason });
          continue;
        }

        const stepStartedAt = Date.now();
        try {
          const result = await step.run();
          const elapsed = Date.now() - stepStartedAt;
          log.log(`[SYNC-CYCLE] ${step.name}: ok in ${elapsed}ms`);
          outcomes.push({ step: step.name, status: "ok", elapsedMs: elapsed, result });
        } catch (error) {
          log.error(`[SYNC-CYCLE] ${step.name}: FALLITO: ${error.message}`);
          outcomes.push({ step: step.name, status: "failed", error: error.message });
        }
      }

      const failed = outcomes.filter((outcome) => outcome.status === "failed").length;
      log.log(
        `[SYNC-CYCLE] Ciclo completato in ${Date.now() - startedAt}ms | ` +
          outcomes.map((outcome) => `${outcome.step}=${outcome.status}`).join(" | ") +
          (failed ? ` | passi falliti=${failed}` : ""),
      );
      return outcomes;
    } finally {
      running = false;
    }
  };
}

const runSyncCycle = createSyncCycle();

function startSyncCycleScheduler() {
  if (!SYNC_CYCLE_ENABLED) {
    console.log("[SYNC-CYCLE] Ciclo disattivato (SYNC_CYCLE_ENABLED != true).");
    return [];
  }

  const job = cron.schedule(
    SYNC_CYCLE_CRON,
    () =>
      runSyncCycle().catch((error) =>
        console.error("[SYNC-CYCLE] FALLITO:", error.message),
      ),
    { timezone: SYNC_CYCLE_TIMEZONE },
  );

  const steps = buildDefaultSteps()
    .map((step) => (step.enabled ? step.name : `${step.name} (off: ${step.disabledReason})`))
    .join(" -> ");
  console.log(
    `[SYNC-CYCLE] Ciclo attivo | cron='${SYNC_CYCLE_CRON}' | tz=${SYNC_CYCLE_TIMEZONE} | ${steps}`,
  );
  return [job];
}

module.exports = {
  startSyncCycleScheduler,
  runSyncCycle,
  createSyncCycle,
  runAlignPricesStep,
};
