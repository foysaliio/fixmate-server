import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { ObjectId } from "mongodb";

process.env.NODE_ENV = "test";
process.env.STRIPE_SECRET_KEY = "sk_test_mock";
process.env.CLIENT_URL = "http://localhost:3000";

const [{ app }, { mongoDatabase }, { createAccessToken }, { getStripeClient }] = await Promise.all([
  import("../dist/index.js"),
  import("../dist/lib/mongodb.js"),
  import("../dist/lib/access-token.js"),
  import("../dist/lib/stripe.js"),
]);

const customerId = new ObjectId();
const otherCustomerId = new ObjectId();
const technicianId = new ObjectId();
const ownBooking = {
  _id: new ObjectId(), customerId: customerId.toHexString(), status: "completed",
  paymentStatus: "unpaid", customerEmail: "first@example.com", serviceTitle: "AC repair",
  finalAmount: 12.34,
};
const otherBooking = {
  _id: new ObjectId(), customerId: otherCustomerId.toHexString(), status: "completed",
  paymentStatus: "unpaid", customerEmail: "second@example.com", finalAmount: 20,
};
const incompleteBooking = {
  _id: new ObjectId(), customerId: customerId.toHexString(), status: "in-progress",
  paymentStatus: "unpaid", customerEmail: "first@example.com", finalAmount: 30,
};
const paidBooking = {
  _id: new ObjectId(), customerId: customerId.toHexString(), status: "completed",
  paymentStatus: "paid", customerEmail: "first@example.com", finalAmount: 40,
};
const bookings = [ownBooking, otherBooking, incompleteBooking, paidBooking];
const users = [
  { _id: customerId, role: "customer" },
  { _id: otherCustomerId, role: "customer" },
  { _id: technicianId, role: "technician" },
];

function matches(document, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === "_id") return document._id.equals(expected);
    if (expected && typeof expected === "object" && "$exists" in expected) {
      return (key in document) === expected.$exists;
    }
    return document[key] === expected;
  });
}

const originalCollection = mongoDatabase.collection;
mongoDatabase.collection = (name) => {
  if (name === "users") return {
    findOne: async (filter) => users.find((user) => user._id.equals(filter._id)) ?? null,
  };
  if (name === "bookings") return {
    findOne: async (filter) => bookings.find((booking) => matches(booking, filter)) ?? null,
    findOneAndUpdate: async (filter, update, options) => {
      assert.equal(options.returnDocument, "after");
      const booking = bookings.find((item) => matches(item, filter));
      if (!booking) return null;
      if (update.$inc) for (const [key, amount] of Object.entries(update.$inc)) booking[key] = (booking[key] ?? 0) + amount;
      if (update.$unset) for (const key of Object.keys(update.$unset)) delete booking[key];
      return booking;
    },
    updateOne: async (filter, update) => {
      const booking = bookings.find((item) => matches(item, filter));
      if (!booking) return { matchedCount: 0 };
      Object.assign(booking, update.$set);
      return { matchedCount: 1 };
    },
  };
  throw new Error(`Unexpected collection: ${name}`);
};

const stripe = getStripeClient();
assert.ok(stripe);
const sessions = new Map();
const created = [];
const originalCreate = stripe.checkout.sessions.create;
const originalRetrieve = stripe.checkout.sessions.retrieve;
stripe.checkout.sessions.create = async (params, options) => {
  created.push({ params, options });
  const id = `cs_test_${created.length}`;
  const session = {
    id, status: "open", payment_status: "unpaid", expires_at: Math.floor(Date.now() / 1000) + 3600,
    url: `https://checkout.stripe.com/c/pay/${id}`,
    amount_total: params.line_items[0].price_data.unit_amount,
    currency: params.line_items[0].price_data.currency,
    metadata: params.metadata,
  };
  sessions.set(id, session);
  return session;
};
stripe.checkout.sessions.retrieve = async (id) => sessions.get(id);

let server;
let endpoint;
let customerToken;
let technicianToken;
before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  endpoint = `http://127.0.0.1:${server.address().port}/api/payments/create-checkout-session`;
  [customerToken, technicianToken] = await Promise.all([
    createAccessToken(customerId.toHexString()),
    createAccessToken(technicianId.toHexString()),
  ]);
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  mongoDatabase.collection = originalCollection;
  stripe.checkout.sessions.create = originalCreate;
  stripe.checkout.sessions.retrieve = originalRetrieve;
});

async function checkout(bookingId, token = customerToken, extra = {}) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ bookingId: bookingId.toString(), ...extra }),
  });
  return { status: response.status, body: await response.json() };
}

test("own completed unpaid booking creates a USD Checkout URL from saved amount", async () => {
  const result = await checkout(ownBooking._id, customerToken, { finalAmount: 1 });
  assert.equal(result.status, 400);
  const valid = await checkout(ownBooking._id);
  assert.equal(valid.status, 200);
  assert.equal(valid.body.url, "https://checkout.stripe.com/c/pay/cs_test_1");
  assert.equal(ownBooking.checkoutSessionId, "cs_test_1");
  assert.equal(created.length, 1);
  assert.equal(created[0].params.line_items[0].price_data.unit_amount, 1234);
  assert.equal(created[0].params.line_items[0].price_data.currency, "usd");
  assert.equal(created[0].params.customer_email, "first@example.com");
  assert.deepEqual(created[0].params.metadata, { bookingId: ownBooking._id.toHexString(), customerEmail: "first@example.com" });
  assert.equal(created[0].params.success_url, "http://localhost:3000/payment/success?session_id={CHECKOUT_SESSION_ID}");
  assert.equal(created[0].params.cancel_url, "http://localhost:3000/payment/cancel");
  assert.equal(created[0].options.idempotencyKey, `fixmate-booking-${ownBooking._id}-attempt-0`);
});

test("active Checkout Session is reused, expired session is replaced", async () => {
  const reused = await checkout(ownBooking._id);
  assert.equal(reused.status, 200);
  assert.equal(reused.body.url, "https://checkout.stripe.com/c/pay/cs_test_1");
  assert.equal(created.length, 1);

  sessions.get("cs_test_1").status = "expired";
  const renewed = await checkout(ownBooking._id);
  assert.equal(renewed.status, 200);
  assert.equal(renewed.body.url, "https://checkout.stripe.com/c/pay/cs_test_2");
  assert.equal(ownBooking.checkoutSessionId, "cs_test_2");
  assert.equal(ownBooking.checkoutAttempt, 1);
  assert.equal(created[1].options.idempotencyKey, `fixmate-booking-${ownBooking._id}-attempt-1`);

  sessions.get("cs_test_2").amount_total = 1;
  assert.equal((await checkout(ownBooking._id)).status, 409);
  sessions.get("cs_test_2").amount_total = 1234;
});

test("other customer's, incomplete and paid bookings cannot create Checkout", async () => {
  const count = created.length;
  assert.equal((await checkout(otherBooking._id)).status, 404);
  assert.equal((await checkout(incompleteBooking._id)).status, 404);
  assert.equal((await checkout(paidBooking._id)).status, 404);
  assert.equal((await checkout(ownBooking._id, technicianToken)).status, 403);
  assert.equal(created.length, count);
});

test("invalid stored amount and missing authorization are rejected", async () => {
  const invalid = {
    _id: new ObjectId(), customerId: customerId.toHexString(), status: "completed",
    paymentStatus: "unpaid", customerEmail: "first@example.com", finalAmount: 0,
  };
  bookings.push(invalid);
  assert.equal((await checkout(invalid._id)).status, 409);
  const guest = await fetch(endpoint, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ bookingId: ownBooking._id.toHexString() }),
  });
  assert.equal(guest.status, 401);
});
