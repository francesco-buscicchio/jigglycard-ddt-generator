class ShippingItem {
    constructor({ name, collectionNumber, price, quantity }) {
        this.name = name;
        this.collectionNumber = collectionNumber ? `(${collectionNumber})` : '';
        this.price = price;
        this.quantity = quantity;
    }
}

module.exports = ShippingItem;
