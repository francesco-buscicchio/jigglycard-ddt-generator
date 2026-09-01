#!/usr/bin/env node
// CLI per il tracciamento prezzi carico/vendita su Cardmarket e CardTrader.
//
// Comandi:
//   node scripts/trackPrices.js import-cardmarket <file.csv>
//     Importa uno snapshot dell'inventario TCGPowertools. I cali di quantita
//     rispetto all'import precedente vengono registrati come vendite.
//
//   node scripts/trackPrices.js sync-cardtrader [--from=YYYY-MM-DD]
//     Scarica inventario e ordini da CardTrader. --from limita la finestra
//     ordini (default: ultimi 30 giorni; i duplicati sono ignorati).
//
//   node scripts/trackPrices.js report [--from=YYYY-MM-DD] [--to=YYYY-MM-DD]
//     Genera il report Excel (excel_export/report-prezzi-vendite-<data>.xlsx).

require("dotenv").config();

const fs = require("fs");
const {
  importCardmarketSnapshot,
  syncCardTrader,
  loadReportData,
} = require("../services/priceTrackingService");
const {
  generatePriceTrackingReport,
} = require("../utils/generatePriceTrackingReport");

function parseArgs(argv) {
  const args = { _: [] };
  for (const arg of argv) {
    if (arg.startsWith("--")) {
      const [key, value] = arg.slice(2).split("=");
      args[key] = value ?? true;
    } else {
      args._.push(arg);
    }
  }
  return args;
}

function validateDateArg(value, name) {
  if (typeof value === "undefined") return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    throw new Error(`Parametro ${name} non valido: usa il formato YYYY-MM-DD`);
  }
  return String(value);
}

function printUsage() {
  console.log(`Utilizzo:
  node scripts/trackPrices.js import-cardmarket <file.csv>
  node scripts/trackPrices.js sync-cardtrader [--from=YYYY-MM-DD]
  node scripts/trackPrices.js report [--from=YYYY-MM-DD] [--to=YYYY-MM-DD]`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];

  if (command === "import-cardmarket") {
    const csvPath = args._[1];
    if (!csvPath || !fs.existsSync(csvPath)) {
      throw new Error(
        `File CSV non trovato: ${csvPath ?? "(nessun percorso indicato)"}`,
      );
    }
    const result = await importCardmarketSnapshot(csvPath);
    console.log("[TRACK][cardmarket] Import completato:");
    console.log(JSON.stringify(result, null, 2));
    if (result.firstImport) {
      console.log(
        "Primo import: registrati i prezzi di carico, nessuna vendita dedotta. " +
          "Le vendite verranno rilevate dal prossimo import.",
      );
    }
    return;
  }

  if (command === "sync-cardtrader") {
    if (!process.env.CARDTRADER_TOKEN) {
      throw new Error("CARDTRADER_TOKEN non configurato nel file .env");
    }
    const result = await syncCardTrader({
      ordersFrom: validateDateArg(args.from, "--from"),
    });
    console.log("[TRACK][cardtrader] Sync completata:");
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "report") {
    const from = validateDateArg(args.from, "--from");
    const to = validateDateArg(args.to, "--to");
    const data = await loadReportData({ from, to });
    if (data.sales.length === 0) {
      console.log(
        "Nessuna vendita registrata nel periodo indicato: il report conterra' solo i dati di magazzino.",
      );
    }
    const result = await generatePriceTrackingReport(data, { from, to });
    console.log("[TRACK][report] Report generato:");
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  printUsage();
  if (command) {
    throw new Error(`Comando sconosciuto: ${command}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error?.response?.data ?? error?.message ?? error);
    process.exit(1);
  });
