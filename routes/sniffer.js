const router = require("express").Router();
const { sniffCardtraderProducts } = require("../controllers/snifferController");

router.get("/sniff-cardtrader", sniffCardtraderProducts);

module.exports = router;
