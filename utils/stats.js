require("dotenv").config();

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const ExcelJS = require("exceljs");

const CARDTRADER_API_BASE_URL =
  process.env.CARDTRADER_API_BASE_URL ?? "https://api.cardtrader.com/api/v2";
const OUTPUT_DIR = path.join(__dirname, "..", "excel_export");
const GAME_CONFIGS = {
  pokemon: { id: 5, label: "Pokemon" },
  dragonball: { id: 9, label: "Dragon Ball" },
  onepiece: { id: 15, label: "One Piece" },
};
const TARGET_RARITIES = [
  { key: "common", label: "Common" },
  { key: "uncommon", label: "Uncommon" },
  { key: "rare", label: "Rare" },
  { key: "holo rare", label: "Holo Rare" },
];
const TARGET_RARITY_KEYS = new Set(
  TARGET_RARITIES.map(({ key }) => key),
);
const HEADER_FILL = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FF1F4E78" },
};
const SUBHEADER_FILL = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FFDCE6F1" },
};
const BORDER_STYLE = {
  top: { style: "thin", color: { argb: "FFB7C0CC" } },
  left: { style: "thin", color: { argb: "FFB7C0CC" } },
  bottom: { style: "thin", color: { argb: "FFB7C0CC" } },
  right: { style: "thin", color: { argb: "FFB7C0CC" } },
};

function parseArgs(argv) {
  return argv.reduce((acc, arg) => {
    if (!arg.startsWith("--")) return acc;
    const [key, value] = arg.slice(2).split("=");
    acc[key] = value ?? true;
    return acc;
  }, {});
}

function formatDate(date) {
  return new Date(date).toISOString().slice(0, 10);
}

function addDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return formatDate(date);
}

function toCurrency(value) {
  return Math.round(value) / 100;
}

function parseEuroToCents(value, fallback = null) {
  if (typeof value === "undefined" || value === null || value === true) {
    return fallback;
  }

  const normalized = String(value).replace(",", ".").trim();
  const amount = Number(normalized);
  if (!Number.isFinite(amount)) {
    throw new Error(`Valore euro non valido: ${value}`);
  }

  return Math.round(amount * 100);
}

function parseBooleanArg(value, fallback) {
  if (typeof value === "undefined" || value === null || value === true) {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "y", "si", "s"].includes(normalized)) return true;
  if (["false", "0", "no", "n"].includes(normalized)) return false;
  throw new Error(`Valore booleano non valido: ${value}`);
}

function normalizeLanguageFilter(value) {
  if (typeof value === "undefined" || value === null || value === true) {
    return "it";
  }

  const normalized = String(value).trim().toLowerCase();
  if (!normalized || normalized === "all" || normalized === "*") {
    return null;
  }

  return normalized;
}

function resolveGameConfig(value) {
  if (typeof value === "undefined" || value === null || value === true) {
    return null;
  }

  const normalized = String(value).trim().toLowerCase();
  const config = GAME_CONFIGS[normalized];
  if (!config) {
    throw new Error(`Gioco non supportato: ${value}`);
  }

  return config;
}

function parseRarityFilter(value) {
  if (typeof value === "undefined" || value === null || value === true) {
    return null;
  }

  const normalized = String(value).trim().toLowerCase();
  if (!normalized || normalized === "all" || normalized === "*") {
    return null;
  }

  const rarityFilter = [...new Set(normalized.split(",").map((entry) => entry.trim()).filter(Boolean))];
  if (!rarityFilter.length) {
    return null;
  }

  const invalidRarities = rarityFilter.filter((rarity) => !TARGET_RARITY_KEYS.has(rarity));
  if (invalidRarities.length) {
    throw new Error(
      `Rarita non supportate: ${invalidRarities.join(", ")}. Valori ammessi: ${TARGET_RARITIES.map(({ key }) => key).join(", ")}`,
    );
  }

  return rarityFilter;
}

function formatRarityFilterLabel(rarityFilter) {
  if (!rarityFilter) return "tutte";

  return rarityFilter
    .map((rarity) => {
      return (
        TARGET_RARITIES.find((target) => target.key === rarity)?.label ?? rarity
      );
    })
    .join(", ");
}

function buildHeaders() {
  return {
    Authorization: `Bearer ${process.env.CARDTRADER_TOKEN}`,
  };
}

function getRarity(item) {
  const properties = item?.properties ?? {};
  return (
    properties.pokemon_rarity ??
    properties.onepiece_rarity ??
    properties.dragonball_rarity ??
    null
  );
}

function getLanguage(item) {
  const properties = item?.properties ?? {};
  return (
    properties.pokemon_language ??
    properties.onepiece_language ??
    properties.dragonball_language ??
    null
  );
}

async function fetchOrders(from, to) {
  const orders = [];
  let page = 1;
  const limit = 100;

  while (true) {
    const { data } = await axios.get(`${CARDTRADER_API_BASE_URL}/orders`, {
      headers: buildHeaders(),
      params: {
        sort: "date.desc",
        from,
        to,
        page,
        limit,
      },
    });

    if (!Array.isArray(data) || data.length === 0) break;

    orders.push(...data);
    page += 1;
  }

  return orders;
}

function createStateBucket() {
  return {
    orderCount: 0,
    totalQty: 0,
    totalCents: 0,
  };
}

function createRarityBucket() {
  return Object.fromEntries(
    TARGET_RARITIES.map(({ key }) => [key, { qty: 0, cents: 0 }]),
  );
}

function createAggregateBucket(includeRarityBreakdown) {
  return {
    ...createStateBucket(),
    rarities: Object.fromEntries(
      includeRarityBreakdown ? Object.entries(createRarityBucket()) : [],
    ),
  };
}

function aggregateOrders(
  orders,
  {
    languageFilter,
    maxUnitCents,
    gameConfig,
    includeRarityBreakdown,
    rarityFilter,
  },
) {
  const states = new Map();
  const detailRows = [];
  const totals = createAggregateBucket(includeRarityBreakdown);

  for (const order of orders) {
    if (order?.order_as !== "seller") continue;

    const matchedItems = [];
    for (const item of order.order_items ?? []) {
      const rarity = String(getRarity(item) ?? "")
        .trim()
        .toLowerCase();
      const language = String(getLanguage(item) ?? "")
        .trim()
        .toLowerCase();

      if (gameConfig && item?.game_id !== gameConfig.id) continue;
      if (languageFilter && language !== languageFilter) continue;
      if (
        includeRarityBreakdown &&
        !TARGET_RARITIES.some((target) => target.key === rarity)
      ) {
        continue;
      }
      if (rarityFilter && !rarityFilter.includes(rarity)) continue;

      const quantity = Number(item?.quantity ?? 0);
      const unitCents = Number(item?.seller_price?.cents ?? 0);
      if (maxUnitCents !== null && unitCents > maxUnitCents) continue;
      const lineCents = quantity * unitCents;

      matchedItems.push({
        orderId: order.id,
        orderCode: order.code,
        state: order.state ?? "unknown",
        buyer: order?.real_buyer_order_billing_address?.name ?? "",
        itemName: item?.name ?? "",
        expansion: item?.expansion ?? "",
        quantity,
        unitCents,
        lineCents,
        gameId: item?.game_id ?? null,
        rarity,
        language,
        condition: item?.properties?.condition ?? "",
        collectorNumber: item?.properties?.collector_number ?? "",
        itemCreatedAt: item?.created_at ?? "",
      });
    }

    if (!matchedItems.length) continue;

    const state = order?.state ?? "unknown";
    if (!states.has(state)) {
      states.set(state, createAggregateBucket(includeRarityBreakdown));
    }

    const stateBucket = states.get(state);
    stateBucket.orderCount += 1;
    totals.orderCount += 1;

    for (const matchedItem of matchedItems) {
      if (includeRarityBreakdown) {
        const rarityBucket = stateBucket.rarities[matchedItem.rarity];
        const totalRarityBucket = totals.rarities[matchedItem.rarity];

        rarityBucket.qty += matchedItem.quantity;
        rarityBucket.cents += matchedItem.lineCents;
        totalRarityBucket.qty += matchedItem.quantity;
        totalRarityBucket.cents += matchedItem.lineCents;
      }

      stateBucket.totalQty += matchedItem.quantity;
      stateBucket.totalCents += matchedItem.lineCents;
      totals.totalQty += matchedItem.quantity;
      totals.totalCents += matchedItem.lineCents;

      detailRows.push(matchedItem);
    }
  }

  return {
    states: [...states.entries()]
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([state, bucket]) => ({ state, ...bucket })),
    totals,
    detailRows,
  };
}

function styleHeaderRow(row) {
  row.height = 22;
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = HEADER_FILL;
    cell.border = BORDER_STYLE;
    cell.alignment = { horizontal: "center", vertical: "middle" };
  });
}

function styleDataRow(row) {
  row.eachCell({ includeEmpty: true }, (cell) => {
    cell.border = BORDER_STYLE;
    cell.alignment = { vertical: "middle", horizontal: "left" };
  });
}

function styleInfoLabel(cell) {
  cell.font = { bold: true };
  cell.fill = SUBHEADER_FILL;
  cell.border = BORDER_STYLE;
}

function writeSummarySheet(workbook, report, metadata) {
  const worksheet = workbook.addWorksheet("Riepilogo");
  const summaryColumns = [
    { header: "Stato", key: "state", width: 18 },
    { header: "Ordini", key: "orderCount", width: 10 },
    { header: "Carte", key: "totalQty", width: 10 },
    { header: "Valore Totale", key: "totalValue", width: 14 },
  ];
  if (metadata.includeRarityBreakdown) {
    summaryColumns.push(
      ...TARGET_RARITIES.flatMap(({ label }) => [
        { header: `${label} Qty`, key: `${label}_qty`, width: 14 },
        { header: `${label} Valore`, key: `${label}_value`, width: 16 },
      ]),
    );
  }
  worksheet.columns = summaryColumns;

  worksheet.getCell("A1").value = "Report vendite CardTrader";
  worksheet.getCell("A1").font = { bold: true, size: 14 };

  const infoRows = [
    ["Periodo dal", metadata.from],
    ["Periodo al", metadata.to],
    ["Gioco", metadata.gameLabel ?? "tutti"],
    ["Lingua", metadata.languageLabel],
    ["Filtro rarita", metadata.rarityFilterLabel],
    [
      "Prezzo unitario max",
      metadata.maxUnitCents === null ? "nessun filtro" : toCurrency(metadata.maxUnitCents),
    ],
    ["Ordini con match", report.totals.orderCount],
    ["Carte con match", report.totals.totalQty],
    ["Valore totale", toCurrency(report.totals.totalCents)],
  ];
  if (metadata.includeRarityBreakdown) {
    infoRows.splice(4, 0, [
      "Rarita incluse",
      TARGET_RARITIES.map(({ label }) => label).join(", "),
    ]);
  }

  infoRows.forEach((values, index) => {
    const rowNumber = index + 3;
    worksheet.getCell(`A${rowNumber}`).value = values[0];
    worksheet.getCell(`B${rowNumber}`).value = values[1];
    styleInfoLabel(worksheet.getCell(`A${rowNumber}`));
    worksheet.getCell(`B${rowNumber}`).border = BORDER_STYLE;
    if (
      values[0] === "Valore totale" ||
      values[0] === "Prezzo unitario max"
    ) {
      worksheet.getCell(`B${rowNumber}`).numFmt = '€ #,##0.00';
    }
  });

  const headerRowNumber = infoRows.length + 4;
  const headerRow = worksheet.getRow(headerRowNumber);
  headerRow.values = worksheet.columns.map((column) => column.header);
  styleHeaderRow(headerRow);

  report.states.forEach((stateRow) => {
    const rowValues = {
      state: stateRow.state,
      orderCount: stateRow.orderCount,
      totalQty: stateRow.totalQty,
      totalValue: toCurrency(stateRow.totalCents),
    };

    if (metadata.includeRarityBreakdown) {
      TARGET_RARITIES.forEach(({ key, label }) => {
        rowValues[`${label}_qty`] = stateRow.rarities[key].qty;
        rowValues[`${label}_value`] = toCurrency(stateRow.rarities[key].cents);
      });
    }

    const row = worksheet.addRow(rowValues);
    styleDataRow(row);
  });

  const totalRowValues = {
    state: "Totale",
    orderCount: report.totals.orderCount,
    totalQty: report.totals.totalQty,
    totalValue: toCurrency(report.totals.totalCents),
  };
  if (metadata.includeRarityBreakdown) {
    Object.assign(
      totalRowValues,
      Object.fromEntries(
        TARGET_RARITIES.flatMap(({ key, label }) => [
          [`${label}_qty`, report.totals.rarities[key].qty],
          [`${label}_value`, toCurrency(report.totals.rarities[key].cents)],
        ]),
      ),
    );
  }
  const totalRow = worksheet.addRow(totalRowValues);
  totalRow.font = { bold: true };
  totalRow.eachCell((cell) => {
    cell.border = BORDER_STYLE;
    cell.fill = SUBHEADER_FILL;
  });

  worksheet.getColumn("totalValue").numFmt = '€ #,##0.00';
  if (metadata.includeRarityBreakdown) {
    TARGET_RARITIES.forEach(({ label }) => {
      worksheet.getColumn(`${label}_value`).numFmt = '€ #,##0.00';
    });
  }

  worksheet.views = [{ state: "frozen", ySplit: headerRowNumber }];
}

function writeDetailSheet(workbook, detailRows, metadata) {
  const worksheet = workbook.addWorksheet("Dettaglio");
  const detailColumns = [
    { header: "Stato", key: "state", width: 16 },
    { header: "Codice Ordine", key: "orderCode", width: 20 },
    { header: "Order ID", key: "orderId", width: 12 },
    { header: "Acquirente", key: "buyer", width: 28 },
    { header: "Carta", key: "itemName", width: 28 },
    { header: "Set", key: "expansion", width: 24 },
    { header: "Lingua", key: "languageLabel", width: 10 },
    { header: "Condizione", key: "condition", width: 14 },
    { header: "Collector #", key: "collectorNumber", width: 12 },
    { header: "Quantita", key: "quantity", width: 10 },
    { header: "Prezzo Unit.", key: "unitPrice", width: 12 },
    { header: "Totale Riga", key: "lineTotal", width: 12 },
    { header: "Creato il", key: "itemCreatedAt", width: 22 },
  ];
  if (metadata.includeRarityBreakdown) {
    detailColumns.splice(6, 0, {
      header: "Rarita",
      key: "rarityLabel",
      width: 14,
    });
  }
  worksheet.columns = detailColumns;

  const headerRow = worksheet.getRow(1);
  headerRow.values = worksheet.columns.map((column) => column.header);
  styleHeaderRow(headerRow);

  detailRows.forEach((detailRow) => {
    const row = worksheet.addRow({
      ...detailRow,
      rarityLabel:
        TARGET_RARITIES.find((entry) => entry.key === detailRow.rarity)?.label ??
        detailRow.rarity,
      languageLabel: String(detailRow.language ?? "").toUpperCase(),
      unitPrice: toCurrency(detailRow.unitCents),
      lineTotal: toCurrency(detailRow.lineCents),
    });
    styleDataRow(row);
  });

  worksheet.getColumn("unitPrice").numFmt = '€ #,##0.00';
  worksheet.getColumn("lineTotal").numFmt = '€ #,##0.00';
  worksheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: worksheet.columns.length },
  };
  worksheet.views = [{ state: "frozen", ySplit: 1 }];
}

async function main() {
  if (!process.env.CARDTRADER_TOKEN) {
    throw new Error("CARDTRADER_TOKEN non configurato nel file .env");
  }

  const args = parseArgs(process.argv.slice(2));
  const from = String(args.from ?? "2026-01-01");
  const to = String(args.to ?? formatDate(new Date()));
  const language = normalizeLanguageFilter(args.language);
  const apiTo = addDays(to, 1);
  const maxUnitCents = parseEuroToCents(args["max-unit-eur"], null);
  const gameConfig = resolveGameConfig(args.game);
  const includeRarityBreakdown = parseBooleanArg(args["include-rarity"], true);
  const rarityFilter = parseRarityFilter(args.rarity);

  const orders = await fetchOrders(from, apiTo);
  const report = aggregateOrders(orders, {
    languageFilter: language,
    maxUnitCents,
    gameConfig,
    includeRarityBreakdown,
    rarityFilter,
  });

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const gameSuffix = gameConfig ? `-${String(args.game).trim().toLowerCase()}` : "";
  const languageSuffix = language ?? "all";
  const fileSuffix =
    maxUnitCents === null
      ? ""
      : `-max-unit-${toCurrency(maxUnitCents).toFixed(2)}`;
  const raritySuffix = rarityFilter
    ? `-rarity-${rarityFilter.join("-")}`
    : includeRarityBreakdown
      ? ""
      : "-no-rarity";
  const outputPath = path.join(
    OUTPUT_DIR,
    `cardtrader-sales${gameSuffix}-${languageSuffix}-${from}_to_${to}${fileSuffix}${raritySuffix}.xlsx`,
  );

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Codex";
  workbook.created = new Date();

  writeSummarySheet(workbook, report, {
    from,
    to,
    languageLabel: language ? language.toUpperCase() : "tutte",
    gameLabel: gameConfig?.label ?? null,
    maxUnitCents,
    includeRarityBreakdown,
    rarityFilterLabel: formatRarityFilterLabel(rarityFilter),
  });
  writeDetailSheet(workbook, report.detailRows, {
    includeRarityBreakdown,
  });

  await workbook.xlsx.writeFile(outputPath);

  const response = {
    outputPath,
    ordersFetched: orders.length,
    matchedOrders: report.totals.orderCount,
    matchedQty: report.totals.totalQty,
    matchedValueEur: toCurrency(report.totals.totalCents).toFixed(2),
  };

  console.log(JSON.stringify(response, null, 2));
}

main().catch((error) => {
  console.error(error?.response?.data ?? error);
  process.exit(1);
});
