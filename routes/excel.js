const router = require("express").Router();
const { IncomingForm } = require("formidable");
const fsPromises = require("fs/promises");
const os = require("os");
const path = require("path");
const requestQueue = require("../services/requestQueue");
const { getTaskDefinition } = require("../config/taskDefinitions");
const {
  ALLOWED_EXTENSIONS,
  ensureAllowedExcelExtension,
  sanitizeFilename,
} = require("../services/excelConversionService");

function getUploadedFile(files) {
  const candidates = [files?.file, files?.excel, files?.xlsx]
    .flat()
    .filter(Boolean);
  return candidates[0] ?? null;
}

function getIdempotencyKey(req) {
  return String(req.headers["idempotency-key"] || "").trim();
}

router.post("/convert-to-pdf", async (req, res) => {
  const taskType = "excel.convert-to-pdf";
  const definition = getTaskDefinition(taskType);
  const requestId = req.requestId ?? "n/a";
  const sofficeBinaryPath =
    req.requestContext?.requestEnv?.sofficeBinaryPath ?? "";

  if (!definition) {
    return res.status(500).json({
      error: `Definizione task mancante nel registry: ${taskType}`,
      requestId,
    });
  }

  const workingDir = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), "excel-to-pdf-"),
  );
  const outputDir = path.join(workingDir, "output");
  const profileDir = path.join(workingDir, "lo-profile");
  await fsPromises.mkdir(outputDir, { recursive: true });
  await fsPromises.mkdir(profileDir, { recursive: true });

  const form = new IncomingForm({
    multiples: false,
    uploadDir: workingDir,
    keepExtensions: true,
    maxFiles: 1,
    filename: (_, file) => {
      const originalFilename =
        file.originalFilename || `excel-${Date.now()}.xlsx`;
      return sanitizeFilename(originalFilename);
    },
  });

  try {
    const { files } = await new Promise((resolve, reject) => {
      form.parse(req, (error, _fields, parsedFiles) => {
        if (error) return reject(error);
        resolve({ files: parsedFiles });
      });
    });

    const uploadedFile = getUploadedFile(files);
    if (!uploadedFile?.filepath) {
      return res.status(400).json({
        error: "Nessun file Excel ricevuto. Usa il campo `file` nel form-data.",
        requestId,
      });
    }

    const originalFilename =
      uploadedFile.originalFilename || path.basename(uploadedFile.filepath);
    const fileExtension = path.extname(originalFilename).toLowerCase();

    if (!ALLOWED_EXTENSIONS.has(fileExtension)) {
      return res.status(400).json({
        error: "Formato non supportato. Carica un file .xlsx, .xls oppure .ods.",
        requestId,
      });
    }

    ensureAllowedExcelExtension(originalFilename);

    const { task, deduplicated } = requestQueue.enqueueTask({
      taskType: definition.taskType,
      requestId,
      sourceEndpoint: req.originalUrl,
      requestEnv: req.requestContext?.requestEnv ?? {},
      idempotencyKey: getIdempotencyKey(req),
      payload: {
        uploadedFilePath: uploadedFile.filepath,
        originalFilename,
        workingDir,
        outputDir,
        profileDir,
        sofficeBinaryPath,
      },
    });

    return res.status(deduplicated ? 200 : 202).json({
      ok: true,
      deduplicated,
      requestId,
      task,
      links: {
        task: `/api/tasks/${task.id}`,
        result: `/api/tasks/${task.id}/result`,
      },
    });
  } catch (error) {
    await fsPromises.rm(workingDir, { recursive: true, force: true });
    return res.status(error.statusCode ?? 500).json({
      error: error.message ?? "Errore durante la creazione del task Excel -> PDF",
      requestId,
    });
  }
});

module.exports = router;
