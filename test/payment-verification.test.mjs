import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { ObjectId, MongoServerError } from "mongodb";

process.env.NODE_ENV = "test";
process.env.STRIPE_SECRET_KEY = "sk_test_mock";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_fixmate_webhook";

const [{ app, ensurePaymentIndexes }, { mongoClient, mongoDatabase }, { createAccessToken }, { getStripeClient }] = await Promise.all([
  import("../dist/index.js"),
  import("../dist/lib/mongodb.js"),
  import("../dist/lib/access-token.js"),
  import("../dist/lib/stripe.js"),
]);

const customerId = new ObjectId();
const otherCustomerId = new ObjectId();
const technicianId = new ObjectId();
const bookingId = new ObjectId();
const stripeSessionId = "cs_test_paid_1";
const customerEmail = "customer@example.com";
const bookingTemplate = {
  _id: bookingId, customerId: customerId.toHexString(), technicianId: technicianId.toHexString(),
  status: "completed", paymentStatus: "unpaid", finalAmount: 12.34,
  checkoutSessionId: stripeSessionId, serviceTitle: "AC repair",
  customerName: "First Customer", customerEmail,
  technicianName: "First Technician", technicianEmail: "technician@example.com",
};
const checkoutTemplate = {
  id: stripeSessionId, mode: "payment", status: "complete", payment_status: "paid",
  currency: "usd", amount_total: 1234, customer_email: customerEmail,
  metadata: { bookingId: bookingId.toHexString(), customerEmail }, payment_intent: "pi_test_1",
};
const users = [
  { _id: customerId, role: "customer" },
  { _id: otherCustomerId, role: "customer" },
  { _id: technicianId, role: "technician" },
];
let bookings;
let payments;
let checkout;
let indexes;
let transactions;
let writesInTransaction;

function matches(document, filter) {
  return Object.entries(filter).every(([key, expected]) =>
    key === "_id" ? document._id.equals(expected) : document[key] === expected);
}

const originalCollection = mongoDatabase.collection;
const originalStartSession = mongoClient.startSession;
mongoDatabase.collection = (name) => {
  if (name === "users") return {
    findOne: async (filter) => users.find((user) => user._id.equals(filter._id)) ?? null,
  };
  if (name === "bookings") return {
    findOne: async (filter, options) => {
      if (options) assert.ok(options.session);
      return bookings.find((booking) => matches(booking, filter)) ?? null;
    },
    updateOne: async (filter, update, options) => {
      assert.ok(options.session);
      writesInTransaction += 1;
      const booking = bookings.find((item) => matches(item, filter));
      if (!booking) return { matchedCount: 0 };
      Object.assign(booking, update.$set);
      return { matchedCount: 1 };
    },
  };
  if (name === "payments") return {
    createIndex: async (keys, options) => { indexes.push({ keys, options }); },
    findOne: async (filter, options) => {
      if (options) assert.ok(options.session);
      return payments.find((payment) => matches(payment, filter)) ?? null;
    },
    insertOne: async (payment, options) => {
      assert.ok(options.session);
      writesInTransaction += 1;
      if (payments.some((item) => item.bookingId === payment.bookingId || item.stripeSessionId === payment.stripeSessionId)) {
        throw new MongoServerError({ ok: 0, code: 11000, errmsg: "duplicate key" });
      }
      const insertedId = new ObjectId();
      payments.push({ _id: insertedId, ...payment });
      return { insertedId };
    },
  };
  throw new Error(`Unexpected collection: ${name}`);
};
mongoClient.startSession = () => {
  const session = {
    withTransaction: async (callback) => {
      transactions += 1;
      const beforeBookings = bookings.map((booking) => ({ ...booking }));
      const beforePayments = payments.map((payment) => ({ ...payment }));
      try {
        await callback();
      } catch (error) {
        bookings = beforeBookings;
        payments = beforePayments;
        throw error;
      }
    },
    endSession: async () => {},
  };
  return session;
};

const stripe = getStripeClient();
assert.ok(stripe);
const originalRetrieve = stripe.checkout.sessions.retrieve;
stripe.checkout.sessions.retrieve = async (id) => id === checkout.id ? checkout : undefined;

let server;
let endpoint;
let webhookEndpoint;
let customerToken;
let otherCustomerToken;
let technicianToken;
before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  endpoint = `http://127.0.0.1:${server.address().port}/api/payments/verify`;
  webhookEndpoint = `http://127.0.0.1:${server.address().port}/api/payments/webhook`;
  [customerToken, otherCustomerToken, technicianToken] = await Promise.all([
    createAccessToken(customerId.toHexString()),
    createAccessToken(otherCustomerId.toHexString()),
    createAccessToken(technicianId.toHexString()),
  ]);
});
beforeEach(() => {
  bookings = [{ ...bookingTemplate }];
  payments = [];
  checkout = { ...checkoutTemplate, metadata: { ...checkoutTemplate.metadata } };
  indexes = [];
  transactions = 0;
  writesInTransaction = 0;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  mongoDatabase.collection = originalCollection;
  mongoClient.startSession = originalStartSession;
  stripe.checkout.sessions.retrieve = originalRetrieve;
});

async function verify(token = customerToken, sessionId = stripeSessionId) {
  const response = await fetch(`${endpoint}?session_id=${encodeURIComponent(sessionId)}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: response.status, body: await response.json() };
}

async function sendWebhook({ validSignature = true, eventId = "evt_test_paid_1" } = {}) {
  const payload = JSON.stringify({
    id: eventId, object: "event", type: "checkout.session.completed",
    data: { object: checkout },
  });
  const signature = stripe.webhooks.generateTestHeaderString({
    payload, secret: validSignature ? process.env.STRIPE_WEBHOOK_SECRET : "whsec_wrong_secret",
  });
  const response = await fetch(webhookEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": signature },
    body: payload,
  });
  return { status: response.status, body: await response.json() };
}

test("payments has unique bookingId and stripeSessionId indexes", async () => {
  await ensurePaymentIndexes();
  assert.deepEqual(indexes, [
    { keys: { bookingId: 1 }, options: { name: "unique_payment_booking", unique: true } },
    { keys: { stripeSessionId: 1 }, options: { name: "unique_payment_stripe_session", unique: true } },
  ]);
});

test("paid session writes receipt and marks booking paid in one transaction", async () => {
  const result = await verify();
  assert.equal(result.status, 200);
  assert.equal(bookings[0].paymentStatus, "paid");
  assert.equal(payments.length, 1);
  assert.equal(transactions, 1);
  assert.equal(writesInTransaction, 2);
  assert.deepEqual({
    bookingId: result.body.bookingId,
    serviceTitle: result.body.serviceTitle,
    customerName: result.body.customerName,
    customerEmail: result.body.customerEmail,
    technicianName: result.body.technicianName,
    technicianEmail: result.body.technicianEmail,
    amount: result.body.amount,
    currency: result.body.currency,
    transactionId: result.body.transactionId,
    stripeSessionId: result.body.stripeSessionId,
    paymentStatus: result.body.paymentStatus,
  }, {
    bookingId: bookingId.toHexString(), serviceTitle: "AC repair",
    customerName: "First Customer", customerEmail,
    technicianName: "First Technician", technicianEmail: "technician@example.com",
    amount: 12.34, currency: "usd", transactionId: "pi_test_1",
    stripeSessionId, paymentStatus: "paid",
  });
  assert.ok(!Number.isNaN(Date.parse(result.body.paidAt)));
});

test("unpaid session is refused without changing the booking", async () => {
  checkout.payment_status = "unpaid";
  const result = await verify();
  assert.equal(result.status, 400);
  assert.equal(bookings[0].paymentStatus, "unpaid");
  assert.equal(payments.length, 0);
  assert.equal(transactions, 0);
});

test("another customer cannot verify the paid session", async () => {
  const result = await verify(otherCustomerToken);
  assert.equal(result.status, 404);
  assert.equal(bookings[0].paymentStatus, "unpaid");
  assert.equal(payments.length, 0);
  assert.equal((await verify(technicianToken)).status, 403);
  assert.equal((await verify(null)).status, 401);
});

test("verifying the same session twice returns the first receipt", async () => {
  const first = await verify();
  const second = await verify();
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.deepEqual(second.body, first.body);
  assert.equal(payments.length, 1);
  assert.equal(bookings[0].paymentStatus, "paid");
  assert.equal(writesInTransaction, 2);
});

test("valid test-mode webhook signature marks booking paid without opening Success page", async () => {
  const result = await sendWebhook();
  assert.equal(result.status, 200);
  assert.equal(bookings[0].paymentStatus, "paid");
  assert.equal(payments.length, 1);
  assert.equal(result.body.paymentId, payments[0]._id.toHexString());
  assert.equal(transactions, 1);
});

test("invalid webhook signature returns 400 and writes nothing", async () => {
  const result = await sendWebhook({ validSignature: false });
  assert.equal(result.status, 400);
  assert.equal(bookings[0].paymentStatus, "unpaid");
  assert.equal(payments.length, 0);
  assert.equal(transactions, 0);
});

test("duplicate signed webhook returns the original payment record", async () => {
  const first = await sendWebhook();
  const second = await sendWebhook();
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(second.body.paymentId, first.body.paymentId);
  assert.equal(payments.length, 1);
  assert.equal(bookings[0].paymentStatus, "paid");
  assert.equal(writesInTransaction, 2);
});

test("completed but unpaid webhook does not mark booking paid", async () => {
  checkout.payment_status = "unpaid";
  const result = await sendWebhook();
  assert.equal(result.status, 200);
  assert.equal(bookings[0].paymentStatus, "unpaid");
  assert.equal(payments.length, 0);
});

test("wrong email, currency, amount or booking session is refused", async () => {
  for (const mutate of [
    () => { checkout.metadata.customerEmail = "wrong@example.com"; },
    () => { checkout.customer_email = "wrong@example.com"; },
    () => { checkout.currency = "bdt"; },
    () => { checkout.amount_total = 100; },
    () => { bookings[0].checkoutSessionId = "cs_test_other"; },
  ]) {
    checkout = { ...checkoutTemplate, metadata: { ...checkoutTemplate.metadata } };
    bookings = [{ ...bookingTemplate }];
    mutate();
    assert.notEqual((await verify()).status, 200);
    assert.equal(bookings[0].paymentStatus, "unpaid");
    assert.equal(payments.length, 0);
  }
});
