const express = require("express");
const cors = require("cors");
require("dotenv").config();

const { connectDB } = require("./config/db");
const { PORT } = require("./config/config");

const cardtraderRoute = require("./routes/cardtrader");
const cardmarketRoute = require("./routes/cardmarket");
const snifferRoute = require("./routes/sniffer");
const driveRoute = require("./routes/drive");

(async () => {
  try {
    await connectDB();

    const app = express();

    app.use(
      cors({
        origin: "*",
        methods: ["GET", "POST"],
      })
    );

    app.use("/cardtrader", cardtraderRoute);
    app.use("/cardmarket", cardmarketRoute);
    app.use("/sniffer", snifferRoute);
    app.use("/drive", driveRoute);

    app.listen(PORT || 3000, () => {
      console.log(`✅ Server in ascolto su http://localhost:${PORT || 3000}`);
    });
  } catch (error) {
    console.error("❌ Errore durante l'avvio locale:", error);
    process.exit(1);
  }
})();
