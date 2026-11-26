import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { ObjectId } from "mongodb";

process.env.NODE_ENV = "test";

const [{ app }, { mongoDatabase }, { createAccessToken }] = await Promise.all([
  import("../dist/index.js"),
  import("../dist/lib/mongodb.js"),
  import("../dist/lib/access-token.js"),
]);

const adminId = new ObjectId();
const customerId = new ObjectId();
const users = [
  { _id: adminId, role: "admin" },
  { _id: customerId, role: "customer" },
];
const seedPayments = [
  { _id: new ObjectId(), customerName: "Customer A", technicianName: "Technician A", serviceTitle: "AC repair", paymentStatus: "paid", amount: 10.10, amountCents: 1010, transactionId: "pi_first", paidAt: new Date("2026-11-24T00:00:00Z") },
  { _id: new ObjectId(), customerName: "Customer B", technicianName: "Technician B", serviceTitle: "Pipe repair", paymentStatus: "paid", amount: 20.20, amountCents: 2020, transactionId: "pi_second", paidAt: new Date("2026-11-25T00:00:00Z") },
  { _id: new ObjectId(), paymentStatus: "unpaid", amountCents: 99900, paidAt: new Date("2026-11-26T00:00:00Z") },
];
let payments;

const originalCollection = mongoDatabase.collection;
mongoDatabase.collection = (name) => {
  if (name === "users") return {
    findOne: async (filter) => users.find((user) => user._id.equals(filter._id)) ?? null,
  };
  if (name === "payments") return {
    find: (filter) => {
      assert.deepEqual(filter, { paymentStatus: "paid" });
      return {
        sort: (order) => {
          assert.deepEqual(order, { paidAt: -1, _id: -1 });
          return { toArray: async () => payments.filter((payment) => payment.paymentStatus === "paid").sort((a, b) => b.paidAt - a.paidAt) };
        },
      };
    },
  };
  throw new Error(`Unexpected collection: ${name}`);
};

let server;
let baseUrl;
let adminToken;
let customerToken;
before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api/admin/payments`;
  [adminToken, customerToken] = await Promise.all([
    createAccessToken(adminId.toHexString()),
    createAccessToken(customerId.toHexString()),
  ]);
});
beforeEach(() => { payments = [...seedPayments]; });
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  mongoDatabase.collection = originalCollection;
});

async function getPayments(token) {
  const response = await fetch(baseUrl, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: response.status, body: await response.json() };
}

test("admin receives paid transactions newest first and exact revenue from two payments", async () => {
  const result = await getPayments(adminToken);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.payments.map((payment) => payment.transactionId), ["pi_second", "pi_first"]);
  assert.equal(result.body.totalRevenue, 30.30);
});

test("empty paid history returns zero revenue", async () => {
  payments = [];
  const result = await getPayments(adminToken);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { payments: [], totalRevenue: 0 });
});

test("non-admin gets 403 and missing token gets 401", async () => {
  assert.equal((await getPayments(customerToken)).status, 403);
  assert.equal((await getPayments()).status, 401);
});
