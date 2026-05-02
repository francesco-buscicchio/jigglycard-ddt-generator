const { MongoClient, ServerApiVersion } = require("mongodb");

const clientsCache = new Map();

function resolveDbConfig(options = {}) {
  const mongoUri =
    options.mongoUri ??
    options.mongodbUri ??
    process.env.MONGODB_URI ??
    process.env.MONGO_URI;
  const dbName = options.dbName ?? process.env.DB_NAME ?? "CMS";

  if (!mongoUri) {
    throw new Error(
      "Mongo URI non configurata. Passa `mongoUri`/`mongodbUri` oppure imposta MONGODB_URI/MONGO_URI.",
    );
  }

  return { mongoUri, dbName };
}

function createMongoClient(mongoUri) {
  return new MongoClient(mongoUri, {
    serverApi: {
      version: ServerApiVersion.v1,
      strict: true,
      deprecationErrors: true,
    },
  });
}

async function connectDB(options = {}) {
  const { mongoUri, dbName } = resolveDbConfig(options);
  const cacheKey = `${mongoUri}::${dbName}`;
  const cachedEntry = clientsCache.get(cacheKey);

  if (cachedEntry?.dbPromise) {
    return cachedEntry.dbPromise;
  }

  const client = createMongoClient(mongoUri);
  const dbPromise = client
    .connect()
    .then(() => {
      console.log(`✅ Connesso a MongoDB, database: ${dbName}`);
      return client.db(dbName);
    })
    .catch((error) => {
      clientsCache.delete(cacheKey);
      throw error;
    });

  clientsCache.set(cacheKey, { client, dbPromise });
  return dbPromise;
}

async function getDB(options = {}) {
  return connectDB(options);
}

module.exports = { connectDB, getDB, resolveDbConfig };
