import type { RequestHandler } from "express";
import { ObjectId } from "mongodb";
import { verifyAccessToken } from "../lib/access-token.ts";
import { mongoDatabase } from "../lib/mongodb.ts";

type Role = "customer" | "technician" | "admin";

export const verifyToken: RequestHandler = async (request, response, next) => {
  const match = /^Bearer\s+([^\s]+)$/i.exec(request.headers.authorization ?? "");
  if (!match) {
    response.status(401).json({ message: "Unauthorized" });
    return;
  }

  let userId: string | undefined;
  try {
    userId = await verifyAccessToken(match[1]);
  } catch {
    response.status(401).json({ message: "Unauthorized" });
    return;
  }

  if (!userId || !ObjectId.isValid(userId)) {
    response.status(401).json({ message: "Unauthorized" });
    return;
  }

  const user = await mongoDatabase.collection("users").findOne(
    { _id: new ObjectId(userId) },
    { projection: { role: 1 } },
  );
  if (!user) {
    response.status(401).json({ message: "Unauthorized" });
    return;
  }

  response.locals.authUser = { id: userId, role: user.role };
  next();
};

function verifyRole(role: Role): RequestHandler {
  return (_request, response, next) => {
    const authUser = response.locals.authUser as { id: string; role: unknown } | undefined;
    if (!authUser) {
      response.status(401).json({ message: "Unauthorized" });
      return;
    }
    if (authUser.role !== role) {
      response.status(403).json({ message: "Forbidden" });
      return;
    }
    next();
  };
}

export const verifyCustomer = verifyRole("customer");
export const verifyTechnician = verifyRole("technician");
export const verifyAdmin = verifyRole("admin");
