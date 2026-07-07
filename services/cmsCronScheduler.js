// Scheduler cron verso il CMS (Vemlora / Jigglycard-CMS).
//
// Sostituisce i nitro `scheduledTasks` del CMS, che non vengono eseguiti su
// runtime serverless. Qui, su questo servizio node persistente, pianifichiamo
// le chiamate M2M agli endpoint del CMS:
//   - POST {CMS_URL}/api/cron/notifications  (ogni 15 min)
//   - POST {CMS_URL}/api/cron/reminders      (giornaliero 07:00)
// autenticate con l'header `x-cron-secret` (= CRON_SECRET lato CMS).
//
// Lo scheduler è inerte se CMS_URL o CMS_CRON_SECRET non sono configurati.
const cron = require("node-cron");
const axios = require("axios");
const {
  CMS_URL,
  CMS_CRON_SECRET,
  CMS_CRON_TIMEZONE,
  CMS_CRON_NOTIFICATIONS,
  CMS_CRON_REMINDERS,
  CMS_CRON_TIMEOUT_MS,
} = require("../config/config");

// Evita sovrapposizioni: se un job precedente è ancora in corso, salta il tick.
const running = new Set();

async function callCmsCronTask(path, label) {
  if (running.has(label)) {
    console.warn(`[CMS-CRON] ${label}: run precedente ancora in corso, salto.`);
    return;
  }
  running.add(label);
  const startedAt = Date.now();
  try {
    const response = await axios.post(
      `${CMS_URL}${path}`,
      {},
      {
        headers: { "x-cron-secret": CMS_CRON_SECRET },
        timeout: CMS_CRON_TIMEOUT_MS,
      },
    );
    const elapsed = Date.now() - startedAt;
    console.log(
      `[CMS-CRON] ${label}: ok in ${elapsed}ms |`,
      JSON.stringify(response.data?.result ?? response.data ?? {}),
    );
  } catch (error) {
    const status = error?.response?.status;
    const detail =
      error?.response?.data?.statusMessage ||
      error?.response?.data?.error ||
      error?.message ||
      "errore sconosciuto";
    console.error(
      `[CMS-CRON] ${label}: FALLITO${status ? ` (HTTP ${status})` : ""}: ${detail}`,
    );
  } finally {
    running.delete(label);
  }
}

function startCmsCronScheduler() {
  if (!CMS_URL || !CMS_CRON_SECRET) {
    console.log(
      "[CMS-CRON] Scheduler disattivato: CMS_URL o CMS_CRON_SECRET mancanti.",
    );
    return [];
  }

  const options = { timezone: CMS_CRON_TIMEZONE };
  const jobs = [
    cron.schedule(
      CMS_CRON_NOTIFICATIONS,
      () => callCmsCronTask("/api/cron/notifications", "notifications:evaluate"),
      options,
    ),
    cron.schedule(
      CMS_CRON_REMINDERS,
      () => callCmsCronTask("/api/cron/reminders", "reminders:payments"),
      options,
    ),
  ];

  console.log(
    `[CMS-CRON] Scheduler attivo | CMS=${CMS_URL} | tz=${CMS_CRON_TIMEZONE} | ` +
      `notifiche='${CMS_CRON_NOTIFICATIONS}' | solleciti='${CMS_CRON_REMINDERS}'`,
  );
  return jobs;
}

module.exports = { startCmsCronScheduler, callCmsCronTask };
