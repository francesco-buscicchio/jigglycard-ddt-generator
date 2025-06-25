const express = require("express");
const serverless = require("serverless-http");
const cors = require("cors");

const { connectDB } = require("./config/db");

const cardtraderRoute = require("./routes/cardtrader");
const cardmarketRoute = require("./routes/cardmarket");
const snifferRoute = require("./routes/sniffer");
const driveRoute = require("./routes/drive");

let cachedHandler; // Cache del handler

async function getHandler() {
  if (!cachedHandler) {
    const app = express();

    app.use(
      cors({
        origin: "*",
        methods: ["GET", "POST"],
      })
    );

    app.use("/api/cardtrader", cardtraderRoute);
    app.use("/api/cardmarket", cardmarketRoute);
    app.use("/api/sniffer", snifferRoute);
    app.use("/api/drive", driveRoute);

    await connectDB(); // Connessione DB una volta sola
    cachedHandler = serverless(app);
  }

  return cachedHandler;
}

module.exports = async (req, res) => {
  try {
    const handler = await getHandler();
    return handler(req, res);
  } catch (err) {
    console.error("Errore durante la connessione o inizializzazione:", err);
    res.status(500).send("Errore del server");
  }
};
