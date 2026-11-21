import express from "express";
import { ObjectId, type Document, type Filter, type Sort } from "mongodb";
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

  const requestedLimit = typeof request.query.limit === "string" ? request.query.limit : "";
  const parsedLimit = Number(requestedLimit);
  const limit = /^[1-9]\d*$/.test(requestedLimit) && Number.isSafeInteger(parsedLimit)
    ? parsedLimit
    : undefined;

  const cursor = mongoDatabase
    .collection("services")
    .find(filter)
    .sort(limit === undefined ? sort : { createdAt: -1 });

  if (limit !== undefined) {
    cursor.limit(limit);
  }

  const services = await cursor.toArray();

  response.json(services);
});

app.get("/api/services/:id", async (request, response) => {
  const { id } = request.params;

  if (typeof id !== "string" || !ObjectId.isValid(id)) {
    response.status(404).json({ message: "Service not found" });
    return;
  }

  const service = await mongoDatabase.collection("services").findOne({
    _id: new ObjectId(id),
    approvalStatus: "approved",
    isAvailable: true,
  });

  if (!service) {
    response.status(404).json({ message: "Service not found" });
    return;
  }

  response.json(service);
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
