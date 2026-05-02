const { getDB } = require("../config/db");

async function clearProducts(dbOptions = {}) {
  const db = await getDB(dbOptions);
  await db.collection("products").deleteMany({ checked: false });
}

async function saveProduct(product, dbOptions = {}) {
  const db = await getDB(dbOptions);

  const result = await db
    .collection("products")
    .updateOne({ id: product.id }, { $set: product }, { upsert: true });

  return result;
}

module.exports = { clearProducts, saveProduct };
