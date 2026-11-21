import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";

const envPath = fileURLToPath(new URL("../../.env", import.meta.url));

if (existsSync(envPath)) {
  loadEnvFile(envPath);
}

const uri = process.env.MONGODB_URI;
const databaseName = process.env.MONGODB_DB;

if (!uri || !databaseName) {
  throw new Error("MONGODB_URI and MONGODB_DB must be set.");
}

export const mongoClient = new MongoClient(uri);
export const mongoDatabase = mongoClient.db(databaseName);
