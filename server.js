const express = require("express");
const cors = require("cors");

const { PORT } = require("./config/config");

const cardtraderRoute = require("./routes/cardtrader");
const cardmarketRoute = require("./routes/cardmarket");
const snifferRoute = require("./routes/sniffer");
const driveRoute = require("./routes/drive");
const { connectDB } = require("./config/db");

(async () => {
  try {
    await connectDB();

    const app = express();

    // ✅ Abilita CORS sulla vera istanza
    app.use(
      cors({
        origin: "*",
        methods: ["GET", "POST"],
      })
    );

    // ✅ Middlewares e routes
    app.use("/cardtrader", cardtraderRoute);
    app.use("/cardmarket", cardmarketRoute);
    app.use("/sniffer", snifferRoute);
    app.use("/drive", driveRoute);

    app.listen(PORT, () =>
      console.log(`🚀  Server in ascolto su http://localhost:${PORT}`)
    );
  } catch (err) {
    console.error("Errore di avvio:", err);
    process.exit(1);
  }
})();
