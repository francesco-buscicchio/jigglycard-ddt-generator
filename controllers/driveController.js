import driveHelper from "../helper/drive.js"; // o `import * as driveHelper` se è un modulo CommonJS

export async function getDDTList() {
  try {
    const result = await driveHelper.getDDTList(false);
    return {
      status: 200,
      data: result,
    };
  } catch (error) {
    console.error("❌ Errore in getDDTList:", error);
    return {
      status: 500,
      data: "An error occurred while getting DDT List.",
    };
  }
}

export async function downloadFileByName(name) {
  if (!name) {
    return {
      status: 400,
      data: "File name required",
    };
  }

  const fileName = decodeURIComponent(name);

  try {
    const file = await driveHelper.downloadFileByName(fileName);
    if (!file) {
      return {
        status: 404,
        data: "File not found",
      };
    }

    return {
      status: 200,
      file,
    };
  } catch (error) {
    console.error("❌ Errore in downloadFileByName:", error);
    return {
      status: 500,
      data: "Error downloading file",
    };
  }
}
