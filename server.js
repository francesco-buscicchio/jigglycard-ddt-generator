const express = require("express");
const cors = require("cors");

const { connectDB } = require("./config/db");
const { PORT } = require("./config/config");

const cardtraderRoute = require("./routes/cardtrader");
const cardmarketRoute = require("./routes/cardmarket");
const snifferRoute = require("./routes/sniffer");
const driveRoute = require("./routes/drive");

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

(async () => {
  try {
    await connectDB();
    app.listen(PORT, () => {
      console.log(`Server attivo su http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error("Errore inizializzazione:", err);
  }
})();
