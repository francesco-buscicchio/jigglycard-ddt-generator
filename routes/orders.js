const router = require('express').Router();
const { fetchAndProcessOrders } = require('../controllers/orderController');

router.get('/fetch-orders', fetchAndProcessOrders);

module.exports = router;
