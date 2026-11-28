import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { ObjectId } from "mongodb";

process.env.NODE_ENV = "test";

const [{ app }, { mongoDatabase }] = await Promise.all([
  import("../dist/index.js"),
  import("../dist/lib/mongodb.js"),
]);

const serviceId = new ObjectId();
const service = {
  _id: serviceId,
  title: "Phone Screen Repair",
  technicianEmail: "demo.arif@fixmate.example",
  approvalStatus: "approved",
  isAvailable: true,
};
const user = {
  name: "Arif Rahman",
  image: null,
  area: "Dhanmondi, Dhaka",
  bio: "Repairs phones and laptops.",
  email: "demo.arif@fixmate.example",
  role: "technician",
};

const originalCollection = mongoDatabase.collection;
let currentService = service;
let lookupCount = 0;
mongoDatabase.collection = (name) => {
  if (name === "services") return {
    findOne: async (filter) => {
      assert.equal(filter._id.toHexString(), serviceId.toHexString());
      assert.equal(filter.approvalStatus, "approved");
      assert.equal(filter.isAvailable, true);
      return currentService;
    },
  };
  if (name === "users") return {
    findOne: async (filter, options) => {
      lookupCount++;
      assert.deepEqual(filter, { email: service.technicianEmail, role: "technician" });
      assert.deepEqual(options.projection, { _id: 0, name: 1, image: 1, area: 1, bio: 1 });
      return { name: user.name, image: user.image, area: user.area, bio: user.bio };
    },
  };
  throw new Error(`Unexpected collection: ${name}`);
};

let server;
let baseUrl;
before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api/services/${serviceId}`;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  mongoDatabase.collection = originalCollection;
});

test("approved available service returns its technician's public profile only", async () => {
  const response = await fetch(baseUrl);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.title, service.title);
  assert.deepEqual(body.technician, {
    name: user.name,
    image: user.image,
    area: user.area,
    bio: user.bio,
  });
  assert.equal(lookupCount, 1);
});

test("unavailable service stays hidden and does not query the technician", async () => {
  currentService = null;
  const response = await fetch(baseUrl);
  assert.equal(response.status, 404);
  assert.equal(lookupCount, 1);
});
