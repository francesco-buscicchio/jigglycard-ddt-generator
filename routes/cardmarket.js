const router = require('express').Router();
const { fetchAndProcessCardmarketOrders } = require('../controllers/cardmarketController');

router.get('/fetch-orders', fetchAndProcessCardmarketOrders);

module.exports = router;
