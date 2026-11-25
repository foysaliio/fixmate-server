import express from "express";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import { MongoServerError, ObjectId, type Document, type Filter, type Sort } from "mongodb";
import { auth } from "./lib/auth.ts";
import { mongoClient, mongoDatabase } from "./lib/mongodb.ts";
import { createAccessToken } from "./lib/access-token.ts";
import { verifyAdmin, verifyCustomer, verifyTechnician, verifyToken } from "./middleware/auth.ts";
import { parseImage, uploadImage } from "./routes/upload-image.ts";

const app = express();
const port = Number(process.env.PORT) || 5000;

app.all("/api/auth/*splat", toNodeHandler(auth));
app.use(express.json());

app.get("/api/health", (_request, response) => {
  response.json({ status: "ok" });
});

app.post("/api/access-token", async (request, response) => {
  const session = await auth.api.getSession({
    headers: fromNodeHeaders(request.headers),
  });

  if (!session) {
    response.status(401).json({ message: "Unauthorized" });
    return;
  }

  const accessToken = await createAccessToken(session.user.id);
  response.json({ accessToken, expiresIn: 600 });
});

app.post("/api/uploads/image", verifyToken, parseImage, uploadImage);

const profileFields = new Set(["name", "phone", "area", "bio", "image"]);

function isImgBbImageUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "i.ibb.co" &&
      !url.port &&
      !url.username &&
      !url.password &&
      url.pathname.length > 1
    );
  } catch {
    return false;
  }
}

app.patch("/api/users/profile", verifyToken, async (request, response) => {
  const body: unknown = request.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    response.status(400).json({ message: "Invalid profile data" });
    return;
  }

  const entries = Object.entries(body);
  if (!entries.length || entries.some(([key]) => !profileFields.has(key))) {
    response.status(400).json({ message: "Only name, phone, area, bio and image can be updated" });
    return;
  }

  const updates: Record<string, string | null | Date> = {};
  for (const [key, value] of entries) {
    if (key === "image") {
      if (value !== null && (typeof value !== "string" || !isImgBbImageUrl(value))) {
        response.status(400).json({ message: "Image must be an HTTPS ImgBB image URL" });
        return;
      }
      updates.image = value;
      continue;
    }

    if (typeof value !== "string" || (key === "name" && !value.trim())) {
      response.status(400).json({ message: `Invalid ${key}` });
      return;
    }
    updates[key] = value.trim();
  }

  updates.updatedAt = new Date();
  const userId = (response.locals.authUser as { id: string }).id;
  const user = await mongoDatabase.collection("users").findOneAndUpdate(
    { _id: new ObjectId(userId) },
    { $set: updates },
    {
      returnDocument: "after",
      projection: { name: 1, email: 1, role: 1, phone: 1, area: 1, bio: 1, image: 1 },
    },
  );

  if (!user) {
    response.status(404).json({ message: "User not found" });
    return;
  }

  response.json({
    id: String(user._id),
    name: user.name,
    email: user.email,
    role: user.role,
    phone: user.phone ?? "",
    area: user.area ?? "",
    bio: user.bio ?? "",
    image: user.image ?? null,
  });
});

const serviceCategories = new Set([
  "Smartphone",
  "Laptop & PC",
  "AC",
  "Refrigerator",
  "TV",
  "Washing Machine",
  "Electrical",
]);
const serviceModes = new Set(["Home Visit", "Workshop"]);

app.post("/api/services", verifyToken, verifyTechnician, async (request, response) => {
  const body: unknown = request.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    response.status(400).json({ message: "Invalid service data" });
    return;
  }

  const input = body as Record<string, unknown>;
  const requiredText = ["title", "description", "estimatedDuration", "serviceArea"] as const;
  for (const field of requiredText) {
    if (typeof input[field] !== "string" || !input[field].trim()) {
      response.status(400).json({ message: `${field} is required` });
      return;
    }
  }
  if (typeof input.category !== "string" || !serviceCategories.has(input.category)) {
    response.status(400).json({ message: "Invalid category" });
    return;
  }
  if (typeof input.serviceMode !== "string" || !serviceModes.has(input.serviceMode)) {
    response.status(400).json({ message: "Invalid serviceMode" });
    return;
  }
  if (typeof input.basePrice !== "number" || !Number.isFinite(input.basePrice) || input.basePrice <= 0) {
    response.status(400).json({ message: "basePrice must be greater than 0" });
    return;
  }
  if (typeof input.image !== "string" || !isImgBbImageUrl(input.image)) {
    response.status(400).json({ message: "Image must be an HTTPS ImgBB image URL" });
    return;
  }

  const technicianId = (response.locals.authUser as { id: string }).id;
  const technician = await mongoDatabase.collection("users").findOne(
    { _id: new ObjectId(technicianId), role: "technician" },
    { projection: { name: 1, email: 1 } },
  );
  if (!technician) {
    response.status(403).json({ message: "Forbidden" });
    return;
  }

  const service = {
    title: (input.title as string).trim(),
    description: (input.description as string).trim(),
    category: input.category,
    basePrice: input.basePrice,
    estimatedDuration: (input.estimatedDuration as string).trim(),
    serviceMode: input.serviceMode,
    serviceArea: (input.serviceArea as string).trim(),
    image: input.image,
    technicianId,
    technicianName: technician.name,
    technicianEmail: technician.email,
    approvalStatus: "pending",
    isAvailable: true,
    createdAt: new Date(),
  };
  const result = await mongoDatabase.collection("services").insertOne(service);
  response.status(201).json({ _id: result.insertedId, ...service });
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

app.get("/api/services/my", verifyToken, verifyTechnician, async (_request, response) => {
  const technicianId = (response.locals.authUser as { id: string }).id;
  const services = await mongoDatabase
    .collection("services")
    .find({ technicianId: { $in: [technicianId, new ObjectId(technicianId)] } })
    .sort({ createdAt: -1 })
    .toArray();

  response.json(services);
});

const editableServiceFields = new Set([
  "title",
  "description",
  "category",
  "basePrice",
  "estimatedDuration",
  "serviceMode",
  "serviceArea",
  "image",
]);

function ownedServiceFilter(id: string, technicianId: string): Filter<Document> {
  return {
    _id: new ObjectId(id),
    technicianId: { $in: [technicianId, new ObjectId(technicianId)] },
  };
}

app.patch("/api/services/:id", verifyToken, verifyTechnician, async (request, response) => {
  const { id } = request.params;
  if (typeof id !== "string" || !ObjectId.isValid(id)) {
    response.status(404).json({ message: "Service not found" });
    return;
  }

  const body: unknown = request.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    response.status(400).json({ message: "Invalid service data" });
    return;
  }

  const entries = Object.entries(body);
  if (!entries.length || entries.some(([key]) => !editableServiceFields.has(key))) {
    response.status(400).json({ message: "Invalid service fields" });
    return;
  }

  const updates: Record<string, string | number> = {};
  for (const [key, value] of entries) {
    if (["title", "description", "estimatedDuration", "serviceArea"].includes(key)) {
      if (typeof value !== "string" || !value.trim()) {
        response.status(400).json({ message: `Invalid ${key}` });
        return;
      }
      updates[key] = value.trim();
    } else if (key === "category") {
      if (typeof value !== "string" || !serviceCategories.has(value)) {
        response.status(400).json({ message: "Invalid category" });
        return;
      }
      updates.category = value;
    } else if (key === "serviceMode") {
      if (typeof value !== "string" || !serviceModes.has(value)) {
        response.status(400).json({ message: "Invalid serviceMode" });
        return;
      }
      updates.serviceMode = value;
    } else if (key === "basePrice") {
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        response.status(400).json({ message: "basePrice must be greater than 0" });
        return;
      }
      updates.basePrice = value;
    } else if (key === "image") {
      if (typeof value !== "string" || !isImgBbImageUrl(value)) {
        response.status(400).json({ message: "Image must be an HTTPS ImgBB image URL" });
        return;
      }
      updates.image = value;
    }
  }

  const technicianId = (response.locals.authUser as { id: string }).id;
  const service = await mongoDatabase.collection("services").findOneAndUpdate(
    ownedServiceFilter(id, technicianId),
    { $set: { ...updates, approvalStatus: "pending" } },
    { returnDocument: "after" },
  );
  if (!service) {
    response.status(404).json({ message: "Service not found" });
    return;
  }
  response.json(service);
});

app.patch("/api/services/:id/availability", verifyToken, verifyTechnician, async (request, response) => {
  const { id } = request.params;
  if (typeof id !== "string" || !ObjectId.isValid(id)) {
    response.status(404).json({ message: "Service not found" });
    return;
  }

  const body: unknown = request.body;
  if (!body || typeof body !== "object" || Array.isArray(body) ||
    Object.keys(body).length !== 1 || typeof (body as Record<string, unknown>).isAvailable !== "boolean") {
    response.status(400).json({ message: "isAvailable must be a boolean" });
    return;
  }

  const technicianId = (response.locals.authUser as { id: string }).id;
  const service = await mongoDatabase.collection("services").findOneAndUpdate(
    ownedServiceFilter(id, technicianId),
    { $set: { isAvailable: (body as { isAvailable: boolean }).isAvailable } },
    { returnDocument: "after" },
  );
  if (!service) {
    response.status(404).json({ message: "Service not found" });
    return;
  }
  response.json(service);
});

app.delete("/api/services/:id", verifyToken, verifyTechnician, async (request, response) => {
  const { id } = request.params;
  if (typeof id !== "string" || !ObjectId.isValid(id)) {
    response.status(404).json({ message: "Service not found" });
    return;
  }

  const technicianId = (response.locals.authUser as { id: string }).id;
  const result = await mongoDatabase.collection("services").deleteOne(ownedServiceFilter(id, technicianId));
  if (!result.deletedCount) {
    response.status(404).json({ message: "Service not found" });
    return;
  }
  response.status(204).send();
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

const activeBookingStatuses = ["requested", "accepted", "in-progress"];

async function ensureBookingIndex() {
  await mongoDatabase.collection("bookings").createIndex(
    { customerId: 1, serviceId: 1 },
    {
      name: "unique_active_customer_service_booking",
      unique: true,
      partialFilterExpression: { status: { $in: activeBookingStatuses } },
    },
  );
}

app.post("/api/bookings", verifyToken, verifyCustomer, async (request, response) => {
  const body: unknown = request.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    response.status(400).json({ message: "Invalid booking data" });
    return;
  }

  const input = body as Record<string, unknown>;
  if (typeof input.serviceId !== "string" || !/^[0-9a-fA-F]{24}$/.test(input.serviceId)) {
    response.status(400).json({ message: "Invalid serviceId" });
    return;
  }
  for (const field of ["phone", "address"] as const) {
    if (typeof input[field] !== "string" || !input[field].trim()) {
      response.status(400).json({ message: `${field} is required` });
      return;
    }
  }
  const phone = (input.phone as string).trim();
  if (!/^\+?[\d\s()-]+$/.test(phone) || !/^\d{7,15}$/.test(phone.replace(/\D/g, ""))) {
    response.status(400).json({ message: "Invalid phone" });
    return;
  }
  if (typeof input.problemDescription !== "string" || input.problemDescription.trim().length < 20) {
    response.status(400).json({ message: "problemDescription must be at least 20 characters" });
    return;
  }
  const preferredDate = input.preferredDate;
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Dhaka", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  if (typeof preferredDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(preferredDate) ||
    Number.isNaN(Date.parse(`${preferredDate}T00:00:00Z`)) ||
    new Date(`${preferredDate}T00:00:00Z`).toISOString().slice(0, 10) !== preferredDate ||
    preferredDate < today) {
    response.status(400).json({ message: "preferredDate must be today or a future date (YYYY-MM-DD)" });
    return;
  }

  const customerId = (response.locals.authUser as { id: string }).id;
  const customer = await mongoDatabase.collection("users").findOne(
    { _id: new ObjectId(customerId), role: "customer" },
    { projection: { name: 1, email: 1 } },
  );
  if (!customer) {
    response.status(403).json({ message: "Forbidden" });
    return;
  }

  const serviceId = new ObjectId(input.serviceId);
  const service = await mongoDatabase.collection("services").findOne({
    _id: serviceId, approvalStatus: "approved", isAvailable: true,
  });
  if (!service) {
    response.status(404).json({ message: "Service not found" });
    return;
  }

  const bookings = mongoDatabase.collection("bookings");
  const bookingKey = { customerId, serviceId: serviceId.toHexString() };
  if (await bookings.findOne({ ...bookingKey, status: { $in: activeBookingStatuses } }, { projection: { _id: 1 } })) {
    response.status(409).json({ message: "An active booking already exists for this service" });
    return;
  }

  const booking = {
    ...bookingKey,
    customerName: customer.name,
    customerEmail: customer.email,
    phone,
    address: (input.address as string).trim(),
    preferredDate,
    problemDescription: input.problemDescription.trim(),
    serviceTitle: service.title,
    serviceDescription: service.description,
    serviceCategory: service.category,
    serviceMode: service.serviceMode,
    serviceArea: service.serviceArea,
    serviceImage: service.image,
    estimatedDuration: service.estimatedDuration,
    basePrice: service.basePrice,
    technicianId: service.technicianId,
    technicianName: service.technicianName,
    technicianEmail: service.technicianEmail,
    status: "requested",
    paymentStatus: "unpaid",
    finalAmount: service.basePrice,
    createdAt: new Date(),
  };
  try {
    const result = await bookings.insertOne(booking);
    response.status(201).json({ _id: result.insertedId, ...booking });
  } catch (error) {
    if (error instanceof MongoServerError && error.code === 11000) {
      response.status(409).json({ message: "An active booking already exists for this service" });
      return;
    }
    throw error;
  }
});

app.get("/api/bookings/my", verifyToken, verifyCustomer, async (_request, response) => {
  const customerId = (response.locals.authUser as { id: string }).id;
  const bookings = await mongoDatabase.collection("bookings")
    .find({ customerId })
    .sort({ createdAt: -1 })
    .toArray();
  response.json(bookings);
});

app.patch("/api/bookings/:id/cancel", verifyToken, verifyCustomer, async (request, response) => {
  const { id } = request.params;
  if (typeof id !== "string" || !ObjectId.isValid(id)) {
    response.status(404).json({ message: "Booking not found or cannot be cancelled" });
    return;
  }

  const customerId = (response.locals.authUser as { id: string }).id;
  const booking = await mongoDatabase.collection("bookings").findOneAndUpdate(
    { _id: new ObjectId(id), customerId, status: "requested" },
    { $set: { status: "cancelled" } },
    { returnDocument: "after" },
  );
  if (!booking) {
    response.status(404).json({ message: "Booking not found or cannot be cancelled" });
    return;
  }
  response.json(booking);
});

const adminServiceStatuses = new Set(["pending", "approved", "rejected", "all"]);

app.get("/api/admin/services", verifyToken, verifyAdmin, async (request, response) => {
  const status = request.query.status === undefined ? "pending" : request.query.status;
  if (typeof status !== "string" || !adminServiceStatuses.has(status)) {
    response.status(400).json({ message: "Invalid status" });
    return;
  }

  const filter = status === "all" ? {} : { approvalStatus: status };
  const services = await mongoDatabase.collection("services").find(filter).sort({ createdAt: -1 }).toArray();
  response.json(services);
});

app.patch("/api/admin/services/:id/approval", verifyToken, verifyAdmin, async (request, response) => {
  const { id } = request.params;
  if (typeof id !== "string" || !ObjectId.isValid(id)) {
    response.status(404).json({ message: "Service not found" });
    return;
  }

  const body: unknown = request.body;
  if (!body || typeof body !== "object" || Array.isArray(body) ||
    Object.keys(body).length !== 1 || !["approved", "rejected"].includes((body as Record<string, unknown>).approvalStatus as string)) {
    response.status(400).json({ message: "approvalStatus must be approved or rejected" });
    return;
  }

  const service = await mongoDatabase.collection("services").findOneAndUpdate(
    { _id: new ObjectId(id) },
    { $set: { approvalStatus: (body as { approvalStatus: "approved" | "rejected" }).approvalStatus } },
    { returnDocument: "after" },
  );
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

    await ensureBookingIndex();

    app.listen(port, () => {
      console.log(`FixMate server listening on http://localhost:${port}`);
    });
  } catch {
    console.error("MongoDB ping failed; server was not started.");
    await mongoClient.close();
    process.exitCode = 1;
  }
}

if (process.env.NODE_ENV !== "test") {
  void startServer();
}

export { app, ensureBookingIndex };
