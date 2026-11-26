import { ObjectId } from "mongodb";
import { auth } from "../lib/auth.ts";
import { mongoClient, mongoDatabase } from "../lib/mongodb.ts";

function readDemoPassword(): string {
  const value = process.env.DEMO_PASSWORD;
  if (!value || value.length < 6 || !/[A-Z]/.test(value) || !/[a-z]/.test(value)) {
    throw new Error("DEMO_PASSWORD in .env needs at least 6 characters, one uppercase and one lowercase letter.");
  }
  return value;
}

const password = readDemoPassword();

const people = [
  { key: "technician-one", name: "Arif Rahman", email: "demo.arif@fixmate.example", role: "technician", phone: "+8801711000101", area: "Dhanmondi, Dhaka" },
  { key: "technician-two", name: "Nusrat Jahan", email: "demo.nusrat@fixmate.example", role: "technician", phone: "+8801711000102", area: "Uttara, Dhaka" },
  { key: "customer", name: "Sadia Ahmed", email: "demo.sadia@fixmate.example", role: "customer", phone: "+8801711000103", area: "Mirpur, Dhaka" },
] as const;

const previousPhotos = {
  Smartphone: "https://images.unsplash.com/photo-1550041473-d296a3a8a18a?auto=format&fit=crop&w=900&q=80",
  "Laptop & PC": "https://images.unsplash.com/photo-1658240527554-9cf987b4de49?auto=format&fit=crop&w=900&q=80",
  AC: "https://images.unsplash.com/photo-1792799881226-e841c0f9c125?auto=format&fit=crop&w=900&q=80",
  Refrigerator: "https://images.unsplash.com/photo-1736390718073-76ea3393258d?auto=format&fit=crop&w=900&q=80",
  TV: "https://images.unsplash.com/photo-1461151304267-38535e780c79?auto=format&fit=crop&w=900&q=80",
  "Washing Machine": "https://images.unsplash.com/photo-1758279745240-b75977c88fa8?auto=format&fit=crop&w=900&q=80",
  Electrical: "https://images.unsplash.com/photo-1751486289947-4f5f5961b3aa?auto=format&fit=crop&w=900&q=80",
} as const;

const photo = (id: string) => `https://images.unsplash.com/${id}?auto=format&fit=crop&w=900&q=80`;

const previousTitles: Record<string, string> = {
  "phone-screen": "Smartphone Screen Replacement",
  "phone-battery": "Smartphone Battery Replacement",
  "laptop-diagnosis": "Laptop Startup & Hardware Diagnosis",
  "laptop-cleaning": "Laptop Cooling System Service",
  "ac-service": "Split AC Cleaning & Performance Check",
  "ac-drain": "AC Water Leak Diagnosis",
  "fridge-cooling": "Refrigerator Cooling Diagnosis",
  "fridge-seal": "Refrigerator Door Seal Service",
  "tv-diagnosis": "LED TV Picture & Sound Diagnosis",
  "tv-input": "Smart TV Connectivity & Input Setup",
  "washer-drain": "Washing Machine Drainage Repair",
  "socket-repair": "Electrical Socket & Switch Repair",
  "pending-lighting": "Ceiling Light Wiring Inspection",
};

const cardSummaries: Record<string, string> = {
  "phone-screen": "Cracked screen replacement with touch and display checks.",
  "phone-battery": "Battery health check and replacement for fast draining phones.",
  "laptop-diagnosis": "Find the cause of startup, shutdown, or hardware faults.",
  "laptop-cleaning": "Fan and vent cleaning with a cooling performance check.",
  "ac-service": "Filter and coil cleaning with a full cooling check.",
  "ac-drain": "Drain line inspection and repair for a leaking indoor unit.",
  "fridge-cooling": "Temperature, fan, and seal checks to restore cooling.",
  "fridge-seal": "Door gasket inspection and fitting for a better seal.",
  "tv-diagnosis": "Identify display, backlight, input, and audio faults.",
  "tv-input": "Fix HDMI and Wi-Fi issues, then set up your smart TV.",
  "washer-drain": "Pump, filter, and hose checks for drainage problems.",
  "socket-repair": "Safe inspection and replacement of a faulty socket or switch.",
  "pending-lighting": "Inspect flickering lights, switches, and visible wiring.",
};

const serviceDefinitions = [
  { key: "phone-screen", title: "Phone Screen Repair", category: "Smartphone", image: photo("photo-1550041473-d296a3a8a18a"), description: "Diagnosis and replacement of a cracked or unresponsive smartphone display. Includes touch and brightness checks after fitting.", basePrice: 35, estimatedDuration: "1–2 hours", serviceMode: "Workshop", serviceArea: "Dhanmondi, Dhaka", technician: "technician-one" },
  { key: "phone-battery", title: "Phone Battery Repair", category: "Smartphone", image: photo("photo-1632050587914-a1c784fe7941"), description: "Battery health check and replacement for a phone that drains quickly, overheats, or shuts down unexpectedly.", basePrice: 25, estimatedDuration: "45–90 minutes", serviceMode: "Workshop", serviceArea: "Dhanmondi, Dhaka", technician: "technician-one" },
  { key: "laptop-diagnosis", title: "Laptop Diagnostics", category: "Laptop & PC", image: photo("photo-1658240527554-9cf987b4de49"), description: "Find the cause of startup failures, overheating, or unexpected shutdowns, with a clear repair estimate before parts are changed.", basePrice: 30, estimatedDuration: "1–2 hours", serviceMode: "Workshop", serviceArea: "Dhanmondi, Dhaka", technician: "technician-one" },
  { key: "laptop-cleaning", title: "Laptop Cooling Repair", category: "Laptop & PC", image: photo("photo-1653154726310-5dcc764680ce"), description: "Clean the cooling fan and vents, inspect thermal contact, and check temperatures under load.", basePrice: 28, estimatedDuration: "1–2 hours", serviceMode: "Workshop", serviceArea: "Dhanmondi, Dhaka", technician: "technician-one" },
  { key: "ac-service", title: "AC Deep Cleaning", category: "AC", image: photo("photo-1792799881226-e841c0f9c125"), description: "Clean accessible filters and coils, check drainage, and measure cooling performance. Refrigerant work is quoted separately.", basePrice: 45, estimatedDuration: "2–3 hours", serviceMode: "Home Visit", serviceArea: "Uttara, Dhaka", technician: "technician-two" },
  { key: "ac-drain", title: "AC Water Leak Repair", category: "AC", image: photo("photo-1762341123870-d706f257a12e"), description: "Inspect the indoor unit, drain line, and condensate path to identify and clear common causes of water leakage.", basePrice: 38, estimatedDuration: "1–2 hours", serviceMode: "Home Visit", serviceArea: "Uttara, Dhaka", technician: "technician-two" },
  { key: "fridge-cooling", title: "Fridge Cooling Repair", category: "Refrigerator", image: photo("photo-1736390718073-76ea3393258d"), description: "Check temperature, door seals, fan operation, and controls to identify why the fridge is not cooling properly.", basePrice: 42, estimatedDuration: "1–2 hours", serviceMode: "Home Visit", serviceArea: "Uttara, Dhaka", technician: "technician-two" },
  { key: "fridge-seal", title: "Fridge Door Seal", category: "Refrigerator", image: photo("photo-1722603929403-de9e80c46a9a"), description: "Inspect and fit a compatible door gasket to reduce warm air leaks and excess compressor cycling. Part cost is quoted separately.", basePrice: 32, estimatedDuration: "1–2 hours", serviceMode: "Home Visit", serviceArea: "Uttara, Dhaka", technician: "technician-two" },
  { key: "tv-diagnosis", title: "TV Display Repair", category: "TV", image: photo("photo-1461151304267-38535e780c79"), description: "Test the display, backlight, inputs, and audio path to identify picture or sound faults before repair.", basePrice: 40, estimatedDuration: "1–2 hours", serviceMode: "Home Visit", serviceArea: "Dhanmondi, Dhaka", technician: "technician-one" },
  { key: "tv-input", title: "Smart TV Setup", category: "TV", image: photo("photo-1560169897-fc0cdbdfa4d5"), description: "Troubleshoot HDMI, Wi-Fi, and app connectivity, then verify the television works with connected devices.", basePrice: 25, estimatedDuration: "1 hour", serviceMode: "Home Visit", serviceArea: "Dhanmondi, Dhaka", technician: "technician-one" },
  { key: "washer-drain", title: "Washer Drain Repair", category: "Washing Machine", image: photo("photo-1758279745240-b75977c88fa8"), description: "Inspect the drain pump, filter, and hose when a washer will not empty or stops mid-cycle. Parts are quoted separately.", basePrice: 48, estimatedDuration: "2–3 hours", serviceMode: "Home Visit", serviceArea: "Uttara, Dhaka", technician: "technician-two" },
  { key: "socket-repair", title: "Socket & Switch Repair", category: "Electrical", image: photo("photo-1751486289947-4f5f5961b3aa"), description: "Safely inspect and replace a faulty wall socket or switch, then test the circuit before restoring power.", basePrice: 30, estimatedDuration: "1–2 hours", serviceMode: "Home Visit", serviceArea: "Uttara, Dhaka", technician: "technician-two" },
  { key: "pending-lighting", title: "Ceiling Light Wiring", category: "Electrical", image: photo("photo-1788855745756-94fce2addc69"), description: "Inspect a flickering ceiling light, switch connection, and visible wiring before recommending a repair.", basePrice: 35, estimatedDuration: "1–2 hours", serviceMode: "Home Visit", serviceArea: "Uttara, Dhaka", technician: "technician-two", approvalStatus: "pending" },
] as const;

if (new Set(serviceDefinitions.map((service) => service.image)).size !== serviceDefinitions.length) {
  throw new Error("Every demo service must have a distinct photo.");
}

const bookingDefinitions = [
  { key: "requested", serviceKey: "phone-screen", status: "requested", problemDescription: "The screen is cracked and touch input sometimes stops working." },
  { key: "accepted", serviceKey: "laptop-diagnosis", status: "accepted", problemDescription: "The laptop shuts down without warning after about ten minutes." },
  { key: "in-progress", serviceKey: "ac-service", status: "in-progress", problemDescription: "The AC cools weakly and the indoor unit needs cleaning." },
  { key: "completed-unpaid", serviceKey: "washer-drain", status: "completed", problemDescription: "The washer leaves water in the drum after every cycle." },
] as const;

async function ensurePerson(person: typeof people[number]) {
  const users = mongoDatabase.collection("users");
  let user = await users.findOne({ email: person.email });
  let created = 0;
  if (!user) {
    // The server hook reads role from the request body; input:false omits it from Better Auth's public type.
    await auth.api.signUpEmail({ body: {
      name: person.name, email: person.email, password, phone: person.phone, area: person.area,
      role: person.role,
    } as never });
    user = await users.findOne({ email: person.email });
    created = 1;
  }
  if (!user || user.role !== person.role || user.name !== person.name) {
    throw new Error(`Demo account conflict for ${person.email}; existing account was left untouched.`);
  }
  return { user, created };
}

async function run() {
  await mongoClient.connect();
  try {
    await mongoDatabase.command({ ping: 1 });
    const services = mongoDatabase.collection("services");
    const bookings = mongoDatabase.collection("bookings");
    await services.createIndex({ demoSeedKey: 1 }, { name: "unique_demo_service_key", unique: true, partialFilterExpression: { demoSeedKey: { $exists: true } } });
    await bookings.createIndex({ demoSeedKey: 1 }, { name: "unique_demo_booking_key", unique: true, partialFilterExpression: { demoSeedKey: { $exists: true } } });

    const accounts = new Map<string, NonNullable<Awaited<ReturnType<typeof ensurePerson>>["user"]>>();
    let usersCreated = 0;
    for (const person of people) {
      const result = await ensurePerson(person);
      accounts.set(person.key, result.user);
      usersCreated += result.created;
    }

    const serviceIds = new Map<string, string>();
    let servicesCreated = 0;
    for (const definition of serviceDefinitions) {
      const technician = accounts.get(definition.technician);
      if (!technician) throw new Error(`Missing technician for ${definition.key}`);
      const demoSeedKey = `fixmate-demo-v1:service:${definition.key}`;
      const { key, technician: _technician, ...details } = definition;
      const result = await services.updateOne(
        { demoSeedKey },
        { $setOnInsert: {
          ...details,
          image: definition.image,
          cardSummary: cardSummaries[definition.key],
          technicianId: String(technician._id), technicianName: technician.name, technicianEmail: technician.email,
          approvalStatus: "approvalStatus" in definition ? definition.approvalStatus : "approved",
          isAvailable: true, createdAt: new Date(), demoSeedKey,
        } },
        { upsert: true },
      );
      servicesCreated += result.upsertedCount;
      await services.updateOne(
        { demoSeedKey, image: previousPhotos[definition.category] },
        { $set: { image: definition.image } },
      );
      await services.updateOne(
        { demoSeedKey, title: previousTitles[definition.key] },
        { $set: { title: definition.title } },
      );
      await services.updateOne(
        { demoSeedKey, cardSummary: { $exists: false } },
        { $set: { cardSummary: cardSummaries[definition.key] } },
      );
      const service = await services.findOne({ demoSeedKey });
      if (!service) throw new Error(`Could not load demo service ${definition.key}`);
      serviceIds.set(key, String(service._id));
    }

    const customer = accounts.get("customer");
    if (!customer) throw new Error("Missing demo customer");
    const preferredDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Dhaka", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date(Date.now() + 7 * 86400000));
    let bookingsCreated = 0;
    for (const definition of bookingDefinitions) {
      const serviceId = serviceIds.get(definition.serviceKey);
      if (!serviceId) throw new Error(`Missing service for ${definition.key}`);
      const service = await services.findOne({ _id: new ObjectId(serviceId) });
      if (!service) throw new Error(`Missing service for ${definition.key}`);
      const demoSeedKey = `fixmate-demo-v1:booking:${definition.key}`;
      const result = await bookings.updateOne(
        { demoSeedKey },
        { $setOnInsert: {
          demoSeedKey, customerId: String(customer._id), customerName: customer.name, customerEmail: customer.email,
          phone: "+8801711000103", address: "House 12, Road 4, Mirpur, Dhaka", preferredDate,
          problemDescription: definition.problemDescription,
          serviceId, serviceTitle: service.title, serviceDescription: service.description,
          serviceCategory: service.category, serviceMode: service.serviceMode, serviceArea: service.serviceArea,
          serviceImage: service.image, estimatedDuration: service.estimatedDuration, basePrice: service.basePrice,
          technicianId: service.technicianId, technicianName: service.technicianName, technicianEmail: service.technicianEmail,
          status: definition.status, paymentStatus: "unpaid", finalAmount: service.basePrice, createdAt: new Date(),
        } },
        { upsert: true },
      );
      bookingsCreated += result.upsertedCount;
      await bookings.updateOne(
        { demoSeedKey, serviceImage: previousPhotos[service.category as keyof typeof previousPhotos] },
        { $set: { serviceImage: service.image } },
      );
      await bookings.updateOne(
        { demoSeedKey, serviceTitle: previousTitles[definition.serviceKey] },
        { $set: { serviceTitle: service.title } },
      );
    }

    const publicServices = await services.find({ approvalStatus: "approved", isAvailable: true }).toArray();
    const demoPublicCount = publicServices.filter((service) => typeof service.demoSeedKey === "string" && service.demoSeedKey.startsWith("fixmate-demo-v1:service:")).length;
    console.log(JSON.stringify({ created: { users: usersCreated, services: servicesCreated, bookings: bookingsCreated },
      demo: { technicians: 2, customers: 1, approvedAvailableServices: demoPublicCount, pendingServices: 1, bookings: 4 },
      publicServices: publicServices.length }, null, 2));
  } finally {
    await mongoClient.close();
  }
}

await run();
