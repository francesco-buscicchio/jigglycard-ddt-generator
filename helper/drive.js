const fs = require("fs");
const { google } = require("googleapis");
const mime = require("mime-types");
const { Readable } = require("stream");

const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ["https://www.googleapis.com/auth/drive"],
});

const drive = google.drive({ version: "v3", auth });

/**
 * Carica un file su Drive.
 * @param {string} filePath
 * @param {string} fileName
 * @param {string} [folderId]
 * @returns {Promise<{id, webViewLink, webContentLink}>}
 */
exports.uploadFile = async (filePath, fileName, folderId) => {
  const fileMetadata = {
    name: fileName,
    parents: folderId ? [folderId] : [],
  };

  const media = {
    mimeType: mime.lookup(filePath) || "application/octet-stream",
    body: fs.createReadStream(filePath),
  };

  const res = await drive.files.create({
    requestBody: fileMetadata,
    media,
    fields: "id, webViewLink, webContentLink",
  });

  return res.data;
};

/**
 * Trova o crea una sottocartella "DDT [anno]" dentro una cartella padre.
 * @param {string} parentFolderId – ID della cartella "DDT"
 * @param {string} folderName     – es. "DDT 2025"
 * @returns {Promise<string>}     – ID della sottocartella
 */
async function getOrCreateSubfolder(parentFolderId, folderName) {
  const res = await drive.files.list({
    q: `'${parentFolderId}' in parents and name = '${folderName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: "files(id, name)",
    pageSize: 1,
  });

  if (res.data.files.length > 0) {
    return res.data.files[0].id;
  }

  // Crea se non esiste
  const createRes = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentFolderId],
    },
    fields: "id",
  });

  return createRes.data.id;
}

async function getFilesInFolder(
  parentFolderID,
  folderName,
  fileType = "pdf",
  mapFile = true
) {
  const folderRes = await drive.files.list({
    q:
      `'${parentFolderID}' in parents and name = '${folderName}' ` +
      `and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: "files(id)",
    pageSize: 1,
  });

  if (folderRes.data.files.length === 0) {
    return 1;
  }

  const folderId = folderRes.data.files[0].id;

  const filesRes = await drive.files.list({
    q:
      `'${folderId}' in parents and trashed = false ` +
      `and mimeType != 'application/vnd.google-apps.folder'`,
    fields: "files(name)",
    pageSize: 1000,
  });

  if (mapFile)
    return filesRes.data.files
      .map((f) => {
        const safeType = fileType.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); // opzionale se proviene da input esterno

        const re = new RegExp(
          `^\\d{4}-(\\d+)(?:\\s*-\\s*[^.]+)?\\.${safeType}$`
        );

        const m = f.name.match(re);
        return m ? parseInt(m[1], 10) : null;
      })
      .filter(Boolean)
      .sort((a, b) => a - b);
  else return filesRes.data.files;
}

exports.getDDTList = async (mapFile = true) => {
  const year = new Date().getFullYear(); // es. 2025
  const rootId = process.env.DDT_ROOT_FOLDER_ID;
  const rootDocumentsFolder = process.env.ROOT_DDT_ID;
  const yearFolderName = `DDT ${year}`;

  const files = await getFilesInFolder(
    rootId,
    yearFolderName,
    undefined,
    mapFile
  );
  const filesTemp = await getFilesInFolder(
    rootDocumentsFolder,
    "DDT TEMP",
    "xlsx",
    mapFile
  );

  const numbers = [...new Set(files.concat(filesTemp).filter(Boolean))];
  numbers.sort((a, b) => a - b);

  return numbers;
};

exports.getNextDDTNumber = async () => {
  const numbers = await getDDTList();

  let next = 1;
  for (let i = 0; i < numbers.length; i++) {
    if (numbers[i] !== i + 1) {
      next = i + 1;
      break;
    }
  }
  if (
    next === 1 &&
    numbers.length &&
    numbers[numbers.length - 1] === numbers.length
  ) {
    next = numbers.length + 1;
  }

  return next;
};

/** Scarica il contenuto di un file Drive come stringa */
async function downloadText(fileId) {
  const res = await drive.files.get(
    { fileId, alt: "media" }, // alt=media → body = dati del file
    { responseType: "stream" }
  ); // :contentReference[oaicite:0]{index=0}

  return new Promise((resolve, reject) => {
    let data = "";
    res.data
      .on("data", (chunk) => (data += chunk))
      .on("end", () => resolve(data))
      .on("error", reject);
  });
}

exports.downloadText = async (fileId) => {
  const res = await drive.files.get(
    { fileId, alt: "media" }, // alt=media → body = dati del file
    { responseType: "stream" }
  ); // :contentReference[oaicite:0]{index=0}

  return new Promise((resolve, reject) => {
    let data = "";
    res.data
      .on("data", (chunk) => (data += chunk))
      .on("end", () => resolve(data))
      .on("error", reject);
  });
};

exports.uploadText = async (fileId, content) => {
  return drive.files.update({
    fileId,
    media: {
      mimeType: "text/plain",
      body: Readable.from([content]),
    },
  });
};

exports.getOrCreateProcessedFile = async (fileId, content) => {
  const res = await drive.files.list({
    q:
      `'${process.env.ROOT_DDT_ID}' in parents and name='${process.env.PROCESSED_FILE_NAME}' ` +
      `and mimeType='text/plain' and trashed=false`,
    fields: "files(id)",
    pageSize: 1,
  });

  if (res.data.files.length) {
    return res.data.files[0].id;
  }

  const create = await drive.files.create({
    requestBody: {
      name: PROCESSED_FILE_NAME,
      mimeType: "text/plain",
      parents: [ROOT_DDT_ID],
    },
    media: { mimeType: "text/plain", body: "" },
    fields: "id",
  });

  return create.data.id;
};

exports.downloadFileByName = async (fileName) => {
  const year = new Date().getFullYear(); // es. 2025
  const yearFolderName = `DDT ${year}`;

  const rootId = process.env.DDT_ROOT_FOLDER_ID;
  const rootTemp = process.env.ROOT_DDT_ID;

  const findFileInFolder = async (parentId, folderName) => {
    const folderRes = await drive.files.list({
      q: `'${parentId}' in parents and name = '${folderName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: "files(id)",
      pageSize: 1,
    });

    if (!folderRes.data.files.length) return null;
    const folderId = folderRes.data.files[0].id;

    const fileRes = await drive.files.list({
      q: `'${folderId}' in parents and name = '${fileName}' and trashed = false and mimeType != 'application/vnd.google-apps.folder'`,
      fields: "files(id, mimeType, name)",
      pageSize: 1,
    });

    return fileRes.data.files[0] || null;
  };

  const file =
    (await findFileInFolder(rootId, yearFolderName)) ||
    (await findFileInFolder(rootTemp, "DDT TEMP"));

  if (!file) return null;

  const res = await drive.files.get(
    { fileId: file.id, alt: "media" },
    { responseType: "stream" }
  );

  return {
    stream: res.data,
    mimeType: file.mimeType,
    name: file.name,
  };
};
