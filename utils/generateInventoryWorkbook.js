const fs = require("fs");
const path = require("path");
const csv = require("csv-parser");
const ExcelJS = require("exceljs");

const INVENTORY_COLUMNS = [
  { header: "SetCode", key: "setCode", width: 14 },
  { header: "CN", key: "cn", width: 12 },
  { header: "Rarity", key: "rarity", width: 18 },
  { header: "Nome", key: "nameIT", width: 42 },
  { header: "Condizione", key: "condition", width: 14 },
  { header: "Lingua", key: "language", width: 14 },
  { header: "1a Ed.", key: "isFirstEd", width: 12 },
  { header: "Reverse Holo", key: "isReverseHolo", width: 14 },
  { header: "Quantita a magazzino", key: "warehouseQuantity", width: 18 },
  { header: "Quantita rilevata", key: "countedQuantity", width: 18 },
];

const BORDER_STYLE = {
  top: { style: "thin", color: { argb: "FFB7C0CC" } },
  left: { style: "thin", color: { argb: "FFB7C0CC" } },
  bottom: { style: "thin", color: { argb: "FFB7C0CC" } },
  right: { style: "thin", color: { argb: "FFB7C0CC" } },
};

const HEADER_FILL = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FF1F4E78" },
};

const INFO_FILL = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FFDCE6F1" },
};

const ROW_FILLS = [
  {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFFFFFFF" },
  },
  {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFF5F9FF" },
  },
];
const EXCLUDED_RARITIES = new Set(["common", "uncommon", "rare", "holo rare"]);
const EXCLUDED_SET_CODE_PREFIXES = ["pcg", "adv"];
const SMALL_SET_MAX_ROWS = 5;
const SMALL_SET_EXTRA_ROWS = 5;
const DEFAULT_EXTRA_ROWS = 5;

function normalizeHeader(header) {
  return String(header ?? "")
    .replace(/^\uFEFF/, "")
    .trim();
}

function readCsvRows(csvPath) {
  return new Promise((resolve, reject) => {
    const rows = [];

    fs.createReadStream(csvPath)
      .pipe(
        csv({
          mapHeaders: ({ header }) => normalizeHeader(header),
        }),
      )
      .on("data", (row) => rows.push(row))
      .on("end", () => resolve(rows))
      .on("error", reject);
  });
}

function findLatestInventoryCsv() {
  const inventoryDir = path.join(__dirname, "..", "inventari");
  if (!fs.existsSync(inventoryDir)) return null;

  const candidateFiles = fs
    .readdirSync(inventoryDir)
    .filter((fileName) => fileName.toLowerCase().endsWith(".csv"))
    .map((fileName) => {
      const absolutePath = path.join(inventoryDir, fileName);
      const stats = fs.statSync(absolutePath);
      return {
        absolutePath,
        modifiedAt: stats.mtimeMs,
      };
    })
    .sort((left, right) => right.modifiedAt - left.modifiedAt);

  return candidateFiles[0]?.absolutePath ?? null;
}

function sanitizeSheetName(name, usedNames) {
  const baseName =
    String(name || "Sheet")
      .replace(/[\\/*?:[\]]/g, "-")
      .trim()
      .slice(0, 31) || "Sheet";

  let candidate = baseName;
  let counter = 1;
  while (usedNames.has(candidate)) {
    const suffix = `-${counter}`;
    candidate = `${baseName.slice(0, 31 - suffix.length)}${suffix}`;
    counter += 1;
  }

  usedNames.add(candidate);
  return candidate;
}

function normalizeFlag(value) {
  if (value === true) return "Si";
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (["true", "1", "yes", "y", "si", "s"].includes(normalized)) return "Si";
  if (["false", "0", "no", "n"].includes(normalized)) return "No";
  return "";
}

function compareCollectorNumbers(left, right) {
  return String(left ?? "").localeCompare(String(right ?? ""), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function buildInventoryRow(row) {
  return {
    setCode: row.setCode ?? "",
    cn: row.cn ?? "",
    rarity: row.rarity ?? "",
    nameIT: row.nameIT ?? row.name ?? "",
    condition: row.condition ?? "",
    language: row.language ?? "",
    isFirstEd: normalizeFlag(row.isFirstEd),
    warehouseQuantity: row.quantity ?? "",
    isReverseHolo: normalizeFlag(row.isReverseHolo),
    countedQuantity: "",
  };
}

function applyCellBorder(row) {
  row.eachCell({ includeEmpty: true }, (cell) => {
    cell.border = BORDER_STYLE;
    cell.alignment = { vertical: "middle", horizontal: "left" };
  });
}

function styleInfoRow(worksheet, rowNumber, value) {
  worksheet.mergeCells(`A${rowNumber}:J${rowNumber}`);
  const cell = worksheet.getCell(`A${rowNumber}`);
  cell.value = value;
  cell.font = { bold: true, size: 12, color: { argb: "FF1F1F1F" } };
  cell.fill = INFO_FILL;
  cell.alignment = { vertical: "middle", horizontal: "left" };
  cell.border = BORDER_STYLE;
  worksheet.getRow(rowNumber).height = 20;
}

function styleHeaderRow(row) {
  row.height = 30;
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = HEADER_FILL;
    cell.border = BORDER_STYLE;
    cell.alignment = {
      vertical: "middle",
      horizontal: "center",
      wrapText: true,
    };
  });
}

function styleDataRow(row, rowIndex) {
  const fill = ROW_FILLS[rowIndex % ROW_FILLS.length];
  row.height = 20;
  row.eachCell({ includeEmpty: true }, (cell) => {
    cell.fill = fill;
    cell.border = BORDER_STYLE;
    cell.alignment = { vertical: "middle", horizontal: "left" };
  });
}

function configureWorksheetLayout(worksheet, dataRowStart, dataRowEnd) {
  worksheet.columns = INVENTORY_COLUMNS;
  worksheet.views = [{ state: "frozen", ySplit: dataRowStart - 1 }];
  worksheet.pageSetup = {
    paperSize: 9,
    orientation: "landscape",
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    margins: {
      left: 0.25,
      right: 0.25,
      top: 0.4,
      bottom: 0.4,
      header: 0.2,
      footer: 0.2,
    },
    printTitlesRow: `1:${dataRowStart}`,
  };
  worksheet.headerFooter.oddFooter = "&LSet: &A&C&RPagina &P di &N";
  worksheet.autoFilter = {
    from: { row: dataRowStart, column: 1 },
    to: { row: dataRowStart, column: INVENTORY_COLUMNS.length },
  };

  for (
    let columnIndex = 1;
    columnIndex <= INVENTORY_COLUMNS.length;
    columnIndex += 1
  ) {
    for (let rowIndex = 1; rowIndex <= dataRowEnd; rowIndex += 1) {
      worksheet.getCell(rowIndex, columnIndex).border = BORDER_STYLE;
    }
  }
}

function addSectionContent(worksheet, startRowNumber, section, rowOffsetStart) {
  styleInfoRow(worksheet, startRowNumber, `Set: ${section.setName || "-"}`);
  styleInfoRow(
    worksheet,
    startRowNumber + 1,
    `SetCode: ${section.setCode || "-"}`,
  );

  const headerRowNumber = startRowNumber + 3;
  const headerRow = worksheet.getRow(headerRowNumber);
  headerRow.values = INVENTORY_COLUMNS.map((column) => column.header);
  styleHeaderRow(headerRow);

  const inventoryRows = section.rows.map(buildInventoryRow);
  inventoryRows.sort((left, right) =>
    compareCollectorNumbers(left.cn, right.cn),
  );

  const blankRows = Array.from({ length: section.blankRows }, () => ({
    setCode: section.setCode ?? "",
    cn: "",
    rarity: "",
    nameIT: "",
    condition: "",
    language: "",
    isFirstEd: "",
    warehouseQuantity: "",
    isReverseHolo: "",
    countedQuantity: "",
  }));

  const allRows = inventoryRows.concat(blankRows);
  const dataRowStart = headerRowNumber + 1;

  allRows.forEach((rowData, index) => {
    const row = worksheet.getRow(dataRowStart + index);
    row.values = INVENTORY_COLUMNS.map((column) => rowData[column.key]);
    styleDataRow(row, rowOffsetStart + index);
  });

  return {
    headerRowNumber,
    dataRowEnd: dataRowStart + allRows.length - 1,
    renderedRows: allRows.length,
  };
}

function buildSheetGroups(sortedGroups) {
  const sheetGroups = [];
  const smallGroups = [];

  for (const group of sortedGroups) {
    if (group.rows.length <= SMALL_SET_MAX_ROWS) {
      smallGroups.push(group);
      continue;
    }

    sheetGroups.push([group]);
  }

  for (let index = 0; index < smallGroups.length; index += 2) {
    sheetGroups.push(smallGroups.slice(index, index + 2));
  }

  return sheetGroups;
}

function getSheetName(sections) {
  return sections.map((section) => section.setCode || "UNKNOWN").join(" + ");
}

function addSheetContent(worksheet, sections) {
  let currentRow = 1;
  let alternatingRowOffset = 0;
  let firstHeaderRowNumber = null;
  let lastDataRowEnd = 1;

  for (const [index, section] of sections.entries()) {
    if (index > 0) {
      currentRow += 2;
    }

    const sectionResult = addSectionContent(
      worksheet,
      currentRow,
      section,
      alternatingRowOffset,
    );

    if (firstHeaderRowNumber === null) {
      firstHeaderRowNumber = sectionResult.headerRowNumber;
    }

    alternatingRowOffset += sectionResult.renderedRows;
    lastDataRowEnd = sectionResult.dataRowEnd;
    currentRow = sectionResult.dataRowEnd + 1;
  }

  configureWorksheetLayout(worksheet, firstHeaderRowNumber, lastDataRowEnd);
}

async function generateInventoryWorkbook({ csvPath, outputPath } = {}) {
  if (!csvPath) {
    throw new Error("csvPath is required");
  }

  const resolvedCsvPath = path.resolve(csvPath);
  const resolvedOutputPath =
    outputPath ||
    path.join(
      path.dirname(resolvedCsvPath),
      `${path.basename(
        resolvedCsvPath,
        path.extname(resolvedCsvPath),
      )}-inventario.xlsx`,
    );

  const rows = await readCsvRows(resolvedCsvPath);
  const groupedRows = new Map();

  for (const row of rows) {
    const rarity = String(row.rarity ?? "")
      .trim()
      .toLowerCase();
    if (EXCLUDED_RARITIES.has(rarity)) continue;

    const setCode = String(row.setCode ?? "").trim() || "UNKNOWN";
    const normalizedSetCode = setCode.toLowerCase();
    if (
      EXCLUDED_SET_CODE_PREFIXES.some((prefix) =>
        normalizedSetCode.startsWith(prefix),
      )
    ) {
      continue;
    }

    if (!groupedRows.has(setCode)) {
      groupedRows.set(setCode, {
        setCode,
        setName: row.set ?? "",
        rows: [],
      });
    }

    groupedRows.get(setCode).rows.push(row);
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Codex";
  workbook.created = new Date();
  workbook.modified = new Date();
  workbook.views = [{ x: 0, y: 0, activeTab: 0 }];

  const usedSheetNames = new Set();
  const sortedGroups = Array.from(groupedRows.values()).sort((left, right) =>
    left.setCode.localeCompare(right.setCode, undefined, {
      numeric: true,
      sensitivity: "base",
    }),
  );

  const sheetGroups = buildSheetGroups(sortedGroups);

  for (const sections of sheetGroups) {
    const worksheet = workbook.addWorksheet(
      sanitizeSheetName(getSheetName(sections), usedSheetNames),
      {
        properties: { defaultRowHeight: 20 },
      },
    );

    addSheetContent(
      worksheet,
      sections.map((section) => ({
        ...section,
        blankRows:
          section.rows.length <= SMALL_SET_MAX_ROWS
            ? SMALL_SET_EXTRA_ROWS
            : DEFAULT_EXTRA_ROWS,
      })),
    );
  }

  await workbook.xlsx.writeFile(resolvedOutputPath);
  return {
    sheetCount: sheetGroups.length,
    outputPath: resolvedOutputPath,
  };
}

module.exports = {
  generateInventoryWorkbook,
};

if (require.main === module) {
  const [, , csvPathArg, outputPathArg] = process.argv;
  const fallbackCsvPath = findLatestInventoryCsv();

  generateInventoryWorkbook({
    csvPath: csvPathArg || fallbackCsvPath,
    outputPath: outputPathArg,
  })
    .then((result) => {
      console.log(
        `Workbook creato: ${result.outputPath} | fogli generati: ${result.sheetCount}`,
      );
    })
    .catch((error) => {
      console.error("Errore generazione workbook inventario:", error);
      process.exit(1);
    });
}
