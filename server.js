const express = require("express");
const serverless = require("serverless-http");
const cors = require("cors");
require("dotenv").config();

const { connectDB } = require("../config/db");

const cardtraderRoute = require("../routes/cardtrader");
const cardmarketRoute = require("../routes/cardmarket");
const snifferRoute = require("../routes/sniffer");
const driveRoute = require("../routes/drive");

const app = express();

// CORS
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST"],
  })
);

// Middleware e routes
app.use("/api/cardtrader", cardtraderRoute);
app.use("/api/cardmarket", cardmarketRoute);
app.use("/api/sniffer", snifferRoute);
app.use("/api/drive", driveRoute);

let handler;

(async () => {
  try {
    await connectDB();
    handler = serverless(app);
  } catch (err) {
    console.error("Errore inizializzazione:", err);
    handler = async (req, res) => {
      res.status(500).send("Errore durante la connessione al database.");
    };
  }
})();

module.exports = async (req, res) => {
  if (handler) {
    return handler(req, res);
  } else {
    res.status(503).send("Server non ancora inizializzato");
  }
};
