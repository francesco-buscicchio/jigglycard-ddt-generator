const driveHelper = require("../helper/drive");

exports.getDDTList = async (req, res) => {
  try {
    const result = await driveHelper.getDDTList(false);
    res.status(200).send(result);
  } catch (error) {
    res.status(500).send("An error occurred while getting DDT List.");
  }
};

exports.downloadFileByName = async (req, res) => {
  const rawName = req.query.name;
  if (!rawName) return res.status(400).send("File name required");
  const fileName = decodeURIComponent(rawName);

  try {
    const file = await driveHelper.downloadFileByName(fileName);
    if (!file) return res.status(404).send("File not found");

    res.setHeader("Content-Disposition", `attachment; filename="${file.name}"`);
    res.setHeader("Content-Type", file.mimeType);
    file.stream.pipe(res);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error downloading file");
  }
};
