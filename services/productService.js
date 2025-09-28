const { getDB } = require("../config/db");

async function clearProducts() {
  const db = await getDB();
  await db.collection("products").deleteMany({ checked: false });
}

async function saveProduct(product) {
  const db = await getDB();

  const result = await db
    .collection("products")
    .updateOne({ id: product.id }, { $set: product }, { upsert: true });

  return result;
}

module.exports = { clearProducts, saveProduct };
