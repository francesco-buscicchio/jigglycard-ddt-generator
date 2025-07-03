const router = require("express").Router();
const driveController = require("../controllers/driveController");

router.get("/ddt-list", driveController.getDDTList);
router.get("/download", driveController.downloadFileByName);

module.exports = router;
