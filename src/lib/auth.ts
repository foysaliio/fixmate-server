import { mongodbAdapter } from "@better-auth/mongo-adapter";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
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
  user: {
    modelName: "users",
    additionalFields: {
      role: {
        type: ["customer", "technician"],
        required: true,
        defaultValue: "customer",
        input: false,
      },
      phone: { type: "string", required: false },
      area: { type: "string", required: false },
      bio: { type: "string", required: false },
    },
  },
  emailAndPassword: { enabled: true, minPasswordLength: 6 },
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== "/sign-up/email") return;

      const password = ctx.body?.password;
      if (
        typeof password !== "string" ||
        password.length < 6 ||
        !/[A-Z]/.test(password) ||
        !/[a-z]/.test(password)
      ) {
        throw new APIError("BAD_REQUEST", {
          message: "Password must have at least 6 characters, one uppercase and one lowercase letter.",
        });
      }
    }),
  },
  databaseHooks: {
    user: {
      create: {
        before: async (user, context) => ({
          data: {
            ...user,
            role:
              context?.path === "/sign-up/email" && context.body?.role === "technician"
                ? "technician"
                : "customer",
          },
        }),
      },
    },
  },
});
