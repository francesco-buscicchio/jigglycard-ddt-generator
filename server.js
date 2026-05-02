const express = require("express");
const os = require("os");
const { HOST, PORT } = require("./config/config");
const originGate = require("./middleware/originGate");
const apiAuth = require("./middleware/apiAuth");
const requestContext = require("./middleware/requestContext");
const requestQueue = require("./services/requestQueue");
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

function startServer() {
  const app = createApp();
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
