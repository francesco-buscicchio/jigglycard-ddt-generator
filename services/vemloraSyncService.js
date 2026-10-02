// Passo Vemlora del ciclo di sincronizzazione: porta l'inventario CardTrader
// nel CMS con il sync a passi (Jigglycard-CMS, cardtrader/syncRunService).
//
// Il CMS gira su Netlify, dove ogni richiesta viene interrotta a circa 30
// secondi: qui, senza
// limiti di tempo, si scarica l'export, lo si carica a blocchi e si
// richiamano le fasi finché il CMS non risponde `done`:
//   start -> upload (n) -> products (n) -> storefront (n) -> finish
// Il CMS segna il lavoro fatto per blueprint, quindi ogni chiamata si può
// ritentare senza rifare nulla.
const axios = require("axios");
const { CMS_URL, CMS_CRON_SECRET, CARDTRADER_TOKEN } = require("../config/config");

const UPLOAD_CHUNK_BLUEPRINTS = 400;
// Oltre il limite di Netlify: se la funzione viene interrotta arriva comunque
// una risposta d'errore, e la chiamata si ritenta.
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_PHASE_CALLS = 600;
const MAX_CONSECUTIVE_FAILURES = 6;
const RETRY_DELAY_MS = 5_000;
// Il lock di una fase dura 45 s: un 409 si ritenta dopo un'attesa più lunga.
const LOCKED_RETRY_DELAY_MS = 15_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function groupByBlueprint(items) {
  const grouped = new Map();
  for (const item of items) {
    // Number(null) è 0: senza questo controllo finirebbero tutte nel blueprint 0.
    if (item?.blueprint_id == null || item.blueprint_id === "") continue;
    const blueprintId = Number(item.blueprint_id);
    if (!Number.isFinite(blueprintId)) continue;
    if (!grouped.has(blueprintId)) grouped.set(blueprintId, []);
    grouped.get(blueprintId).push(item);
  }
  return Array.from(grouped, ([blueprintId, blueprintItems]) => ({
    blueprintId,
    items: blueprintItems,
  }));
}

const describeError = (error) => {
  const status = error?.response?.status;
  const detail =
    error?.response?.data?.statusMessage ||
    error?.response?.data?.message ||
    error?.message ||
    "errore sconosciuto";
  return `${status ? `HTTP ${status}: ` : ""}${detail}`;
};

// 4xx diversi da 409 sono errori di richiesta: ritentare non serve.
const isRetryable = (error) => {
  const status = error?.response?.status;
  return !status || status >= 500 || status === 409 || status === 429;
};

async function fetchCardTraderExport() {
  const { createCardTraderService } = require("./cardTraderService");
  const response = await createCardTraderService({
    cardTraderToken: CARDTRADER_TOKEN,
  }).getMyProducts();
  return Array.isArray(response?.data) ? response.data : [];
}

function createVemloraSync({
  http = axios,
  baseUrl = CMS_URL,
  secret = CMS_CRON_SECRET,
  fetchExport = fetchCardTraderExport,
  wait = sleep,
  log = console,
} = {}) {
  async function post(path, body) {
    let failures = 0;
    for (;;) {
      try {
        const response = await http.post(`${baseUrl}/api/cron/cardtrader-sync/${path}`, body, {
          headers: { "x-cron-secret": secret },
          timeout: REQUEST_TIMEOUT_MS,
        });
        return response.data;
      } catch (error) {
        failures += 1;
        if (!isRetryable(error) || failures >= MAX_CONSECUTIVE_FAILURES) {
          throw new Error(`${path}: ${describeError(error)}`);
        }
        log.warn(`[VEMLORA-SYNC] ${path}: ${describeError(error)}, riprovo (${failures})`);
        await wait(error?.response?.status === 409 ? LOCKED_RETRY_DELAY_MS : RETRY_DELAY_MS);
      }
    }
  }

  async function runPhase(phase, runId) {
    for (let call = 1; call <= MAX_PHASE_CALLS; call += 1) {
      const result = await post(phase, { runId });
      log.log(
        `[VEMLORA-SYNC] ${phase}: chiamata ${call}, fase=${result?.phase ?? "?"} ` +
          `restanti=${result?.remaining ?? "?"} tempi=${JSON.stringify(result?.timings ?? {})}`,
      );
      if (result?.done) return { ...result, calls: call };
    }
    throw new Error(`${phase}: non conclusa dopo ${MAX_PHASE_CALLS} chiamate`);
  }

  return async function syncVemlora() {
    const startedAt = Date.now();
    const items = await fetchExport();
    const blueprints = groupByBlueprint(items);
    if (!blueprints.length) {
      throw new Error("Export CardTrader vuoto: sync Vemlora annullato");
    }

    const { runId } = await post("start", { expectedBlueprints: blueprints.length });
    for (let index = 0; index < blueprints.length; index += UPLOAD_CHUNK_BLUEPRINTS) {
      await post("upload", {
        runId,
        blueprints: blueprints.slice(index, index + UPLOAD_CHUNK_BLUEPRINTS),
      });
    }
    log.log(`[VEMLORA-SYNC] ${runId}: caricati ${blueprints.length} blueprint (${items.length} righe)`);

    // Prodotti del gestionale e catalogo e-commerce sono indipendenti: un
    // errore nel primo non deve fermare il secondo.
    const failures = [];
    let products = null;
    let storefront = null;
    try {
      products = await runPhase("products", runId);
    } catch (error) {
      failures.push(error.message);
    }
    try {
      storefront = await runPhase("storefront", runId);
    } catch (error) {
      failures.push(error.message);
    }

    // Senza finish i dati di appoggio scadono comunque dopo un giorno.
    const summary = await post("finish", { runId }).catch((error) => {
      failures.push(error.message);
      return null;
    });

    if (failures.length) throw new Error(failures.join(" | "));
    return {
      runId,
      sourceRows: items.length,
      blueprints: blueprints.length,
      products: summary?.products?.stats ?? products?.totals ?? null,
      storefront: summary?.storefront ?? storefront,
      calls: { products: products?.calls ?? 0, storefront: storefront?.calls ?? 0 },
      durationMs: Date.now() - startedAt,
    };
  };
}

module.exports = { createVemloraSync, groupByBlueprint };
