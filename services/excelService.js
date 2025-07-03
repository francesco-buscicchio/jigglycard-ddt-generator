const Excel = require("exceljs");
const { uploadFile } = require("../helper/drive");
const { TEMPLATE_FILE, EXPORT_FOLDER } = require("../config/config");
const path = require("path");
const fs = require("fs");
const { exec } = require("child_process");

exports.generateExcel = async (
  ddtNumber,
  docAddress,
  shippingItems,
  shippingMethod
) => {
  const workbook = new Excel.Workbook();
  await workbook.xlsx.readFile(TEMPLATE_FILE);
  let sheet = workbook.getWorksheet(1);
  applyPageSetup(sheet);
  removeColumn(sheet, 11);

  setCustomerDetails(sheet, docAddress, ddtNumber);

  let row = 19,
    page = 1;

  if (shippingMethod) {
    sheet.getCell(`A${row}`).value = 1;
    sheet.getCell(`B${row}`).value = shippingMethod.name;
    sheet.getCell(`H${row}`).value = shippingMethod.price / 100;
    row++;
  }

  shippingItems.forEach((item) => {
    if (row > 39) {
      page++;
      sheet = cloneTemplate(
        workbook,
        workbook.getWorksheet(1),
        `Foglio${page}`,
        sheet
      );
      setCustomerDetails(sheet, docAddress, ddtNumber);
      row = 19;
    }
    sheet.getCell(`A${row}`).value = item.quantity;
    sheet.getCell(`B${row}`).value = `${item.name} ${item.collectionNumber}`;
    sheet.getCell(`H${row}`).value = (item.price / 100) * item.quantity;
    row++;
    applyPageSetup(sheet);
  });

  const fileNameBase = `${new Date().getFullYear()}-${ddtNumber} - ${
    docAddress.name
  }`;
  const fileName = `${fileNameBase}.xlsx`;
  const filePath = path.join(EXPORT_FOLDER, fileName);
  await workbook.xlsx.writeFile(filePath);

  // Upload XLSX to Google Drive
  const folderId = process.env.DRIVE_FOLDER_ID || null;
  await uploadFile(filePath, fileName, folderId);

  // Convert XLSX to PDF
  const pdfPath = path.join(EXPORT_FOLDER, `${fileNameBase}.pdf`);
  await convertExcelToPDFWithLibreOffice(filePath, pdfPath);

  // Upload PDF to Google Drive
  const PDFfolderId = process.env.DRIVE_FOLDER_PDF_TEMP_ID || null;
  await uploadFile(pdfPath, `${fileNameBase}.pdf`, PDFfolderId);
};

function cloneTemplate(workbook, sourceSheet, sheetName, sheet) {
  const newSheet = workbook.addWorksheet(sheetName);
  sourceSheet.columns.forEach((column, idx) => {
    newSheet.getColumn(idx + 1).width = column.width;
    newSheet.getColumn(idx + 1).style = column.style;
  });

  const maxRow = sourceSheet.actualRowCount + 5;
  const maxCol = sourceSheet.columnCount + 5;

  for (let r = 1; r <= maxRow + 3; r++) {
    const sourceRow = sourceSheet.getRow(r);
    const newRow = newSheet.getRow(r);
    for (let c = 1; c <= maxCol + 3; c++) {
      const sourceCell = sourceRow.getCell(c);
      const newCell = newRow.getCell(c);
      newCell.value = sourceCell.value;
      newCell.style = sourceCell.style;
    }
  }

  for (let r = 19; r <= 39; r++) {
    newSheet.getCell(`A${r}`).value = "";
    newSheet.getCell(`B${r}`).value = "";
    newSheet.getCell(`H${r}`).value = "";
  }

  if (sourceSheet.model.merges) {
    sourceSheet.model.merges.forEach((merge) => {
      newSheet.mergeCells(merge);
    });
  }

  return newSheet;
}

function removeColumn(sheet, colIndex) {
  sheet.eachRow((row) => {
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      if (colNumber > colIndex) {
        const leftCell = row.getCell(colNumber - 1);
        leftCell.value = cell.value;
        leftCell.style = cell.style;
      }
    });
    const lastCell = row.getCell(sheet.columnCount);
    lastCell.value = null;
  });
  sheet.getColumn(sheet.columnCount).hidden = true;
}

function setCustomerDetails(worksheet, docAddress, ddtNumber) {
  const date = new Date();
  worksheet.getCell("H8").value = docAddress.name;
  worksheet.getCell("H9").value = `${docAddress.street}`;
  worksheet.getCell(
    "H10"
  ).value = `${docAddress.zip}, ${docAddress.city}, ${docAddress.state_or_province}`;
  worksheet.getCell("H11").value = docAddress.country;
  worksheet.getCell("D14").value = `${date.getFullYear()}-${ddtNumber}`;
  worksheet.getCell("C17").value = `Ordine: ${docAddress.orderCode}`;
  worksheet.getCell(
    "A41"
  ).value = `${docAddress.street}\n${docAddress.zip} ${docAddress.city}, ${docAddress.state_or_province}`;
}

async function convertExcelToPDFWithLibreOffice(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const command = `soffice --headless --convert-to pdf --outdir "${path.dirname(
      outputPath
    )}" "${inputPath}"`;

    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error("Errore durante la conversione con LibreOffice:", stderr);
        return reject(error);
      }

      const convertedPath = path.join(
        path.dirname(outputPath),
        path.basename(inputPath).replace(/\.xlsx$/, ".pdf")
      );
      if (fs.existsSync(convertedPath)) {
        // Rinomina il file se necessario
        if (convertedPath !== outputPath) {
          fs.renameSync(convertedPath, outputPath);
        }
        resolve();
      } else {
        reject(new Error("Il file PDF convertito non è stato trovato."));
      }
    });
  });
}

function applyPageSetup(sheet) {
  sheet.pageSetup = {
    paperSize: 9, // A4
    orientation: "portrait",
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    margins: {
      left: 0.3,
      right: 0.3,
      top: 0.5,
      bottom: 0.5,
      header: 0.2,
      footer: 0.2,
    },
  };
}
