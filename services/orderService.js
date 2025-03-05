const { fetchOrders, fetchOrderDetails } = require('./cardTraderService');
const excelService = require('./excelService');
const fileService = require('./fileService');
const { mapShippingAddress, mapShippingMethod, mapShippingItems } = require('../models');

exports.processOrders = async () => {
    const processedOrderIds = await fileService.getProcessedOrderIds();
    const orders = await fetchOrders();
    let ddtNumber = await fileService.getDDTNumber();

    for (const order of orders) {
        if (processedOrderIds.includes(order.id.toString())) continue;

        const docAddress = mapShippingAddress(order);
        const orderDetail = await fetchOrderDetails(order.id);
        const shippingMethod = mapShippingMethod(order);
        const shippingItems = mapShippingItems(orderDetail);

        await excelService.generateExcel(ddtNumber, docAddress, shippingItems, shippingMethod);
        await fileService.logProcessedOrderId(order.id);
        ddtNumber++;
    }
    await fileService.updateDDTNumber(ddtNumber);
};
