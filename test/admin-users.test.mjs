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
const technicianId = new ObjectId();
const seedUsers = [
  { _id: adminId, image: null, name: "Admin", email: "admin@example.com", role: "admin", createdAt: new Date("2026-11-20T00:00:00Z"), passwordHash: "secret" },
  { _id: customerId, image: "https://example.com/customer.jpg", name: "Customer", email: "customer@example.com", role: "customer", createdAt: new Date("2026-11-22T00:00:00Z"), passwordHash: "secret" },
  { _id: technicianId, name: "Technician", email: "technician@example.com", role: "technician", createdAt: new Date("2026-11-21T00:00:00Z"), passwordHash: "secret" },
];
let users;

const originalCollection = mongoDatabase.collection;
mongoDatabase.collection = (name) => {
  if (name !== "users") throw new Error(`Unexpected collection: ${name}`);
  return {
    findOne: async (filter) => users.find((user) => user._id.equals(filter._id)) ?? null,
    find: (filter, options) => {
      assert.deepEqual(filter, {});
      assert.deepEqual(options.projection, { image: 1, name: 1, email: 1, role: 1, createdAt: 1 });
      return {
        sort: (order) => {
          assert.deepEqual(order, { createdAt: -1, _id: -1 });
          return { toArray: async () => [...users].sort((a, b) => b.createdAt - a.createdAt) };
        },
      };
    },
    findOneAndUpdate: async (filter, update, options) => {
      assert.equal(options.returnDocument, "after");
      assert.deepEqual(options.projection, { image: 1, name: 1, email: 1, role: 1, createdAt: 1 });
      const user = users.find((item) => item._id.equals(filter._id));
      if (!user) return null;
      Object.assign(user, update.$set);
      return user;
    },
  };
};

let server;
let baseUrl;
let adminToken;
let customerToken;
let technicianToken;
before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api/admin/users`;
  [adminToken, customerToken, technicianToken] = await Promise.all([
    createAccessToken(adminId.toHexString()),
    createAccessToken(customerId.toHexString()),
    createAccessToken(technicianId.toHexString()),
  ]);
});
beforeEach(() => { users = seedUsers.map((user) => ({ ...user })); });
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  mongoDatabase.collection = originalCollection;
});

async function listUsers(token) {
  const response = await fetch(baseUrl, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: response.status, body: await response.json() };
}

async function changeRole(id, role, token = adminToken) {
  const response = await fetch(`${baseUrl}/${id}/role`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ role }),
  });
  return { status: response.status, body: await response.json() };
}

test("admin lists only requested user fields, newest first", async () => {
  const result = await listUsers(adminToken);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.map((user) => user.name), ["Customer", "Technician", "Admin"]);
  assert.deepEqual(Object.keys(result.body[0]).sort(), ["createdAt", "email", "id", "image", "name", "role"]);
  assert.equal(result.body[0].id, customerId.toHexString());
  assert.equal(result.body[0].image, "https://example.com/customer.jpg");
  assert.equal(result.body[2].image, null);
});

test("admin changes another user's role to technician, admin, and customer", async () => {
  for (const role of ["technician", "admin", "customer"]) {
    const result = await changeRole(customerId.toHexString(), role);
    assert.equal(result.status, 200);
    assert.equal(result.body.id, customerId.toHexString());
    assert.equal(result.body.role, role);
    assert.equal(users[1].role, role);
  }
});

test("admin cannot change own role", async () => {
  const result = await changeRole(adminId.toHexString(), "customer");
  assert.equal(result.status, 403);
  assert.match(result.body.message, /own role/i);
  assert.equal(users[0].role, "admin");
});

test("invalid ID and role return clear errors", async () => {
  const invalidId = await changeRole("not-an-id", "admin");
  const missingUser = await changeRole(new ObjectId().toHexString(), "admin");
  const invalidRole = await changeRole(customerId.toHexString(), "owner");
  assert.equal(invalidId.status, 400);
  assert.match(invalidId.body.message, /valid user ID/i);
  assert.equal(missingUser.status, 404);
  assert.match(missingUser.body.message, /not found/i);
  assert.equal(invalidRole.status, 400);
  assert.match(invalidRole.body.message, /customer, technician or admin/i);
  assert.equal(users[1].role, "customer");
});

test("non-admin users get 403 for listing and role changes", async () => {
  for (const token of [customerToken, technicianToken]) {
    assert.equal((await listUsers(token)).status, 403);
    assert.equal((await changeRole(customerId.toHexString(), "admin", token)).status, 403);
  }
  assert.equal((await listUsers()).status, 401);
  assert.equal(users[1].role, "customer");
});
