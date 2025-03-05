const cardmarketService = require('../services/cardmarketService');

exports.fetchAndProcessCardmarketOrders = async (req, res) => {
    try {
        await cardmarketService.processOrdersFromCSV();
        res.status(200).send('DDTs generated successfully for Cardmarket orders.');
    } catch (error) {
        console.error(error);
        res.status(500).send('An error occurred while processing Cardmarket orders.');
    }
};
