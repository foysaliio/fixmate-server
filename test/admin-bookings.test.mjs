import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { ObjectId } from "mongodb";

process.env.NODE_ENV = "test";

const [{ app }, { mongoDatabase }, { createAccessToken }] = await Promise.all([
  import("../dist/index.js"),
  import("../dist/lib/mongodb.js"),
  import("../dist/lib/access-token.js"),
]);

const adminId = new ObjectId();
const firstCustomerId = new ObjectId();
const secondCustomerId = new ObjectId();
const users = [
  { _id: adminId, role: "admin" },
  { _id: firstCustomerId, role: "customer" },
  { _id: secondCustomerId, role: "customer" },
];
const bookings = [
  { _id: new ObjectId(), customerId: firstCustomerId.toHexString(), customerName: "First Customer", technicianName: "Tech A", serviceTitle: "AC repair", status: "requested", paymentStatus: "unpaid", finalAmount: 65, createdAt: new Date("2026-11-24T00:00:00Z") },
  { _id: new ObjectId(), customerId: secondCustomerId.toHexString(), customerName: "Second Customer", technicianName: "Tech B", serviceTitle: "Pipe repair", status: "completed", paymentStatus: "paid", finalAmount: 80, createdAt: new Date("2026-11-25T00:00:00Z") },
];

const originalCollection = mongoDatabase.collection;
mongoDatabase.collection = (name) => {
  if (name === "users") return {
    findOne: async (filter) => users.find((user) => user._id.equals(filter._id)) ?? null,
  };
  if (name === "bookings") return {
    find: (filter) => ({
      sort: (order) => {
        assert.deepEqual(order, { createdAt: -1, _id: -1 });
        return { toArray: async () => bookings.filter((booking) => !filter.status || booking.status === filter.status).sort((a, b) => b.createdAt - a.createdAt) };
      },
    }),
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
  baseUrl = `http://127.0.0.1:${server.address().port}/api/admin/bookings`;
  [adminToken, customerToken] = await Promise.all([
    createAccessToken(adminId.toHexString()),
    createAccessToken(firstCustomerId.toHexString()),
  ]);
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  mongoDatabase.collection = originalCollection;
});

async function getBookings(token, status) {
  const url = status ? `${baseUrl}?status=${encodeURIComponent(status)}` : baseUrl;
  const response = await fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: response.status, body: await response.json() };
}

test("admin sees both customers' bookings, newest first", async () => {
  const result = await getBookings(adminToken);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.map((booking) => booking.customerName), ["Second Customer", "First Customer"]);
  assert.deepEqual(result.body.map((booking) => booking.paymentStatus), ["paid", "unpaid"]);
});

test("status filter returns matching bookings", async () => {
  const completed = await getBookings(adminToken, "completed");
  const requested = await getBookings(adminToken, "requested");
  assert.equal(completed.status, 200);
  assert.deepEqual(completed.body.map((booking) => booking.customerName), ["Second Customer"]);
  assert.deepEqual(requested.body.map((booking) => booking.customerName), ["First Customer"]);
  assert.equal((await getBookings(adminToken, "unknown")).status, 400);
});

test("non-admin gets 403 and unauthenticated request gets 401", async () => {
  assert.equal((await getBookings(customerToken)).status, 403);
  assert.equal((await getBookings()).status, 401);
});
