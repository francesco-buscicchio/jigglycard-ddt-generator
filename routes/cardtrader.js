const router = require('express').Router();
const { fetchAndProcessOrders } = require('../controllers/cardtraderController');

router.get('/fetch-orders', fetchAndProcessOrders);

module.exports = router;
