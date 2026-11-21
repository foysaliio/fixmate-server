import { mongodbAdapter } from "@better-auth/mongo-adapter";
import { betterAuth } from "better-auth";
import { mongoClient, mongoDatabase } from "./mongodb.ts";

const secret = process.env.BETTER_AUTH_SECRET;
const baseURL = process.env.BETTER_AUTH_URL;

if (!secret || !baseURL) {
  throw new Error("BETTER_AUTH_SECRET and BETTER_AUTH_URL must be set.");
}

export const auth = betterAuth({
  database: mongodbAdapter(mongoDatabase, { client: mongoClient }),
  secret,
  baseURL,
  trustedOrigins: ["http://localhost:3000"],
  user: { modelName: "users" },
  emailAndPassword: { enabled: true },
});
