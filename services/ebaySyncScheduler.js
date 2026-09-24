// Scheduler della sincronizzazione quantità/prezzi CardTrader -> eBay.
//
// A ogni tick riallinea le inserzioni pubblicate alla disponibilità reale su
// CardTrader (vedi ebaySyncService.syncQuantities): quantità aggiornate,
// esauriti portati a zero, articoli tornati disponibili ripubblicati.
//
// Attivo solo con EBAY_SYNC_ENABLED=true; ogni tick viene comunque saltato se
// l'account eBay non è collegato, quindi è sicuro lasciarlo acceso.
const cron = require("node-cron");
const {
  EBAY_SYNC_ENABLED,
  EBAY_SYNC_CRON,
  EBAY_SYNC_TIMEZONE,
  EBAY_AUTO_PUBLISH_NEW,
  EBAY_AUTO_PUBLISH_MAX_PER_RUN,
} = require("../config/config");
const ebayService = require("./ebayService");
const ebaySyncService = require("./ebaySyncService");

// Evita sovrapposizioni: se il run precedente è ancora in corso, salta il tick.
let running = false;

async function runEbayQuantitySync() {
  if (running) {
    console.warn("[EBAY-SYNC] Run precedente ancora in corso, salto il tick.");
    return null;
  }

  if (!ebayService.getConnectionStatus().connected) {
    console.log("[EBAY-SYNC] Account eBay non collegato, salto il tick.");
    return null;
  }

  running = true;
  const startedAt = Date.now();
  try {
    // Prima le vendite eBay -> CardTrader, poi CardTrader -> eBay: così un
    // articolo appena venduto su eBay risulta già scalato su CardTrader.
    try {
      const sales = await ebaySyncService.syncSalesToCardTrader();
      if (sales.initialized) {
        console.log(`[EBAY-SYNC] Registro vendite inizializzato con ${sales.seeded} vendite esistenti.`);
      } else if (sales.decremented || sales.failed) {
        console.log(`[EBAY-SYNC] Vendite eBay scalate su CardTrader: ${sales.decremented}, errori: ${sales.failed}`);
        for (const r of sales.results.filter((x) => !x.ok)) {
          console.error(`[EBAY-SYNC] Vendita ${r.sku}: ${r.error}`);
        }
      }
    } catch (error) {
      console.error("[EBAY-SYNC] Scalo vendite su CardTrader FALLITO:", error.message);
    }

    const outcome = await ebaySyncService.syncQuantities();
    console.log(
      `[EBAY-SYNC] ok in ${Date.now() - startedAt}ms | verificati=${outcome.checked} ` +
        `invariati=${outcome.unchanged} aggiornati=${outcome.updated} ` +
        `esauriti=${outcome.soldOut} ripubblicati=${outcome.revived} errori=${outcome.failed}`,
    );
    if (outcome.failed > 0) {
      for (const result of outcome.results.filter((r) => !r.ok).slice(0, 10)) {
        console.error(`[EBAY-SYNC] ${result.sku ?? result.productId}: ${result.error}`);
      }
    }

    if (EBAY_AUTO_PUBLISH_NEW) {
      try {
        const auto = await ebaySyncService.autoPublishNewProducts({
          maxPerRun: EBAY_AUTO_PUBLISH_MAX_PER_RUN,
        });
        if (auto.candidates > 0) {
          console.log(
            `[EBAY-SYNC] Nuovi prodotti: pubblicati=${auto.published} falliti=${auto.failed} ` +
              `in coda=${auto.remaining}`,
          );
        }
      } catch (error) {
        console.error("[EBAY-SYNC] Pubblicazione automatica FALLITA:", error.message);
      }
    }

    return outcome;
  } catch (error) {
    console.error("[EBAY-SYNC] FALLITO:", error.message);
    return null;
  } finally {
    running = false;
  }
}

function startEbaySyncScheduler() {
  if (!EBAY_SYNC_ENABLED) {
    console.log("[EBAY-SYNC] Scheduler disattivato (EBAY_SYNC_ENABLED != true).");
    return [];
  }

  const job = cron.schedule(EBAY_SYNC_CRON, runEbayQuantitySync, {
    timezone: EBAY_SYNC_TIMEZONE,
  });

  console.log(
    `[EBAY-SYNC] Scheduler attivo | cron='${EBAY_SYNC_CRON}' | tz=${EBAY_SYNC_TIMEZONE} | ` +
      `pubblicazione nuovi=${EBAY_AUTO_PUBLISH_NEW ? `sì (max ${EBAY_AUTO_PUBLISH_MAX_PER_RUN}/giro)` : "no"}`,
  );
  return [job];
}

module.exports = { startEbaySyncScheduler, runEbayQuantitySync };
