const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");
const {
  platformColor,
  renderGroupedBarChart,
  renderLineChart,
  renderDonutChart,
} = require("./trackingCharts");

const OUTPUT_DIR = path.join(__dirname, "..", "excel_export");

const PLATFORM_LABELS = {
  cardtrader: "CardTrader",
  cardmarket: "Cardmarket",
};

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
const ROW_FILLS = [
  { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFFFF" } },
  { type: "pattern", pattern: "solid", fgColor: { argb: "FFF5F9FF" } },
];
const POSITIVE_FONT = { color: { argb: "FF1E7E34" } };
const NEGATIVE_FONT = { color: { argb: "FFC0392B" } };

function toEuro(cents) {
  if (!Number.isFinite(cents)) return null;
  return Math.round(cents) / 100;
}

function formatEuroShort(value) {
  if (Math.abs(value) >= 1000) return `€${(value / 1000).toFixed(1)}k`;
  return `€${Math.round(value)}`;
}

function platformLabel(platform) {
  return PLATFORM_LABELS[platform] ?? platform;
}

function monthKey(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function enrichSales(sales) {
  return sales.map((sale) => {
    const revenueCents = sale.unitSalePriceCents * sale.quantity;
    const hasInitial = Number.isFinite(sale.unitInitialPriceCents);
    const deltaCents = hasInitial
      ? sale.unitSalePriceCents - sale.unitInitialPriceCents
      : null;
    const deltaPct =
      hasInitial && sale.unitInitialPriceCents > 0
        ? (deltaCents / sale.unitInitialPriceCents) * 100
        : null;
    const daysToSale =
      sale.initialAt && sale.soldAt
        ? Math.max(
            0,
            (new Date(sale.soldAt) - new Date(sale.initialAt)) /
              (24 * 60 * 60 * 1000),
          )
        : null;

    return { ...sale, revenueCents, deltaCents, deltaPct, daysToSale };
  });
}

function average(values) {
  const valid = values.filter((value) => Number.isFinite(value));
  if (!valid.length) return null;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function buildPlatformStats(sales, items) {
  const platforms = [...new Set(sales.map((sale) => sale.platform))].sort();
  const stats = new Map();

  for (const platform of platforms.length ? platforms : ["cardtrader", "cardmarket"]) {
    const platformSales = sales.filter((sale) => sale.platform === platform);
    const activeItems = items.filter(
      (item) => item.platform === platform && item.active,
    );

    stats.set(platform, {
      platform,
      salesCount: platformSales.length,
      units: platformSales.reduce((sum, sale) => sum + sale.quantity, 0),
      revenueCents: platformSales.reduce(
        (sum, sale) => sum + sale.revenueCents,
        0,
      ),
      avgSaleCents: average(
        platformSales.map((sale) => sale.unitSalePriceCents),
      ),
      avgDeltaPct: average(platformSales.map((sale) => sale.deltaPct)),
      avgDaysToSale: average(platformSales.map((sale) => sale.daysToSale)),
      withInitialCount: platformSales.filter((sale) =>
        Number.isFinite(sale.unitInitialPriceCents),
      ).length,
      activeItems: activeItems.length,
      activeUnits: activeItems.reduce(
        (sum, item) => sum + Number(item.lastQuantity ?? 0),
        0,
      ),
      activeValueCents: activeItems.reduce(
        (sum, item) =>
          sum + Number(item.lastPriceCents ?? 0) * Number(item.lastQuantity ?? 0),
        0,
      ),
    });
  }

  return stats;
}

function buildMonthlySeries(sales) {
  const months = [...new Set(sales.map((sale) => monthKey(sale.soldAt)))].sort();
  const platforms = [...new Set(sales.map((sale) => sale.platform))].sort();

  const revenueByPlatform = new Map(
    platforms.map((platform) => [platform, months.map(() => 0)]),
  );
  const unitsByPlatform = new Map(
    platforms.map((platform) => [platform, months.map(() => 0)]),
  );

  for (const sale of sales) {
    const monthIndex = months.indexOf(monthKey(sale.soldAt));
    if (monthIndex === -1) continue;
    revenueByPlatform.get(sale.platform)[monthIndex] +=
      sale.revenueCents / 100;
    unitsByPlatform.get(sale.platform)[monthIndex] += sale.quantity;
  }

  return { months, platforms, revenueByPlatform, unitsByPlatform };
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

function styleDataRow(row, rowIndex) {
  row.eachCell({ includeEmpty: true }, (cell) => {
    cell.border = BORDER_STYLE;
    cell.fill = ROW_FILLS[rowIndex % 2];
    cell.alignment = { vertical: "middle" };
  });
}

function applyDeltaFont(cell, value) {
  if (!Number.isFinite(value)) return;
  cell.font = value >= 0 ? { ...POSITIVE_FONT } : { ...NEGATIVE_FONT };
}

function writeDashboardSheet(workbook, data, metadata) {
  const worksheet = workbook.addWorksheet("Dashboard", {
    views: [{ showGridLines: false }],
  });
  const { stats, monthly, sales } = data;

  worksheet.getCell("B2").value = "Report Prezzi & Vendite — Jigglycard";
  worksheet.getCell("B2").font = { bold: true, size: 18, color: { argb: "FF1F4E78" } };
  worksheet.getCell("B3").value = `Periodo: ${metadata.periodLabel} · generato il ${metadata.generatedAt}`;
  worksheet.getCell("B3").font = { size: 11, color: { argb: "FF5B6B7C" } };

  // --- Tabella KPI ---
  const kpiRows = [
    ["Vendite (righe)", (s) => s.salesCount, "#,##0"],
    ["Pezzi venduti", (s) => s.units, "#,##0"],
    ["Ricavo totale", (s) => toEuro(s.revenueCents), '€ #,##0.00'],
    ["Prezzo medio di vendita", (s) => toEuro(s.avgSaleCents), '€ #,##0.00'],
    [
      "Delta medio carico → vendita",
      (s) => (Number.isFinite(s.avgDeltaPct) ? s.avgDeltaPct / 100 : null),
      "+0.0%;-0.0%",
    ],
    [
      "Tempo medio di vendita (giorni)",
      (s) => (Number.isFinite(s.avgDaysToSale) ? s.avgDaysToSale : null),
      "#,##0.0",
    ],
    ["Vendite con prezzo di carico noto", (s) => s.withInitialCount, "#,##0"],
    ["Articoli attivi a listino", (s) => s.activeItems, "#,##0"],
    ["Pezzi a listino", (s) => s.activeUnits, "#,##0"],
    ["Valore a listino", (s) => toEuro(s.activeValueCents), '€ #,##0.00'],
  ];

  const platforms = [...stats.keys()];
  const kpiHeaderRowNumber = 5;
  const headerRow = worksheet.getRow(kpiHeaderRowNumber);
  headerRow.getCell(2).value = "Indicatore";
  platforms.forEach((platform, index) => {
    headerRow.getCell(3 + index).value = platformLabel(platform);
  });
  for (let col = 2; col <= 2 + platforms.length; col += 1) {
    const cell = headerRow.getCell(col);
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = HEADER_FILL;
    cell.border = BORDER_STYLE;
    cell.alignment = { horizontal: "center", vertical: "middle" };
  }
  headerRow.height = 22;

  kpiRows.forEach(([label, getter, numFmt], index) => {
    const row = worksheet.getRow(kpiHeaderRowNumber + 1 + index);
    const labelCell = row.getCell(2);
    labelCell.value = label;
    labelCell.font = { bold: true };
    labelCell.fill = SUBHEADER_FILL;
    labelCell.border = BORDER_STYLE;

    platforms.forEach((platform, platformIndex) => {
      const cell = row.getCell(3 + platformIndex);
      const value = getter(stats.get(platform));
      cell.value = value ?? "n/d";
      cell.numFmt = numFmt;
      cell.border = BORDER_STYLE;
      cell.alignment = { horizontal: "right" };
      if (label.startsWith("Delta")) applyDeltaFont(cell, value);
    });
  });

  worksheet.getColumn(2).width = 34;
  platforms.forEach((_, index) => {
    worksheet.getColumn(3 + index).width = 18;
  });

  // --- Grafici ---
  const chartsStartRow = kpiHeaderRowNumber + kpiRows.length + 3;

  const revenueChart = renderGroupedBarChart({
    title: "Ricavo mensile per piattaforma",
    categories: monthly.months,
    series: monthly.platforms.map((platform) => ({
      label: platformLabel(platform),
      color: platformColor(platform),
      values: monthly.revenueByPlatform.get(platform),
    })),
    valueFormatter: formatEuroShort,
  });

  const unitsChart = renderLineChart({
    title: "Pezzi venduti al mese",
    categories: monthly.months,
    series: monthly.platforms.map((platform) => ({
      label: platformLabel(platform),
      color: platformColor(platform),
      values: monthly.unitsByPlatform.get(platform),
    })),
  });

  const revenueDonut = renderDonutChart({
    title: "Quota ricavo per piattaforma",
    slices: monthly.platforms.map((platform) => ({
      label: platformLabel(platform),
      color: platformColor(platform),
      value: toEuro(stats.get(platform)?.revenueCents ?? 0) ?? 0,
    })),
    valueFormatter: formatEuroShort,
  });

  const deltaChart = renderGroupedBarChart({
    title: "Prezzo medio: carico vs vendita",
    categories: monthly.platforms.map(platformLabel),
    series: [
      {
        label: "Prezzo medio di carico",
        color: "#A9B7C6",
        values: monthly.platforms.map((platform) => {
          const platformSales = sales.filter(
            (sale) =>
              sale.platform === platform &&
              Number.isFinite(sale.unitInitialPriceCents),
          );
          return toEuro(
            average(platformSales.map((sale) => sale.unitInitialPriceCents)),
          ) ?? 0;
        }),
      },
      {
        label: "Prezzo medio di vendita",
        color: "#2E75B6",
        values: monthly.platforms.map((platform) => {
          const platformSales = sales.filter(
            (sale) =>
              sale.platform === platform &&
              Number.isFinite(sale.unitInitialPriceCents),
          );
          return toEuro(
            average(platformSales.map((sale) => sale.unitSalePriceCents)),
          ) ?? 0;
        }),
      },
    ],
    width: 460,
    height: 420,
    valueFormatter: (value) => `€${value.toFixed(2)}`,
  });

  const images = [
    { buffer: revenueChart, col: 1, row: chartsStartRow, width: 900, height: 420 },
    {
      buffer: unitsChart,
      col: 1,
      row: chartsStartRow + 23,
      width: 900,
      height: 420,
    },
    {
      buffer: revenueDonut,
      col: 1,
      row: chartsStartRow + 46,
      width: 460,
      height: 420,
    },
    {
      buffer: deltaChart,
      col: 8.2,
      row: chartsStartRow + 46,
      width: 460,
      height: 420,
    },
  ];

  for (const image of images) {
    const imageId = workbook.addImage({
      buffer: image.buffer,
      extension: "png",
    });
    worksheet.addImage(imageId, {
      tl: { col: image.col, row: image.row },
      ext: { width: image.width, height: image.height },
    });
  }
}

function writeSalesSheet(workbook, sales) {
  const worksheet = workbook.addWorksheet("Vendite");
  worksheet.columns = [
    { header: "Data", key: "soldAt", width: 12 },
    { header: "Piattaforma", key: "platform", width: 13 },
    { header: "Carta", key: "name", width: 34 },
    { header: "Set", key: "set", width: 26 },
    { header: "CN", key: "cn", width: 8 },
    { header: "Rarita", key: "rarity", width: 16 },
    { header: "Cond.", key: "condition", width: 8 },
    { header: "Lingua", key: "language", width: 10 },
    { header: "Qta", key: "quantity", width: 6 },
    { header: "Prezzo Carico", key: "initialPrice", width: 14 },
    { header: "Prezzo Vendita", key: "salePrice", width: 14 },
    { header: "Delta", key: "delta", width: 11 },
    { header: "Delta %", key: "deltaPct", width: 10 },
    { header: "Ricavo", key: "revenue", width: 12 },
    { header: "Giorni a Vendita", key: "daysToSale", width: 14 },
    { header: "Fonte", key: "source", width: 17 },
    { header: "Ordine", key: "orderCode", width: 18 },
  ];
  styleHeaderRow(worksheet.getRow(1));

  const sorted = [...sales].sort(
    (left, right) => new Date(right.soldAt) - new Date(left.soldAt),
  );

  sorted.forEach((sale, index) => {
    const row = worksheet.addRow({
      soldAt: new Date(sale.soldAt),
      platform: platformLabel(sale.platform),
      name: sale.name,
      set: sale.set,
      cn: sale.cn ?? "",
      rarity: sale.rarity ?? "",
      condition: sale.condition ?? "",
      language: sale.language ?? "",
      quantity: sale.quantity,
      initialPrice: toEuro(sale.unitInitialPriceCents),
      salePrice: toEuro(sale.unitSalePriceCents),
      delta: toEuro(sale.deltaCents),
      deltaPct: Number.isFinite(sale.deltaPct) ? sale.deltaPct / 100 : null,
      revenue: toEuro(sale.revenueCents),
      daysToSale: Number.isFinite(sale.daysToSale)
        ? Math.round(sale.daysToSale * 10) / 10
        : null,
      source:
        sale.source === "cardtrader-orders" ? "Ordini CT" : "Diff snapshot",
      orderCode: sale.orderCode ?? "",
    });
    styleDataRow(row, index);
    applyDeltaFont(row.getCell("delta"), sale.deltaCents);
    applyDeltaFont(row.getCell("deltaPct"), sale.deltaPct);
  });

  worksheet.getColumn("soldAt").numFmt = "dd/mm/yyyy";
  worksheet.getColumn("initialPrice").numFmt = '€ #,##0.00';
  worksheet.getColumn("salePrice").numFmt = '€ #,##0.00';
  worksheet.getColumn("delta").numFmt = '€ #,##0.00';
  worksheet.getColumn("deltaPct").numFmt = "+0.0%;-0.0%";
  worksheet.getColumn("revenue").numFmt = '€ #,##0.00';

  worksheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: worksheet.columns.length },
  };
  worksheet.views = [{ state: "frozen", ySplit: 1 }];
}

function writeSetComparisonSheet(workbook, sales) {
  const worksheet = workbook.addWorksheet("Confronto Set");

  const bySet = new Map();
  for (const sale of sales) {
    const key = sale.set || "(senza set)";
    if (!bySet.has(key)) bySet.set(key, new Map());
    const platformMap = bySet.get(key);
    if (!platformMap.has(sale.platform)) {
      platformMap.set(sale.platform, {
        units: 0,
        revenueCents: 0,
        deltas: [],
      });
    }
    const bucket = platformMap.get(sale.platform);
    bucket.units += sale.quantity;
    bucket.revenueCents += sale.revenueCents;
    if (Number.isFinite(sale.deltaPct)) bucket.deltas.push(sale.deltaPct);
  }

  const platforms = [...new Set(sales.map((sale) => sale.platform))].sort();
  const columns = [{ header: "Set", key: "set", width: 32 }];
  for (const platform of platforms) {
    const label = platformLabel(platform);
    columns.push(
      { header: `${label} Pezzi`, key: `${platform}_units`, width: 13 },
      { header: `${label} Ricavo`, key: `${platform}_revenue`, width: 15 },
      { header: `${label} Delta %`, key: `${platform}_delta`, width: 13 },
    );
  }
  worksheet.columns = columns;
  styleHeaderRow(worksheet.getRow(1));

  const sortedSets = [...bySet.entries()].sort((left, right) => {
    const leftRevenue = [...left[1].values()].reduce(
      (sum, bucket) => sum + bucket.revenueCents,
      0,
    );
    const rightRevenue = [...right[1].values()].reduce(
      (sum, bucket) => sum + bucket.revenueCents,
      0,
    );
    return rightRevenue - leftRevenue;
  });

  sortedSets.forEach(([setName, platformMap], index) => {
    const rowValues = { set: setName };
    for (const platform of platforms) {
      const bucket = platformMap.get(platform);
      rowValues[`${platform}_units`] = bucket?.units ?? 0;
      rowValues[`${platform}_revenue`] = toEuro(bucket?.revenueCents ?? 0);
      rowValues[`${platform}_delta`] = bucket?.deltas.length
        ? average(bucket.deltas) / 100
        : null;
    }
    const row = worksheet.addRow(rowValues);
    styleDataRow(row, index);
    for (const platform of platforms) {
      const cell = row.getCell(`${platform}_delta`);
      applyDeltaFont(cell, rowValues[`${platform}_delta`]);
    }
  });

  for (const platform of platforms) {
    worksheet.getColumn(`${platform}_revenue`).numFmt = '€ #,##0.00';
    worksheet.getColumn(`${platform}_delta`).numFmt = "+0.0%;-0.0%";
  }

  worksheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: worksheet.columns.length },
  };
  worksheet.views = [{ state: "frozen", ySplit: 1 }];
}

function writeTopCardsSheet(workbook, sales, limit = 30) {
  const worksheet = workbook.addWorksheet("Top Carte");

  const byCard = new Map();
  for (const sale of sales) {
    const key = `${sale.name}|${sale.set}|${sale.platform}`;
    if (!byCard.has(key)) {
      byCard.set(key, {
        name: sale.name,
        set: sale.set,
        platform: sale.platform,
        units: 0,
        revenueCents: 0,
        deltas: [],
      });
    }
    const bucket = byCard.get(key);
    bucket.units += sale.quantity;
    bucket.revenueCents += sale.revenueCents;
    if (Number.isFinite(sale.deltaPct)) bucket.deltas.push(sale.deltaPct);
  }

  worksheet.columns = [
    { header: "#", key: "rank", width: 5 },
    { header: "Carta", key: "name", width: 34 },
    { header: "Set", key: "set", width: 28 },
    { header: "Piattaforma", key: "platform", width: 13 },
    { header: "Pezzi", key: "units", width: 8 },
    { header: "Ricavo", key: "revenue", width: 13 },
    { header: "Delta % medio", key: "delta", width: 14 },
  ];
  styleHeaderRow(worksheet.getRow(1));

  [...byCard.values()]
    .sort((left, right) => right.revenueCents - left.revenueCents)
    .slice(0, limit)
    .forEach((card, index) => {
      const deltaValue = card.deltas.length
        ? average(card.deltas) / 100
        : null;
      const row = worksheet.addRow({
        rank: index + 1,
        name: card.name,
        set: card.set,
        platform: platformLabel(card.platform),
        units: card.units,
        revenue: toEuro(card.revenueCents),
        delta: deltaValue,
      });
      styleDataRow(row, index);
      applyDeltaFont(row.getCell("delta"), deltaValue);
    });

  worksheet.getColumn("revenue").numFmt = '€ #,##0.00';
  worksheet.getColumn("delta").numFmt = "+0.0%;-0.0%";
  worksheet.views = [{ state: "frozen", ySplit: 1 }];
}

async function generatePriceTrackingReport({ sales, items }, options = {}) {
  const enriched = enrichSales(sales);
  const stats = buildPlatformStats(enriched, items);
  const monthly = buildMonthlySeries(enriched);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Jigglycard Price Tracking";
  workbook.created = new Date();

  const periodLabel =
    options.from || options.to
      ? `${options.from ?? "inizio"} → ${options.to ?? "oggi"}`
      : "tutto lo storico";

  writeDashboardSheet(
    workbook,
    { stats, monthly, sales: enriched },
    {
      periodLabel,
      generatedAt: new Date().toLocaleString("it-IT"),
    },
  );
  writeSalesSheet(workbook, enriched);
  writeSetComparisonSheet(workbook, enriched);
  writeTopCardsSheet(workbook, enriched);

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const outputPath = path.join(
    OUTPUT_DIR,
    `report-prezzi-vendite-${stamp}.xlsx`,
  );
  await workbook.xlsx.writeFile(outputPath);

  return {
    outputPath,
    salesCount: enriched.length,
    platforms: [...stats.keys()],
  };
}

module.exports = { generatePriceTrackingReport };
