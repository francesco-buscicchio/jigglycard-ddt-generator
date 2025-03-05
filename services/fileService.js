const fs = require('fs-extra');
const { PROCESSED_ORDERS_FILE, DDT_NUMBER_FILE } = require('../config/config');

exports.getProcessedOrderIds = async () => {
    await fs.ensureFile(PROCESSED_ORDERS_FILE);
    const data = await fs.readFile(PROCESSED_ORDERS_FILE, 'utf8');
    return data.split('\n').filter(Boolean);
};

exports.logProcessedOrderId = async (orderId) => {
    await fs.appendFile(PROCESSED_ORDERS_FILE, `${orderId}\n`);
};

exports.getDDTNumber = async () => {
    const content = await fs.readFile(DDT_NUMBER_FILE, 'utf8');
    return parseInt(content.split('-')[1].trim(), 10);
};

exports.updateDDTNumber = async (num) => {
    const year = new Date().getFullYear();
    await fs.writeFile(DDT_NUMBER_FILE, `${year}-${num}`);
};
