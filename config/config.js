require("dotenv").config();

function numberFromEnv(name, fallback) {
  const rawValue = process.env[name];
  const parsedValue = Number(rawValue);
  return Number.isFinite(parsedValue) ? parsedValue : fallback;
}

function positiveIntegerFromEnv(name, fallback) {
  const parsedValue = numberFromEnv(name, fallback);
  if (!Number.isFinite(parsedValue) || parsedValue < 1) return fallback;
  return Math.floor(parsedValue);
}

module.exports = {
  HOST: process.env.HOST || "0.0.0.0",
  PORT: process.env.PORT || 3010,
  REQUEST_QUEUE_CONCURRENCY: positiveIntegerFromEnv(
    "REQUEST_QUEUE_CONCURRENCY",
    2,
  ),
  TASK_QUEUE_MAX_PENDING: positiveIntegerFromEnv("TASK_QUEUE_MAX_PENDING", 100),
  TASK_QUEUE_HISTORY_LIMIT: positiveIntegerFromEnv(
    "TASK_QUEUE_HISTORY_LIMIT",
    250,
  ),
  TASK_QUEUE_DEFAULT_TIMEOUT_MS: numberFromEnv(
    "TASK_QUEUE_DEFAULT_TIMEOUT_MS",
    15 * 60 * 1000,
  ),
  TASK_PERSISTENCE_ENABLED: process.env.TASK_PERSISTENCE_ENABLED !== "false",
  TASK_PERSISTENCE_MONGO_URI:
    process.env.TASK_PERSISTENCE_MONGO_URI ||
    process.env.MONGODB_URI ||
    process.env.MONGO_URI ||
    "",
  TASK_PERSISTENCE_DB_NAME:
    process.env.TASK_PERSISTENCE_DB_NAME || process.env.DB_NAME || "CMS",
  TASK_PERSISTENCE_COLLECTION:
    process.env.TASK_PERSISTENCE_COLLECTION || "queue_tasks",
  PDF_ARTIFACT_TTL_MS: numberFromEnv("PDF_ARTIFACT_TTL_MS", 24 * 60 * 60 * 1000),
  TASK_RESOURCE_CAPACITIES: {
    cardtrader: positiveIntegerFromEnv(
      "TASK_RESOURCE_CARDTRADER_CAPACITY",
      positiveIntegerFromEnv("CARDTRADER_RESOURCE_CONCURRENCY", 1),
    ),
    database: positiveIntegerFromEnv(
      "TASK_RESOURCE_DATABASE_CAPACITY",
      positiveIntegerFromEnv("DATABASE_RESOURCE_CONCURRENCY", 2),
    ),
    libreoffice: positiveIntegerFromEnv(
      "TASK_RESOURCE_LIBREOFFICE_CAPACITY",
      positiveIntegerFromEnv("LIBREOFFICE_RESOURCE_CONCURRENCY", 1),
    ),
    filesystem: positiveIntegerFromEnv("TASK_RESOURCE_FILESYSTEM_CAPACITY", 2),
    "cpu-heavy": positiveIntegerFromEnv("TASK_RESOURCE_CPU_HEAVY_CAPACITY", 1),
    shopify: positiveIntegerFromEnv("TASK_RESOURCE_SHOPIFY_CAPACITY", 1),
    default: positiveIntegerFromEnv("TASK_RESOURCE_DEFAULT_CAPACITY", 1),
  },
  TASK_CONCURRENCY_GROUP_CAPACITIES: {
    default: positiveIntegerFromEnv(
      "TASK_CONCURRENCY_GROUP_DEFAULT_CAPACITY",
      positiveIntegerFromEnv("REQUEST_QUEUE_CONCURRENCY", 2),
    ),
    "cardtrader-heavy": positiveIntegerFromEnv(
      "TASK_CONCURRENCY_GROUP_CARDTRADER_HEAVY_CAPACITY",
      1,
    ),
    "cardtrader-maintenance": positiveIntegerFromEnv(
      "TASK_CONCURRENCY_GROUP_CARDTRADER_MAINTENANCE_CAPACITY",
      1,
    ),
    excel: positiveIntegerFromEnv("TASK_CONCURRENCY_GROUP_EXCEL_CAPACITY", 1),
    "cpu-heavy": positiveIntegerFromEnv(
      "TASK_CONCURRENCY_GROUP_CPU_HEAVY_CAPACITY",
      1,
    ),
    shopify: positiveIntegerFromEnv("TASK_CONCURRENCY_GROUP_SHOPIFY_CAPACITY", 1),
  },
  CARDTRADER_RESOURCE_CONCURRENCY: positiveIntegerFromEnv(
    "CARDTRADER_RESOURCE_CONCURRENCY",
    1,
  ),
  DATABASE_RESOURCE_CONCURRENCY: positiveIntegerFromEnv(
    "DATABASE_RESOURCE_CONCURRENCY",
    2,
  ),
  LIBREOFFICE_RESOURCE_CONCURRENCY: positiveIntegerFromEnv(
    "LIBREOFFICE_RESOURCE_CONCURRENCY",
    1,
  ),
  // Limiti documentati da CardTrader: 200 richieste / 10s su tutti gli endpoint,
  // 10 req/s su marketplace/products, 1 req/s su jobs. Teniamo un margine di
  // sicurezza perche' la finestra lato server non e' allineata alla nostra.
  CARDTRADER_RATE_LIMIT_WINDOW_MS: numberFromEnv(
    "CARDTRADER_RATE_LIMIT_WINDOW_MS",
    10 * 1000,
  ),
  CARDTRADER_RATE_LIMIT_MAX_REQUESTS: numberFromEnv(
    "CARDTRADER_RATE_LIMIT_MAX_REQUESTS",
    180,
  ),
  CARDTRADER_RATE_LIMIT_COOLDOWN_MS: numberFromEnv(
    "CARDTRADER_RATE_LIMIT_COOLDOWN_MS",
    10 * 1000,
  ),
  CARDTRADER_SCOPE_RATE_LIMITS: {
    marketplace: {
      windowMs: numberFromEnv("CARDTRADER_MARKETPLACE_RATE_LIMIT_WINDOW_MS", 1000),
      maxRequests: numberFromEnv("CARDTRADER_MARKETPLACE_RATE_LIMIT_MAX_REQUESTS", 8),
      cooldownMs: numberFromEnv("CARDTRADER_MARKETPLACE_RATE_LIMIT_COOLDOWN_MS", 2000),
    },
    jobs: {
      windowMs: numberFromEnv("CARDTRADER_JOBS_RATE_LIMIT_WINDOW_MS", 1000),
      maxRequests: numberFromEnv("CARDTRADER_JOBS_RATE_LIMIT_MAX_REQUESTS", 1),
      cooldownMs: numberFromEnv("CARDTRADER_JOBS_RATE_LIMIT_COOLDOWN_MS", 2000),
    },
  },
  CARDTRADER_REQUEST_TIMEOUT_MS: numberFromEnv(
    "CARDTRADER_REQUEST_TIMEOUT_MS",
    30 * 1000,
  ),
  // products/export puo' richiedere 120-180s su collezioni grandi (doc CardTrader).
  CARDTRADER_EXPORT_TIMEOUT_MS: numberFromEnv(
    "CARDTRADER_EXPORT_TIMEOUT_MS",
    180 * 1000,
  ),
  CARDTRADER_MARKETPLACE_TIMEOUT_MS: numberFromEnv(
    "CARDTRADER_MARKETPLACE_TIMEOUT_MS",
    120 * 1000,
  ),
  CARDTRADER_MAX_RETRIES: numberFromEnv("CARDTRADER_MAX_RETRIES", 3),
  CARDTRADER_RETRY_BASE_DELAY_MS: numberFromEnv(
    "CARDTRADER_RETRY_BASE_DELAY_MS",
    1_000,
  ),
  // Quante espansioni marketplace tenere in volo contemporaneamente: e' anche il
  // tetto alla memoria occupata (una singola espansione puo' pesare decine di MB).
  ALIGN_PRICE_EXPANSION_CONCURRENCY: positiveIntegerFromEnv(
    "ALIGN_PRICE_EXPANSION_CONCURRENCY",
    6,
  ),
  // Scarica dal marketplace solo le lingue che abbiamo davvero a magazzino.
  ALIGN_PRICE_LANGUAGE_FILTER:
    process.env.ALIGN_PRICE_LANGUAGE_FILTER !== "false",
  // Aggiornamento prezzi via POST /products/bulk_update invece di N PUT singole.
  ALIGN_PRICE_BULK_UPDATE:
    process.env.ALIGN_PRICE_BULK_UPDATE !== "false",
  ALIGN_PRICE_BULK_UPDATE_SIZE: positiveIntegerFromEnv(
    "ALIGN_PRICE_BULK_UPDATE_SIZE",
    250,
  ),
  ALIGN_PRICE_JOB_WAIT_MS: numberFromEnv("ALIGN_PRICE_JOB_WAIT_MS", 120 * 1000),
  ALIGN_PRICE_INTER_GAME_DELAY_MS: numberFromEnv(
    "ALIGN_PRICE_INTER_GAME_DELAY_MS",
    0,
  ),
  // Ad ogni allineamento l'export inventario viene registrato nel tracking
  // prezzi: gli articoli nuovi entrano con il prezzo di carico corrente prima
  // che il prezzatore lo modifichi, senza aspettare una vendita.
  ALIGN_PRICE_TRACK_INVENTORY:
    process.env.ALIGN_PRICE_TRACK_INVENTORY !== "false",
  CARDTRADER_TOKEN: process.env.CARDTRADER_TOKEN,

  // Scheduler cron verso il CMS: chiama gli endpoint /api/cron/* del gestionale
  // (solleciti pagamento + valutazione notifiche) a intervalli regolari.
  // Disattivo se CMS_URL o CMS_CRON_SECRET non sono impostati.
  CMS_URL: String(process.env.CMS_URL || "").trim().replace(/\/+$/, ""),
  CMS_CRON_SECRET: String(process.env.CMS_CRON_SECRET || "").trim(),
  CMS_CRON_TIMEZONE: process.env.CMS_CRON_TIMEZONE || "Europe/Rome",
  CMS_CRON_NOTIFICATIONS: process.env.CMS_CRON_NOTIFICATIONS || "*/15 * * * *",
  CMS_CRON_REMINDERS: process.env.CMS_CRON_REMINDERS || "0 7 * * *",
  CMS_CRON_TIMEOUT_MS: numberFromEnv("CMS_CRON_TIMEOUT_MS", 15 * 60 * 1000),

  // Sincronizzazione quantità/prezzi delle inserzioni eBay con CardTrader.
  // Opt-in esplicito: i tick vengono comunque saltati se l'account eBay non
  // è collegato.
  EBAY_SYNC_ENABLED: process.env.EBAY_SYNC_ENABLED === "true",
  EBAY_SYNC_CRON: process.env.EBAY_SYNC_CRON || "*/30 * * * *",
  // Pubblicazione automatica dei prodotti CardTrader nuovi a ogni giro.
  EBAY_AUTO_PUBLISH_NEW: process.env.EBAY_AUTO_PUBLISH_NEW === "true",
  EBAY_AUTO_PUBLISH_MAX_PER_RUN: positiveIntegerFromEnv("EBAY_AUTO_PUBLISH_MAX_PER_RUN", 100),
  EBAY_SYNC_TIMEZONE:
    process.env.EBAY_SYNC_TIMEZONE || process.env.CMS_CRON_TIMEZONE || "Europe/Rome",

  PROCESSED_ORDERS_FILE: "processed_orders.txt",
  DDT_NUMBER_FILE: "ddt_number.txt",
  TEMPLATE_FILE: "./template.xlsx",
  CARDMARKET_DIR: "cardmarket-file",
};
