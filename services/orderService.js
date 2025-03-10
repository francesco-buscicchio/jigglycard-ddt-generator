const { fetchOrders, fetchOrderDetails } = require("./cardTraderService");
const excelService = require("./excelService");
const fileService = require("./fileService");
const { Address, ShippingMethod, ShippingItem } = require("../models");

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

    await excelService.generateExcel(
      ddtNumber,
      docAddress,
      shippingItems,
      shippingMethod
    );
    await fileService.logProcessedOrderId(order.id);
    ddtNumber++;
  }
  await fileService.updateDDTNumber(ddtNumber);
};

function mapShippingAddress(apiResponse) {
  const shippingAddress = new Address({
    name: apiResponse.order_billing_address.name,
    street: apiResponse.order_billing_address.street,
    zip: apiResponse.order_billing_address.zip,
    city: apiResponse.order_billing_address.city,
    state_or_province: apiResponse.order_billing_address.state_or_province,
    country: apiResponse.order_billing_address.country,
    orderCode: apiResponse.code,
  });
  return shippingAddress;
}

function mapShippingMethod(apiResponse) {
  if (
    apiResponse.order_shipping_method &&
    apiResponse.order_shipping_method.id != 1207508
  ) {
    const shippingMethod = new ShippingMethod({
      id: apiResponse.order_shipping_method.id,
      name: apiResponse.order_shipping_method.name,
      price: apiResponse.order_shipping_method.price
        ? apiResponse.order_shipping_method.price.cents
        : 0,
    });

    return shippingMethod;
  }
  return undefined;
}

function mapShippingItems(apiResponse) {
  const allShippingItems = [];
  //to do rimuovere righe non spedite
  for (let item of apiResponse.order_items) {
    const shippingItem = new ShippingItem({
      name: item.name,
      collectionNumber: item.properties.collector_number,
      price: item.seller_price.cents,
      quantity: item.quantity,
    });
    allShippingItems.push(shippingItem);
  }
  return allShippingItems;
}
