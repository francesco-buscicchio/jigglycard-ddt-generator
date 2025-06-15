const fs = require("fs-extra");
const { PROCESSED_ORDERS_FILE, DDT_NUMBER_FILE } = require("../config/config");
const {
  getNextDDTNumber,
  getOrCreateProcessedFile,
  downloadText,
  uploadText,
} = require("../helper/drive");

exports.getProcessedOrderIds = async () => {
  const fileId = await getOrCreateProcessedFile();
  const raw = await downloadText(fileId);
  return raw.split("\n").filter(Boolean);
};

exports.logProcessedOrderId = async (orderId) => {
  const fileId = await getOrCreateProcessedFile();
  const current = await downloadText(fileId);
  const updated = current + orderId + "\n";
  await uploadText(fileId, updated);
};

exports.getDDTNumber = async () => {
  const numero = await getNextDDTNumber();
  return numero;
};

exports.updateDDTNumber = async (num) => {
  const year = new Date().getFullYear();
  await fs.writeFile(DDT_NUMBER_FILE, `${year}-${num}`);
};
