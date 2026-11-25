import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { ObjectId, MongoServerError } from "mongodb";

process.env.NODE_ENV = "test";
const [{ app, ensureBookingIndex }, { mongoDatabase }, { createAccessToken }] = await Promise.all([
  import("../dist/index.js"),
  import("../dist/lib/mongodb.js"),
  import("../dist/lib/access-token.js"),
]);

const customerId = new ObjectId();
const secondCustomerId = new ObjectId();
const technicianId = new ObjectId();
const secondTechnicianId = new ObjectId();
const serviceId = new ObjectId();
const users = [
  { _id: customerId, role: "customer", name: "Real Customer", email: "customer@example.com" },
  { _id: secondCustomerId, role: "customer", name: "Second Customer", email: "second@example.com" },
  { _id: technicianId, role: "technician", name: "Real Technician", email: "tech@example.com" },
  { _id: secondTechnicianId, role: "technician", name: "Second Technician", email: "tech2@example.com" },
];
const service = {
  _id: serviceId, approvalStatus: "approved", isAvailable: true, title: "AC repair",
  description: "Repair an AC", category: "AC", serviceMode: "Home Visit", serviceArea: "Dhaka",
  image: "https://i.ibb.co/example", estimatedDuration: "2 hours", basePrice: 1200,
  technicianId: technicianId.toHexString(), technicianName: "Real Technician", technicianEmail: "tech@example.com",
};
const saved = [];
let indexSpec;
let raceGate;
let releaseRace;
let racingLookups = 0;
const originalCollection = mongoDatabase.collection;
mongoDatabase.collection = (name) => {
  if (name === "users") return {
    findOne: async (filter) => users.find((user) => user._id.equals(filter._id) && (!filter.role || user.role === filter.role)) ?? null,
  };
  if (name === "services") return {
    findOne: async (filter) => service._id.equals(filter._id) && service.approvalStatus === filter.approvalStatus && service.isAvailable === filter.isAvailable ? service : null,
  };
  if (name === "bookings") return {
    createIndex: async (keys, options) => { indexSpec = { keys, options }; },
    find: (filter) => ({
      sort: (order) => ({
        toArray: async () => {
          assert.deepEqual(order, { createdAt: -1 });
          return saved.filter((booking) => Object.entries(filter).every(([key, value]) => booking[key] === value))
            .sort((a, b) => b.createdAt - a.createdAt);
        },
      }),
    }),
    findOne: async (filter) => {
      const found = saved.find((booking) => booking.customerId === filter.customerId && booking.serviceId === filter.serviceId && filter.status.$in.includes(booking.status)) ?? null;
      if (raceGate) {
        racingLookups += 1;
        if (racingLookups === 2) releaseRace();
        await raceGate;
      }
      return found;
    },
    findOneAndUpdate: async (filter, update, options) => {
      assert.equal(filter.status, "requested");
      assert.deepEqual(update, { $set: { status: "cancelled" } });
      assert.equal(options.returnDocument, "after");
      const booking = saved.find((item) => item._id.equals(filter._id) && item.customerId === filter.customerId && item.status === filter.status);
      if (!booking) return null;
      booking.status = update.$set.status;
      return booking;
    },
    insertOne: async (booking) => {
      // Simulate the partial unique index when simultaneous requests both pass findOne.
      if (saved.some((item) => item.customerId === booking.customerId && item.serviceId === booking.serviceId && ["requested", "accepted", "in-progress"].includes(item.status))) {
        throw new MongoServerError({ ok: 0, code: 11000, errmsg: "duplicate key" });
      }
      const insertedId = new ObjectId();
      saved.push({ _id: insertedId, ...booking });
      return { insertedId };
    },
  };
  throw new Error(`Unexpected collection: ${name}`);
};

let server;
let url;
let customerToken;
let secondCustomerToken;
let technicianToken;
let secondTechnicianToken;
before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  url = `http://127.0.0.1:${server.address().port}/api/bookings`;
  [customerToken, secondCustomerToken, technicianToken, secondTechnicianToken] = await Promise.all([
    createAccessToken(customerId.toHexString()),
    createAccessToken(secondCustomerId.toHexString()),
    createAccessToken(technicianId.toHexString()),
    createAccessToken(secondTechnicianId.toHexString()),
  ]);
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  mongoDatabase.collection = originalCollection;
});

const payload = () => ({
  serviceId: serviceId.toHexString(), phone: "01700000000", address: "Dhaka",
  preferredDate: new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dhaka", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()),
  problemDescription: "The AC is not cooling properly.",
  customerName: "Forged name", customerEmail: "forged@example.com", finalAmount: 1,
});
async function post(body, token = customerToken) {
  const response = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test("partial unique index covers all active booking statuses", async () => {
  await ensureBookingIndex();
  assert.deepEqual(indexSpec.keys, { customerId: 1, serviceId: 1 });
  assert.equal(indexSpec.options.unique, true);
  assert.deepEqual(indexSpec.options.partialFilterExpression.status.$in, ["requested", "accepted", "in-progress"]);
});

test("invalid input and wrong role are rejected", async () => {
  assert.equal((await post({ ...payload(), serviceId: "bad" })).status, 400);
  assert.equal((await post({ ...payload(), preferredDate: "2020-01-01" })).status, 400);
  assert.equal((await post({ ...payload(), preferredDate: "2026-02-30" })).status, 400);
  assert.equal((await post({ ...payload(), problemDescription: "Too short" })).status, 400);
  assert.equal((await post({ ...payload(), address: " " })).status, 400);
  assert.equal((await post({ ...payload(), phone: "abc" })).status, 400);
  assert.equal((await post(payload(), technicianToken)).status, 403);
  assert.equal((await post(payload(), "invalid")).status, 401);
  assert.equal(saved.length, 0);
});

test("only approved and available services can be booked", async () => {
  service.approvalStatus = "pending";
  assert.equal((await post(payload())).status, 404);
  service.approvalStatus = "approved";
  service.isAvailable = false;
  assert.equal((await post(payload())).status, 404);
  service.isAvailable = true;
  assert.equal(saved.length, 0);
});

test("successful booking uses trusted customer and service data", async () => {
  const result = await post(payload());
  assert.equal(result.status, 201);
  assert.equal(result.body.customerName, "Real Customer");
  assert.equal(result.body.customerEmail, "customer@example.com");
  assert.equal(result.body.technicianName, "Real Technician");
  assert.equal(result.body.status, "requested");
  assert.equal(result.body.paymentStatus, "unpaid");
  assert.equal(result.body.finalAmount, 1200);
  assert.equal(saved.length, 1);
  assert.equal((await post(payload())).status, 409);
});

test("concurrent submissions save one booking and return 409 for the other", async () => {
  saved.length = 0;
  racingLookups = 0;
  raceGate = new Promise((resolve) => { releaseRace = resolve; });
  const results = await Promise.all([post(payload()), post(payload())]);
  raceGate = undefined;
  assert.equal(racingLookups, 2);
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
  assert.equal(saved.length, 1);
});

test("two customers can each read only their own bookings", async () => {
  saved.length = 0;
  saved.push(
    { _id: new ObjectId(), customerId: customerId.toHexString(), serviceId: "first-service", createdAt: new Date("2026-11-24") },
    { _id: new ObjectId(), customerId: secondCustomerId.toHexString(), serviceId: "second-service", createdAt: new Date("2026-11-25") },
    { _id: new ObjectId(), customerId: customerId.toHexString(), serviceId: "newer-first-service", createdAt: new Date("2026-11-26") },
  );

  async function getMine(token) {
    const response = await fetch(`${url}/my`, { headers: { authorization: `Bearer ${token}` } });
    return { status: response.status, body: await response.json() };
  }
  const [first, second, technician, guest] = await Promise.all([
    getMine(customerToken), getMine(secondCustomerToken), getMine(technicianToken),
    fetch(`${url}/my`).then(async (response) => ({ status: response.status, body: await response.json() })),
  ]);
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.map((booking) => booking.serviceId), ["newer-first-service", "first-service"]);
  assert.equal(second.status, 200);
  assert.deepEqual(second.body.map((booking) => booking.serviceId), ["second-service"]);
  assert.equal(technician.status, 403);
  assert.equal(guest.status, 401);
});

test("customer cancels their own requested booking", async () => {
  const booking = { _id: new ObjectId(), customerId: customerId.toHexString(), status: "requested" };
  saved.push(booking);
  const response = await fetch(`${url}/${booking._id}/cancel`, {
    method: "PATCH", headers: { authorization: `Bearer ${customerToken}` },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "cancelled");
  assert.equal(booking.status, "cancelled");
});

test("customer cannot cancel another customer's requested booking", async () => {
  const booking = { _id: new ObjectId(), customerId: secondCustomerId.toHexString(), status: "requested" };
  saved.push(booking);
  const response = await fetch(`${url}/${booking._id}/cancel`, {
    method: "PATCH", headers: { authorization: `Bearer ${customerToken}` },
  });
  assert.equal(response.status, 404);
  assert.equal(booking.status, "requested");
});

test("customer cannot cancel an accepted booking", async () => {
  const booking = { _id: new ObjectId(), customerId: customerId.toHexString(), status: "accepted" };
  saved.push(booking);
  const response = await fetch(`${url}/${booking._id}/cancel`, {
    method: "PATCH", headers: { authorization: `Bearer ${customerToken}` },
  });
  assert.equal(response.status, 404);
  assert.equal(booking.status, "accepted");
});

test("technician requests are scoped to the owner and filtered by status", async () => {
  saved.length = 0;
  const statuses = ["requested", "accepted", "in-progress", "completed", "cancelled"];
  for (const [index, status] of statuses.entries()) {
    saved.push({
      _id: new ObjectId(), technicianId: technicianId.toHexString(),
      status, serviceTitle: `First technician ${status}`,
      createdAt: new Date(2026, 10, 20 + index),
    });
  }
  saved.push({
    _id: new ObjectId(), technicianId: secondTechnicianId.toHexString(),
    status: "requested", serviceTitle: "Second technician request", createdAt: new Date(2026, 10, 25),
  });

  async function getRequests(token, status) {
    const endpoint = new URL(`${url}/technician`);
    if (status) endpoint.searchParams.set("status", status);
    const response = await fetch(endpoint, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    return { status: response.status, body: await response.json() };
  }

  const firstAll = await getRequests(technicianToken);
  assert.equal(firstAll.status, 200);
  assert.deepEqual(firstAll.body.map((booking) => booking.status), [...statuses].reverse());
  assert.ok(firstAll.body.every((booking) => booking.technicianId === technicianId.toHexString()));

  const secondAll = await getRequests(secondTechnicianToken, "all");
  assert.equal(secondAll.status, 200);
  assert.deepEqual(secondAll.body.map((booking) => booking.serviceTitle), ["Second technician request"]);

  for (const status of statuses.slice(0, 4)) {
    const result = await getRequests(technicianToken, status);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.map((booking) => booking.status), [status]);
    assert.ok(result.body.every((booking) => booking.technicianId === technicianId.toHexString()));
  }
  const secondRequested = await getRequests(secondTechnicianToken, "requested");
  assert.deepEqual(secondRequested.body.map((booking) => booking.serviceTitle), ["Second technician request"]);
  assert.equal((await getRequests(technicianToken, "cancelled")).status, 400);
  assert.equal((await getRequests(customerToken, "all")).status, 403);
  assert.equal((await getRequests(undefined, "all")).status, 401);
});
