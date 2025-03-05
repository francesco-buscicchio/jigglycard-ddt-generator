const Excel = require('exceljs');
const { TEMPLATE_FILE } = require('../config/config');
const { setCustomerDetails } = require('../utils/dateUtils');

exports.generateExcel = async (ddtNumber, docAddress, shippingItems, shippingMethod) => {
    const workbook = new Excel.Workbook();
    await workbook.xlsx.readFile(TEMPLATE_FILE);
    let sheet = workbook.getWorksheet(1);
    setCustomerDetails(sheet, docAddress, ddtNumber);

    let row = 19, page = 1;

    if (shippingMethod) {
        sheet.getCell(`A${row}`).value = 'Spedizione:';
        sheet.getCell(`B${row}`).value = shippingMethod.name;
        sheet.getCell(`H${row}`).value = shippingMethod.price / 100;
        row++;
    }

    shippingItems.forEach((item, idx) => {
        if (row > 39) {
            page++;
            sheet = workbook.addWorksheet(`Foglio${page}`);
            setCustomerDetails(sheet, docAddress, ddtNumber);
            row = 19;
        }
        sheet.getCell(`A${row}`).value = item.quantity;
        sheet.getCell(`B${row}`).value = `${item.name} ${item.collectionNumber}`;
        sheet.getCell(`H${row}`).value = (item.price / 100) * item.quantity;
        row++;
    });

    const fileName = `${new Date().getFullYear()}-${ddtNumber}.xlsx`;
    await workbook.xlsx.writeFile(fileName);
};
