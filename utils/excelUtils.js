exports.setCustomerDetails = (worksheet, docAddress, ddtNumber) => {
    const date = new Date();
    worksheet.getCell('H8').value = docAddress.name;
    worksheet.getCell('H9').value = `${docAddress.street}, ${docAddress.zip}`;
    worksheet.getCell('H10').value = `${docAddress.city}, ${docAddress.state_or_province}`;
    worksheet.getCell('H11').value = docAddress.country;
    worksheet.getCell('D14').value = `${date.getFullYear()}-${ddtNumber}`;
    worksheet.getCell('C17').value = `Ordine: ${docAddress.orderCode}`;
    worksheet.getCell('A41').value = `${docAddress.street}\n${docAddress.zip} ${docAddress.city}, ${docAddress.state_or_province}`;
};
