import express from "express";
import type { Document, Filter, Sort } from "mongodb";
import { mongoClient, mongoDatabase } from "./lib/mongodb.ts";

const app = express();
const port = 5000;

app.get("/api/health", (_request, response) => {
  response.json({ status: "ok" });
});

app.get("/api/services", async (request, response) => {
  const filter: Filter<Document> = {
    approvalStatus: "approved",
    isAvailable: true,
  };

  const search = typeof request.query.search === "string" ? request.query.search.trim() : "";

  if (search) {
    const escapedSearch = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(escapedSearch, "i");
    filter.$or = [{ title: pattern }, { category: pattern }];
  }

  if (typeof request.query.category === "string" && request.query.category) {
    filter.category = request.query.category;
  }

  if (typeof request.query.serviceMode === "string" && request.query.serviceMode) {
    filter.serviceMode = request.query.serviceMode;
  }

  const sort: Sort =
    request.query.sort === "price-asc"
      ? { basePrice: 1 }
      : request.query.sort === "price-desc"
        ? { basePrice: -1 }
        : { createdAt: -1 };

  const services = await mongoDatabase
    .collection("services")
    .find(filter)
    .sort(sort)
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
