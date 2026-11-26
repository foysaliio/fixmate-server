import express from "express";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import { MongoServerError, ObjectId, type Document, type Filter, type Sort } from "mongodb";
import { auth } from "./lib/auth.ts";
import { mongoClient, mongoDatabase } from "./lib/mongodb.ts";
import { createAccessToken } from "./lib/access-token.ts";
import { getStripeClient } from "./lib/stripe.ts";
import { ensurePaymentIndexes, PaymentVerificationError, saveVerifiedPayment } from "./lib/save-payment.ts";
import { verifyAdmin, verifyCustomer, verifyTechnician, verifyToken } from "./middleware/auth.ts";
import { parseImage, uploadImage } from "./routes/upload-image.ts";

const app = express();
const port = Number(process.env.PORT) || 5000;

app.all("/api/auth/*splat", toNodeHandler(auth));
app.post("/api/payments/webhook", express.raw({ type: "application/json" }), async (request, response) => {
  const stripe = getStripeClient();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripe || !webhookSecret) {
    response.status(503).json({ message: "Payment webhook is not configured" });
    return;
  }

  const signature = request.headers["stripe-signature"];
  if (typeof signature !== "string" || !Buffer.isBuffer(request.body)) {
    response.status(400).json({ message: "Invalid Stripe signature" });
    return;
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(request.body, signature, webhookSecret);
  } catch {
    response.status(400).json({ message: "Invalid Stripe signature" });
    return;
  }

  if (event.type === "checkout.session.completed" && event.data.object.payment_status === "paid") {
    try {
      const payment = await saveVerifiedPayment(event.data.object);
      response.json({ received: true, paymentId: String(payment._id) });
    } catch (error) {
      if (error instanceof PaymentVerificationError) {
        response.status(error.statusCode).json({ message: error.message });
        return;
      }
      throw error;
    }
    return;
  }

  response.json({ received: true });
});
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

const technicianBookingStatuses = new Set(["all", "requested", "accepted", "in-progress", "completed"]);

app.get("/api/bookings/technician", verifyToken, verifyTechnician, async (request, response) => {
  const status = request.query.status ?? "all";
  if (typeof status !== "string" || !technicianBookingStatuses.has(status)) {
    response.status(400).json({ message: "Invalid status" });
    return;
  }

  const technicianId = (response.locals.authUser as { id: string }).id;
  const filter = status === "all" ? { technicianId } : { technicianId, status };
  const bookings = await mongoDatabase.collection("bookings")
    .find(filter)
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

const previousBookingStatus: Record<string, string> = {
  accepted: "requested",
  rejected: "requested",
  "in-progress": "accepted",
  completed: "in-progress",
};

app.patch("/api/bookings/:id/status", verifyToken, verifyTechnician, async (request, response) => {
  const { id } = request.params;
  if (typeof id !== "string" || !ObjectId.isValid(id)) {
    response.status(404).json({ message: "Booking not found or status cannot be changed" });
    return;
  }

  const body: unknown = request.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    response.status(400).json({ message: "Invalid booking status data" });
    return;
  }
  const input = body as Record<string, unknown>;
  const nextStatus = input.status;
  if (typeof nextStatus !== "string" || !Object.hasOwn(previousBookingStatus, nextStatus) ||
    Object.keys(input).some((key) => key !== "status" && key !== "finalAmount")) {
    response.status(400).json({ message: "Invalid booking status data" });
    return;
  }
  if (nextStatus === "completed") {
    if (typeof input.finalAmount !== "number" || !Number.isFinite(input.finalAmount) || input.finalAmount <= 0) {
      response.status(400).json({ message: "finalAmount must be a number greater than 0" });
      return;
    }
  } else if (Object.hasOwn(input, "finalAmount")) {
    response.status(400).json({ message: "finalAmount is only allowed when completing a booking" });
    return;
  }

  const technicianId = (response.locals.authUser as { id: string }).id;
  const update = nextStatus === "completed"
    ? { status: nextStatus, finalAmount: input.finalAmount as number }
    : { status: nextStatus };
  const booking = await mongoDatabase.collection("bookings").findOneAndUpdate(
    { _id: new ObjectId(id), technicianId, status: previousBookingStatus[nextStatus] },
    { $set: update },
    { returnDocument: "after" },
  );
  if (!booking) {
    response.status(404).json({ message: "Booking not found or status cannot be changed" });
    return;
  }
  response.json(booking);
});

app.post("/api/payments/create-checkout-session", verifyToken, verifyCustomer, async (request, response) => {
  const body: unknown = request.body;
  if (!body || typeof body !== "object" || Array.isArray(body) ||
    Object.keys(body).length !== 1 || typeof (body as Record<string, unknown>).bookingId !== "string" ||
    !ObjectId.isValid((body as { bookingId: string }).bookingId)) {
    response.status(400).json({ message: "A valid bookingId is required" });
    return;
  }

  const stripe = getStripeClient();
  const clientUrl = process.env.CLIENT_URL;
  if (!stripe || !clientUrl) {
    response.status(503).json({ message: "Payment checkout is not configured" });
    return;
  }
  let clientOrigin: URL;
  try {
    clientOrigin = new URL(clientUrl);
    if (!["https:", "http:"].includes(clientOrigin.protocol) || clientOrigin.username || clientOrigin.password) {
      throw new Error("Invalid client URL");
    }
  } catch {
    response.status(503).json({ message: "Payment checkout is not configured" });
    return;
  }

  const bookingId = (body as { bookingId: string }).bookingId;
  const customerId = (response.locals.authUser as { id: string }).id;
  const bookings = mongoDatabase.collection("bookings");
  const eligibility = {
    _id: new ObjectId(bookingId), customerId, status: "completed", paymentStatus: "unpaid",
  };
  const booking = await bookings.findOne(eligibility);
  if (!booking) {
    response.status(404).json({ message: "Eligible booking not found" });
    return;
  }

  const finalAmount = booking.finalAmount;
  const cents = typeof finalAmount === "number" && Number.isFinite(finalAmount)
    ? Math.round(finalAmount * 100)
    : 0;
  if (!Number.isSafeInteger(cents) || cents <= 0 ||
    typeof booking.customerEmail !== "string" || !booking.customerEmail.trim()) {
    response.status(409).json({ message: "Booking payment details are invalid" });
    return;
  }

  let attempt = typeof booking.checkoutAttempt === "number" && Number.isSafeInteger(booking.checkoutAttempt)
    ? booking.checkoutAttempt
    : 0;
  let attemptFilter: number | { $exists: false } = typeof booking.checkoutAttempt === "number"
    ? booking.checkoutAttempt
    : { $exists: false };
  if (typeof booking.checkoutSessionId === "string" && booking.checkoutSessionId) {
    const existing = await stripe.checkout.sessions.retrieve(booking.checkoutSessionId);
    if (existing.status === "open" && existing.url && existing.expires_at > Math.floor(Date.now() / 1000)) {
      if (existing.amount_total !== cents || existing.currency !== "usd" ||
        existing.metadata?.bookingId !== bookingId || existing.metadata?.customerEmail !== booking.customerEmail) {
        response.status(409).json({ message: "Checkout details do not match this booking" });
        return;
      }
      response.json({ url: existing.url });
      return;
    }
    if (existing.status === "complete") {
      response.status(409).json({ message: "Payment is already being processed" });
      return;
    }

    const refreshed = await bookings.findOneAndUpdate(
      { ...eligibility, checkoutSessionId: booking.checkoutSessionId },
      { $inc: { checkoutAttempt: 1 }, $unset: { checkoutSessionId: "" } },
      { returnDocument: "after" },
    );
    if (!refreshed) {
      response.status(409).json({ message: "Checkout changed. Please try again." });
      return;
    }
    attempt = refreshed.checkoutAttempt as number;
    attemptFilter = attempt;
  }

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    customer_email: booking.customerEmail,
    line_items: [{
      price_data: {
        currency: "usd",
        unit_amount: cents,
        product_data: { name: typeof booking.serviceTitle === "string" && booking.serviceTitle.trim() ? booking.serviceTitle : "FixMate repair" },
      },
      quantity: 1,
    }],
    metadata: { bookingId, customerEmail: booking.customerEmail },
    success_url: new URL("/payment/success?session_id={CHECKOUT_SESSION_ID}", clientOrigin).toString(),
    cancel_url: new URL("/payment/cancel", clientOrigin).toString(),
  }, { idempotencyKey: `fixmate-booking-${bookingId}-attempt-${attempt}` });
  if (session.status !== "open" || !session.url) {
    response.status(502).json({ message: "Checkout is unavailable" });
    return;
  }

  const saved = await bookings.updateOne(
    { ...eligibility, checkoutSessionId: { $exists: false }, checkoutAttempt: attemptFilter },
    { $set: { checkoutSessionId: session.id } },
  );
  if (!saved.matchedCount) {
    const current = await bookings.findOne(eligibility);
    if (current?.checkoutSessionId === session.id) {
      response.json({ url: session.url });
      return;
    }
    response.status(409).json({ message: "Checkout changed. Please try again." });
    return;
  }
  response.json({ url: session.url });
});

app.get("/api/payments/verify", verifyToken, verifyCustomer, async (request, response) => {
  const sessionId = request.query.session_id;
  if (typeof sessionId !== "string" || !sessionId.startsWith("cs_") || sessionId.length > 255) {
    response.status(400).json({ message: "A valid session_id is required" });
    return;
  }

  const stripe = getStripeClient();
  if (!stripe) {
    response.status(503).json({ message: "Payment verification is not configured" });
    return;
  }

  let checkout;
  try {
    checkout = await stripe.checkout.sessions.retrieve(sessionId);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "resource_missing") {
      response.status(404).json({ message: "Checkout Session not found" });
      return;
    }
    throw error;
  }

  try {
    const customerId = (response.locals.authUser as { id: string }).id;
    const receipt = await saveVerifiedPayment(checkout, customerId);
    response.json(receipt);
  } catch (error) {
    if (error instanceof PaymentVerificationError) {
      response.status(error.statusCode).json({ message: error.message });
      return;
    }
    throw error;
  }
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
    await ensurePaymentIndexes();

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

export { app, ensureBookingIndex, ensurePaymentIndexes };
