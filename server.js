const express = require('express');
const axios = require('axios');
const Excel = require('exceljs');
const fs = require('fs-extra');

const app = express();
const PORT = 3000;

const tokenCardTrader = 'eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJjYXJkdHJhZGVyLXByb2R1Y3Rpb24iLCJzdWIiOiJhcHA6MTI5MTEiLCJhdWQiOiJhcHA6MTI5MTEiLCJleHAiOjQ4OTYyNDExNzcsImp0aSI6ImU3YmJiZGNiLTBjZDUtNDY0Mi1iZjY4LWIwMTdkZGVmMGM5NiIsImlhdCI6MTc0MDU2NzU3NywibmFtZSI6IkppZ2dseWNhcmQgQXBwIDIwMjQxMTI4MTA0NzA4In0.JvVthuE_y-RBuA7V7v5ZvHrUww8qO4Ep2wnNCSWokfZ3iy_ZlYpZn4EgWX1qmYJsBZMRezwL_KiidpRBPkVlphVg_vQZBPtv6KqkC3eSzr9gn5gNJNtNjvnvx6bwGIiJHmB-vwd8iuCJQywFgjeQw4CYVcfL3V7KiNwB4ty-k4vPjBCGmOt5dpOLJgL7OUuxsx1kjTvXp2vIW3kCaRou01LZcqZVdmSOxd4LliesqeSfwk5gny0GF1RgTJyCku6aNrO0kZXSo0XJVIU5aSL2XCiSwS0OpJEsHgz7Mmt2LH4xN0yaC-Vyk0WZz-4QIx0CvsRcQQy425ageldkDHu-iw';

const headerRequest = {
    'Authorization': `Bearer ${tokenCardTrader}`
}
const processedOrdersFile = 'processed_orders.txt';


app.get('/fetch-orders', async (req, res) => {
    try {
        const processedOrderIds = await getProcessedOrderIds();
        const orders = await fetchOrders();
        const ddtNumber = await getDDTNumber();
        for (const order of orders) {
            if (processedOrderIds.includes(order.id.toString())) {
                continue;
            }
            const docAddress = mapShippingAddress(order);
            const orderDetail = await fetchOrderDetails(order.id);
            const shippingMethod = mapShippingMethod(order);
            const shippingItems = await mapShippingItems(orderDetail);
            await generateExcel(ddtNumber, docAddress, shippingItems, shippingMethod);
            await logProcessedOrderId(order.id);
            ddtNumber++;
        }
        await updateDDTNumber(ddtNumber);
        res.send('DDTs generated successfully for new orders.');
    } catch (error) {
        console.error('Error:', error);
        res.status(500).send('An error occurred');
    }
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});



function mapShippingAddress(apiResponse) {
    const shippingAddress = new Address({
        name: apiResponse.order_billing_address.name,
        street: apiResponse.order_billing_address.street,
        zip: apiResponse.order_billing_address.zip,
        city: apiResponse.order_billing_address.city,
        state_or_province: apiResponse.order_billing_address.state_or_province,
        country: apiResponse.order_billing_address.country,
        orderCode: apiResponse.code
    });
    return shippingAddress;
}

function mapShippingMethod(apiResponse) {
    if (apiResponse.order_shipping_method && apiResponse.order_shipping_method.id != 1207508) {
        const shippingMethod = new ShippingMethod({
            id: apiResponse.order_shipping_method.id,
            name: apiResponse.order_shipping_method.name,
            price: apiResponse.order_shipping_method.price.cents
        })

        return shippingMethod;
    }
    return undefined;
}

async function getProcessedOrderIds() {
    try {
        const data = await fs.readFile(processedOrdersFile, 'utf8');
        return data.split('\n').filter(id => id.trim() !== '');
    } catch (error) {
        console.error('Error reading processed orders file:', error);
        return [];
    }
}

async function logProcessedOrderId(orderId) {
    try {
        await fs.appendFile(processedOrdersFile, `${orderId}\n`);
    } catch (error) {
        console.error('Error logging processed order ID:', error);
    }
}

function mapShippingItems(apiResponse) {
    const allShippingItems = [];
    for (let item of apiResponse.order_items) {
        const shippingItem = new ShippingItem({
            name: item.name,
            collectionNumber: item.properties.collector_number,
            price: item.seller_price.cents,
            quantity: item.quantity
        })
        allShippingItems.push(shippingItem)
    }
    return allShippingItems;
}

class Address {
    constructor({ name, street, zip, city, state_or_province, country, orderCode }) {
        this.name = name;
        this.street = street;
        this.zip = zip;
        this.city = city;
        this.state_or_province = state_or_province;
        this.country = country
        this.orderCode = orderCode
    }
}

class ShippingMethod {
    constructor({ id, name, price }) {
        this.id = id,
            this.name = name,
            this.price = price
    }
}

class ShippingItem {
    constructor({ name, collectionNumber, price, quantity }) {
        this.quantity = quantity,
            this.name = name,
            this.collectionNumber = collectionNumber ? `(${collectionNumber})` : ''
        this.price = price
    }
}

async function fetchOrders() {
    let allOrders = [];
    let page = 1;
    const limit = 100;

    while (true) {
        const config = {
            headers: headerRequest,
            params: {
                sort: 'date.desc',
                from: '2025-01-01',
                page: page,
                limit: limit
            }
        };

        const response = await axios.get('https://api.cardtrader.com/api/v2/orders', config);
        const orders = response.data || [];

        if (orders.length === 0) {
            break;
        }

        allOrders = allOrders.concat(orders);
        page++;
    }


    allOrders = allOrders.filter((val) => {
        return val.state !== 'hub_pending'
    })
    return allOrders;
}


async function fetchOrderDetails(orderId) {
    const config = {
        headers: headerRequest
    };

    const url = `https://api.cardtrader.com/api/v2/orders/${orderId}`;
    const response = await axios.get(url, config);
    return response.data;
}

async function generateExcel(ddtNumber, docAddress, shippingItems, shippingMethod) {
    const workbook = new Excel.Workbook();
    await workbook.xlsx.readFile('template.xlsx');
    let worksheet = workbook.getWorksheet(1);

    const cloneTemplate = (sourceSheet, sheetName) => {
        const newSheet = workbook.addWorksheet(sheetName);
        sourceSheet.columns.forEach((column, idx) => {
            newSheet.getColumn(idx + 1).width = column.width;
            newSheet.getColumn(idx + 1).style = column.style;
        });

        sourceSheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
            row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
                const newCell = newSheet.getRow(rowNumber).getCell(colNumber);
                newCell.value = cell.value;
                newCell.style = cell.style;
            });
        });

        if (sourceSheet.model.merges) {
            sourceSheet.model.merges.forEach(merge => {
                newSheet.mergeCells(merge);
            });
        }

        return newSheet;
    };

    setCustomerDetails(worksheet, docAddress, ddtNumber);

    let currentRow = 19;
    let pageItem = 1;

    if (shippingMethod !== undefined) {
        worksheet.getCell(`A${currentRow}`).value = 'Spedizione:';
        worksheet.getCell(`B${currentRow}`).value = `${shippingMethod.name}`;
        worksheet.getCell(`H${currentRow}`).value = shippingMethod.price / 100;
    }

    for (let item of shippingItems) {
        if (currentRow > 39) {
            pageItem++;
            worksheet = cloneTemplate(workbook.getWorksheet(1), `Foglio${pageItem}`);
            setCustomerDetails(worksheet, docAddress, ddtNumber);
            currentRow = 19; // Reset row count for new sheet
        }
        worksheet.getCell(`A${currentRow}`).value = item.quantity;
        worksheet.getCell(`B${currentRow}`).value = `${item.name} ${item.collectionNumber}`;
        worksheet.getCell(`H${currentRow}`).value = item.price / 100;
        currentRow++;
    }

    const date = new Date();
    await workbook.xlsx.writeFile(`${date.getFullYear()}-${ddtNumber}.xlsx`);
}

function setCustomerDetails(worksheet, docAddress, ddtNumber) {
    const date = new Date();
    worksheet.getCell('H8').value = docAddress.name;
    worksheet.getCell('H9').value = `${docAddress.street}, ${docAddress.zip}`;
    worksheet.getCell('H10').value = `${docAddress.city}, ${docAddress.state_or_province}`;
    worksheet.getCell('H11').value = docAddress.country;
    worksheet.getCell('D14').value = `${date.getFullYear()}-${ddtNumber}`;
    worksheet.getCell('C17').value = `Ordine: ${docAddress.orderCode}`;
    worksheet.getCell('A41').value = `${docAddress.street}\n${docAddress.zip} ${docAddress.city}, ${docAddress.state_or_province}`;
}

async function getDDTNumber() {
    const content = await fs.readFile('ddt_number.txt', 'utf8');
    const lastNumber = content.split('-')[1];
    return parseInt(lastNumber.trim());
}

async function updateDDTNumber(currentNumber) {
    const year = new Date().getFullYear();
    await fs.writeFile('ddt_number.txt', `${year}-${currentNumber}`);
}
