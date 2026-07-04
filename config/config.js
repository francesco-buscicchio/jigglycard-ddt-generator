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
  CARDTRADER_RATE_LIMIT_WINDOW_MS: numberFromEnv(
    "CARDTRADER_RATE_LIMIT_WINDOW_MS",
    15 * 1000,
  ),
  CARDTRADER_RATE_LIMIT_MAX_REQUESTS: numberFromEnv(
    "CARDTRADER_RATE_LIMIT_MAX_REQUESTS",
    200,
  ),
  CARDTRADER_RATE_LIMIT_COOLDOWN_MS: numberFromEnv(
    "CARDTRADER_RATE_LIMIT_COOLDOWN_MS",
    15 * 1000,
  ),
  CARDTRADER_REQUEST_TIMEOUT_MS: numberFromEnv(
    "CARDTRADER_REQUEST_TIMEOUT_MS",
    30 * 1000,
  ),
  CARDTRADER_MAX_RETRIES: numberFromEnv("CARDTRADER_MAX_RETRIES", 3),
  CARDTRADER_RETRY_BASE_DELAY_MS: numberFromEnv(
    "CARDTRADER_RETRY_BASE_DELAY_MS",
    1_000,
  ),
  ALIGN_PRICE_WORKERS: numberFromEnv("ALIGN_PRICE_WORKERS", 32),
  ALIGN_PRICE_INTER_GAME_DELAY_MS: numberFromEnv(
    "ALIGN_PRICE_INTER_GAME_DELAY_MS",
    0,
  ),
  CARDTRADER_TOKEN: process.env.CARDTRADER_TOKEN,
  PROCESSED_ORDERS_FILE: "processed_orders.txt",
  DDT_NUMBER_FILE: "ddt_number.txt",
  TEMPLATE_FILE: "./template.xlsx",
  CARDMARKET_DIR: "cardmarket-file",
};
