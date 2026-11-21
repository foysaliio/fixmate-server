import express from "express";
import { mongoClient, mongoDatabase } from "./lib/mongodb.ts";

const app = express();
const port = 5000;

app.get("/api/health", (_request, response) => {
  response.json({ status: "ok" });
});

app.get("/api/services", async (_request, response) => {
  const services = await mongoDatabase
    .collection("services")
    .find({ approvalStatus: "approved", isAvailable: true })
    .sort({ createdAt: -1 })
    .toArray();

  response.json(services);
});

async function startServer() {
  try {
    await mongoClient.connect();
    await mongoDatabase.command({ ping: 1 });
    console.log("MongoDB ping succeeded.");

    app.listen(port, () => {
      console.log(`FixMate server listening on http://localhost:${port}`);
    });
  } catch {
    console.error("MongoDB ping failed; server was not started.");
    await mongoClient.close();
    process.exitCode = 1;
  }
}

void startServer();
