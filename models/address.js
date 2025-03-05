class Address {
    constructor({ name, street, zip, city, state_or_province, country, orderCode }) {
        this.name = name;
        this.street = street;
        this.zip = zip;
        this.city = city;
        this.state_or_province = state_or_province;
        this.country = country;
        this.orderCode = orderCode;
    }
}

module.exports = Address;
