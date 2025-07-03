const router = require("express").Router();
const multer = require("multer");
const path = require("path");
const {
  fetchAndProcessCardmarketOrders,
  //generateLabel,
  uploadCSV,
} = require("../controllers/cardmarketController");

// Configura multer per salvare i file su disco
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, path.join(__dirname, "../cardmarket-file"));
  },
  filename: function (req, file, cb) {
    cb(null, file.originalname); // Mantiene il nome originale
  },
});
const upload = multer({ storage });

router.get("/fetch-orders", fetchAndProcessCardmarketOrders);
//router.get("/label-generation", generateLabel);
router.post(
  "/upload-csv",
  upload.fields([
    { name: "orders", maxCount: 1 },
    { name: "articles", maxCount: 1 },
  ]),
  uploadCSV
);

module.exports = router;
