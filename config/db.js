const { MongoClient, ServerApiVersion } = require("mongodb");

const uri =
  process.env.MONGODB_URI ||
  "mongodb+srv://jigglycard:drMaPWuiE838WTWd@cluster0.ekqifsj.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0";
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

async function getDB() {
  if (!db) {
    await connectDB();
  }
  return db;
}

module.exports = { connectDB, getDB };
