// Persistenza dello stato della coda su MongoDB (VN-16).
// Lo store salva un documento per task (inclusi payload e requestEnv, necessari
// al recovery post-restart: i token tenant restano quindi nel db della coda).
// Ogni scrittura per task è incatenata in ordine per evitare upsert fuori sequenza.

const { connectDB } = require("../config/db");
const {
  TASK_PERSISTENCE_MONGO_URI,
  TASK_PERSISTENCE_DB_NAME,
  TASK_PERSISTENCE_COLLECTION,
} = require("../config/config");

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

class MongoTaskStore {
  constructor({
    mongoUri = TASK_PERSISTENCE_MONGO_URI,
    dbName = TASK_PERSISTENCE_DB_NAME,
    collectionName = TASK_PERSISTENCE_COLLECTION,
  } = {}) {
    this.mongoUri = mongoUri;
    this.dbName = dbName;
    this.collectionName = collectionName;
    this.collection = null;
    this.writeChains = new Map();
    this.failedWrites = 0;
  }

  async init() {
    if (!this.mongoUri) {
      throw new Error(
        "Persistenza task: Mongo URI non configurata (TASK_PERSISTENCE_MONGO_URI o MONGODB_URI).",
      );
    }

    const db = await connectDB({ mongoUri: this.mongoUri, dbName: this.dbName });
    this.collection = db.collection(this.collectionName);
    await this.collection.createIndex({ status: 1 });
    await this.collection.createIndex({ sequence: -1 });
    return this;
  }

  isReady() {
    return this.collection !== null;
  }

  saveTask(taskDocument) {
    if (!this.isReady() || !taskDocument?._id) return Promise.resolve();

    const taskId = taskDocument._id;
    const previousWrite = this.writeChains.get(taskId) ?? Promise.resolve();
    const nextWrite = previousWrite
      .then(() =>
        this.collection.replaceOne({ _id: taskId }, taskDocument, {
          upsert: true,
        }),
      )
      .catch((error) => {
        this.failedWrites += 1;
        console.error(
          JSON.stringify({
            scope: "task-store",
            event: "task_persist_failed",
            taskId,
            error: error.message,
          }),
        );
      })
      .finally(() => {
        if (this.writeChains.get(taskId) === nextWrite) {
          this.writeChains.delete(taskId);
        }
      });

    this.writeChains.set(taskId, nextWrite);
    return nextWrite;
  }

  deleteTask(taskId) {
    if (!this.isReady() || !taskId) return Promise.resolve();

    return this.collection.deleteOne({ _id: taskId }).catch((error) => {
      console.error(
        JSON.stringify({
          scope: "task-store",
          event: "task_delete_failed",
          taskId,
          error: error.message,
        }),
      );
    });
  }

  // Carica tutti i task non terminali più gli ultimi `historyLimit` terminali,
  // ordinati per sequence crescente (l'ordine di enqueue originale).
  async loadTasks({ historyLimit = 250 } = {}) {
    if (!this.isReady()) return [];

    const openTasks = await this.collection
      .find({ status: { $nin: [...TERMINAL_STATUSES] } })
      .toArray();
    const terminalTasks = await this.collection
      .find({ status: { $in: [...TERMINAL_STATUSES] } })
      .sort({ sequence: -1 })
      .limit(Math.max(0, historyLimit))
      .toArray();

    return [...openTasks, ...terminalTasks].sort(
      (left, right) => left.sequence - right.sequence,
    );
  }

  async flush() {
    await Promise.allSettled([...this.writeChains.values()]);
  }
}

module.exports = { MongoTaskStore, TERMINAL_STATUSES };
