const express = require("express");
const cron = require("node-cron");
const { connectDB } = require("./config/db");
const { PORT } = require("./config/config");
const snifferService = require("./services/snifferService");
const { updateBooster } = require("./utils/updateBoosterInMongo");

const app = express();

(async () => {
  try {
    await connectDB();
    app.listen(PORT, () => {
      console.log(`Server attivo su http://localhost:${PORT}`);
    });

    console.log("⚡ Avvio immediato Sniffer di test");
    await snifferService.sniffCardtraderProducts();

    //PING CRON IN ESECUZIONE
    cron.schedule("*/30 * * * * *", () => {
      console.log(`[CRON] Ping delle: ${new Date().toISOString()}`);
    });
    //SNIFFER ERRORI DI PREZZO
    cron.schedule("0 */4 * * *", async () => {
      console.log("Inizio Sniffer Errori Di Prezzo");
      try {
        await snifferService.sniffCardtraderProducts();
        console.log("Fine Sniffer Errori Di Prezzo");
      } catch (err) {
        console.error("Errore nello Sniffer:", err);
      }
    });
    //AGGIORNAMENTO BOOSTER
    cron.schedule("0 */24 * * *", async () => {
      console.log("Inizio Update Booster Giapponesi");
      try {
        await updateBooster();
        console.log("Fine Update Booster Giapponesi");
      } catch (err) {
        console.error("Errore nell'update dei Booster Giapponesi:", err);
      }
    });
  } catch (err) {
    console.error("Errore inizializzazione:", err);
  }
})();
