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
  CARDTRADER_RESOURCE_CONCURRENCY: numberFromEnv(
    "CARDTRADER_RESOURCE_CONCURRENCY",
    1,
  ),
  DATABASE_RESOURCE_CONCURRENCY: numberFromEnv(
    "DATABASE_RESOURCE_CONCURRENCY",
    2,
  ),
  LIBREOFFICE_RESOURCE_CONCURRENCY: numberFromEnv(
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
