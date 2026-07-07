const express = require("express");
const os = require("os");
const {
  HOST,
  PORT,
  TASK_PERSISTENCE_ENABLED,
  TASK_PERSISTENCE_MONGO_URI,
  PDF_ARTIFACT_TTL_MS,
} = require("./config/config");
const originGate = require("./middleware/originGate");
const apiAuth = require("./middleware/apiAuth");
const requestContext = require("./middleware/requestContext");
const requestQueue = require("./services/requestQueue");
const { startCmsCronScheduler } = require("./services/cmsCronScheduler");
const { MongoTaskStore } = require("./services/taskStore");
const { pruneExpiredArtifacts } = require("./services/excelConversionService");
const cardtraderRoutes = require("./routes/cardtrader");
const excelRoutes = require("./routes/excel");
const taskRoutes = require("./routes/tasks");

function getServerUrls(host, port) {
  const urls = new Set();

  if (host === "0.0.0.0" || host === "::") {
    urls.add(`http://localhost:${port}`);

    const interfaces = os.networkInterfaces();
    for (const networkInterface of Object.values(interfaces)) {
      for (const details of networkInterface ?? []) {
        if (details.family !== "IPv4" || details.internal) continue;
        urls.add(`http://${details.address}:${port}`);
      }
    }

    return [...urls];
  }

  urls.add(`http://${host}:${port}`);
  return [...urls];
}

function createApp() {
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: true, limit: "10mb" }));

  app.get("/", (_req, res) => {
    res.status(200).json({
      status: "online",
      mode: process.env.NODE_ENV || "development",
      timestamp: new Date().toISOString(),
    });
  });

  app.use("/api", originGate);

  app.get("/api/health", (_req, res) => {
    res.status(200).json({
      status: "ok",
      mode: process.env.NODE_ENV || "development",
      timestamp: new Date().toISOString(),
    });
  });

  app.use("/api", requestContext);
  app.use("/api", apiAuth);

  app.get("/api/queue/status", (_req, res) => {
    res.status(200).json(requestQueue.getSnapshot());
  });

  app.use("/api/cardtrader", cardtraderRoutes);
  app.use("/api/excel", excelRoutes);
  app.use("/api", taskRoutes);

  app.use((req, res) => {
    res.status(404).json({
      error: `Endpoint non trovato: ${req.method} ${req.originalUrl}`,
      requestId: req.requestId ?? null,
    });
  });

  app.use((error, req, res, _next) => {
    console.error(
      `[SERVER] Errore non gestito requestId=${req?.requestId ?? "n/a"}:`,
      error,
    );
    res.status(500).json({
      error: "Errore interno del server.",
      requestId: req?.requestId ?? null,
    });
  });

  return app;
}

// Persistenza coda (VN-16): collega lo store Mongo e recupera i task dopo un
// restart. Se lo store non è configurato o non raggiungibile, la coda parte
// comunque in modalità solo-memoria (degradata ma funzionante).
async function initQueuePersistence() {
  if (!TASK_PERSISTENCE_ENABLED || !TASK_PERSISTENCE_MONGO_URI) {
    console.log(
      "[SERVER] Persistenza coda disattivata: la coda opera solo in memoria.",
    );
    return null;
  }

  try {
    const store = await new MongoTaskStore().init();
    requestQueue.attachStore(store);
    const { restoredCount, requeuedCount } = await requestQueue.restoreFromStore();
    console.log(
      `[SERVER] Persistenza coda attiva | task ripristinati=${restoredCount} | riaccodati=${requeuedCount}`,
    );
    return store;
  } catch (error) {
    console.error(
      "[SERVER] Persistenza coda non disponibile, avvio in solo-memoria:",
      error.message,
    );
    return null;
  }
}

function startArtifactRetention() {
  const runSweep = () =>
    pruneExpiredArtifacts({ ttlMs: PDF_ARTIFACT_TTL_MS })
      .then(({ removedCount }) => {
        if (removedCount > 0) {
          console.log(`[SERVER] Retention PDF: rimossi ${removedCount} artefatti scaduti.`);
        }
      })
      .catch((error) =>
        console.error("[SERVER] Retention PDF fallita:", error.message),
      );

  runSweep();
  const timer = setInterval(runSweep, 60 * 60 * 1000);
  timer.unref();
  return timer;
}

function startServer() {
  const app = createApp();
  const retentionTimer = startArtifactRetention();
  const cmsCronJobs = startCmsCronScheduler();

  initQueuePersistence().finally(() => {
    requestQueue.startScheduler();
  });

  const server = app.listen(PORT, HOST, () => {
    const address = server.address();
    const resolvedPort =
      typeof address === "object" && address?.port ? address.port : PORT;

    console.log(
      `[SERVER] Modalita=${process.env.NODE_ENV || "development"} | coda-concurrency=${requestQueue.concurrency}`,
    );

    for (const url of getServerUrls(HOST, resolvedPort)) {
      console.log(`[SERVER] In ascolto su ${url}`);
    }
  });

  server.on("close", () => {
    requestQueue.stopScheduler();
    clearInterval(retentionTimer);
    cmsCronJobs.forEach((job) => job.stop());
  });

  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = {
  createApp,
  getServerUrls,
  startServer,
};
