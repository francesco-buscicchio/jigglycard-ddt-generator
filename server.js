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

    //PING CRON IN ESECUZIONE
    cron.schedule("*/5 * * * *", () => {
      console.log(`[CRON] Ping delle: ${new Date().toISOString()}`);
    });
    //SNIFFER ERRORI DI PREZZO
    cron.schedule("0 */6 * * *", async () => {
      console.log("Inizio Sniffer Errori Di Prezzo");
      try {
        await snifferService.sniffCardtraderProducts();
        console.log("Fine Sniffer Errori Di Prezzo");
      } catch (err) {
        console.error("Errore nello Sniffer:", err);
      }
    });
    //CONTROLLO ARTICOLI SOTTOPREZZATI
    cron.schedule("0 */12 * * *", async () => {
      console.log("Inizio Controllo Prodotti Sottoprezzati");
      try {
        await snifferService.checkMyProductsAgainstMarket();
        console.log("Fine Controllo Prodotti Sottoprezzati");
      } catch (err) {
        console.error("Errore Controllo Prodotti Sottoprezzati:", err);
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
    //AGGIORNAMENTO PRODOTTI
    cron.schedule("0 0 1 * *", async () => {
      console.log("Inizio Aggiornamento Prodotti");
      try {
        await snifferService.copyProductsCardtrader();
        console.log("Fine Aggiornamento Prodotti");
      } catch (err) {
        console.error("Errore Nell'Aggiornamento Prodotti:", err);
      }
    });
  } catch (err) {
    console.error("Errore inizializzazione:", err);
  }
})();
