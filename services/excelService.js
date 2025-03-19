const Excel = require("exceljs");
const { TEMPLATE_FILE, EXPORT_FOLDER } = require("../config/config");

exports.generateExcel = async (
  ddtNumber,
  docAddress,
  shippingItems,
  shippingMethod
) => {
  const workbook = new Excel.Workbook();
  await workbook.xlsx.readFile(TEMPLATE_FILE);
  let sheet = workbook.getWorksheet(1);

  const cloneTemplate = (sourceSheet, sheetName) => {
    const newSheet = workbook.addWorksheet(sheetName);
    sourceSheet.columns.forEach((column, idx) => {
      newSheet.getColumn(idx + 1).width = column.width;
      newSheet.getColumn(idx + 1).style = column.style;
    });

    sourceSheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        const newCell = newSheet.getRow(rowNumber).getCell(colNumber);
        newCell.value = cell.value;
        newCell.style = cell.style;
      });
    });

    if (sourceSheet.model.merges) {
      sourceSheet.model.merges.forEach((merge) => {
        newSheet.mergeCells(merge);
      });
    }

    return newSheet;
  };

  setCustomerDetails(sheet, docAddress, ddtNumber);

  let row = 19,
    page = 1;

  if (shippingMethod) {
    sheet.getCell(`A${row}`).value = 1;
    sheet.getCell(`B${row}`).value = shippingMethod.name;
    sheet.getCell(`H${row}`).value = shippingMethod.price / 100;
    row++;
  }

  shippingItems.forEach((item, idx) => {
    if (row > 39) {
      page++;
      sheet = cloneTemplate(workbook.getWorksheet(1), `Foglio${page}`);
      setCustomerDetails(sheet, docAddress, ddtNumber);
      row = 19;
    }
    sheet.getCell(`A${row}`).value = item.quantity;
    sheet.getCell(`B${row}`).value = `${item.name} ${item.collectionNumber}`;
    sheet.getCell(`H${row}`).value = (item.price / 100) * item.quantity;
    row++;
  });

  const fileName = `${new Date().getFullYear()}-${ddtNumber}.xlsx`;
  const filePath = `${EXPORT_FOLDER}/${fileName}`;
  await workbook.xlsx.writeFile(filePath);
};

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
