import { connectDB } from "../config/db";

export default async function handler(req, res) {
  try {
    console.log("✅ API root chiamata");
    await connectDB();

    res.status(200).json({
      status: "online",
      message: "API Jigglycard CMS attiva 🚀",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("❌ Errore in /api/index:", error);
    res.status(500).json({ error: "Errore interno" });
  }
}
