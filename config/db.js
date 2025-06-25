const { MongoClient, ServerApiVersion } = require("mongodb");

const uri = process.env.MONGODB_URI;
const dbName = process.env.DB_NAME || "CMS";

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

let db;

async function connectDB() {
  if (db) return db;
  await client.connect();
  console.log(`✅  Connesso a MongoDB, database: ${dbName}`);
  db = client.db(dbName);
  return db;
}

function getDB() {
  if (!db) {
    throw new Error("DB non inizializzato: chiama prima connectDB()");
  }
  return db;
}

module.exports = { connectDB, getDB };
