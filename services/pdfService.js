const path = require("path");
const { execFile } = require("child_process");
const fs = require("fs/promises");
const { uploadFile } = require("../helper/drive");

const SOFFICE_BIN = process.env.SOFFICE_BIN || "soffice";
const EXPORT_FOLDER =
  process.env.EXPORT_FOLDER || path.resolve(__dirname, "exports");

async function convertExcelToPdf(excelPath, outputDir = EXPORT_FOLDER) {
  await fs.access(excelPath);

  await new Promise((resolve, reject) => {
    execFile(
      SOFFICE_BIN,
      [
        "--headless",
        "--convert-to",
        "pdf:calc_pdf_Export",
        "--outdir",
        outputDir,
        excelPath,
      ],
      (err, _, stderr) => {
        if (err) {
          err.message += `\nLibreOffice stderr: ${stderr}`;
          return reject(err);
        }
        return resolve();
      }
    );
  });

  const pdfPath = path.join(
    outputDir,
    path.basename(excelPath, ".xlsx") + ".pdf"
  );

  await fs.access(pdfPath);
  return pdfPath;
}

async function uploadPDF(pdfPath, folderId) {
  const pdfName = path.basename(pdfPath);
  const [pdfRes] = await uploadFile(pdfPath, pdfName, folderId);
  return { pdf: pdfRes };
}

async function processConversion(excelPath, folderId) {
  if (!excelPath.endsWith(".xlsx")) {
    throw new Error("Il file da convertire deve avere estensione .xlsx");
  }

  const pdfPath = await convertExcelToPdf(excelPath);
  const results = await uploadPDF(pdfPath, folderId);
  return results;
}

module.exports = {
  processConversion,
};
