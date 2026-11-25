import { MongoServerError, ObjectId } from "mongodb";
import type Stripe from "stripe";
import { mongoClient, mongoDatabase } from "./mongodb.ts";

export class PaymentVerificationError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

export async function ensurePaymentIndexes() {
  const payments = mongoDatabase.collection("payments");
  await payments.createIndex({ bookingId: 1 }, { name: "unique_payment_booking", unique: true });
  await payments.createIndex({ stripeSessionId: 1 }, { name: "unique_payment_stripe_session", unique: true });
}

/** Call only with a Checkout Session retrieved from Stripe or a signature-verified webhook. */
export async function saveVerifiedPayment(
  checkout: Stripe.Checkout.Session,
  expectedCustomerId?: string,
) {
  const bookingId = checkout.metadata?.bookingId;
  const customerEmail = checkout.metadata?.customerEmail;
  const transactionId = typeof checkout.payment_intent === "string"
    ? checkout.payment_intent
    : checkout.payment_intent?.id;

  if (checkout.mode !== "payment" || checkout.status !== "complete" ||
    checkout.payment_status !== "paid" || checkout.currency !== "usd" ||
    !bookingId || !ObjectId.isValid(bookingId) || !customerEmail ||
    checkout.customer_email !== customerEmail ||
    typeof checkout.amount_total !== "number" || !Number.isSafeInteger(checkout.amount_total) || checkout.amount_total <= 0 ||
    !transactionId) {
    throw new PaymentVerificationError(400, "Invalid or unpaid Checkout Session");
  }

  const bookings = mongoDatabase.collection("bookings");
  const payments = mongoDatabase.collection("payments");
  const mongoSession = mongoClient.startSession();
  try {
    let receipt;
    await mongoSession.withTransaction(async () => {
      const booking = await bookings.findOne(
        { _id: new ObjectId(bookingId), status: "completed" },
        { session: mongoSession },
      );
      if (!booking || (expectedCustomerId && booking.customerId !== expectedCustomerId)) {
        throw new PaymentVerificationError(404, "Completed booking not found");
      }

      const cents = typeof booking.finalAmount === "number" && Number.isFinite(booking.finalAmount)
        ? Math.round(booking.finalAmount * 100)
        : 0;
      if (!Number.isSafeInteger(cents) || cents <= 0 ||
        checkout.amount_total !== cents || customerEmail !== booking.customerEmail) {
        throw new PaymentVerificationError(409, "Checkout details do not match this booking");
      }

      const existing = await payments.findOne({ stripeSessionId: checkout.id }, { session: mongoSession });
      if (existing) {
        if (existing.bookingId !== bookingId || existing.customerId !== booking.customerId ||
          existing.transactionId !== transactionId || existing.amountCents !== cents) {
          throw new PaymentVerificationError(409, "Checkout Session already belongs to another payment");
        }
        receipt = existing;
        return;
      }

      if (booking.paymentStatus !== "unpaid" || booking.checkoutSessionId !== checkout.id ||
        await payments.findOne({ bookingId }, { session: mongoSession })) {
        throw new PaymentVerificationError(409, "Booking has already been paid or Checkout Session has changed");
      }

      const updated = await bookings.updateOne(
        { _id: booking._id, customerId: booking.customerId, status: "completed", paymentStatus: "unpaid", checkoutSessionId: checkout.id },
        { $set: { paymentStatus: "paid" } },
        { session: mongoSession },
      );
      if (!updated.matchedCount) {
        throw new PaymentVerificationError(409, "Booking payment status changed");
      }

      const payment = {
        bookingId,
        customerId: booking.customerId,
        technicianId: booking.technicianId,
        serviceTitle: booking.serviceTitle,
        customerName: booking.customerName,
        customerEmail: booking.customerEmail,
        technicianName: booking.technicianName,
        technicianEmail: booking.technicianEmail,
        amount: booking.finalAmount,
        amountCents: cents,
        currency: "usd",
        transactionId,
        stripeSessionId: checkout.id,
        paymentStatus: "paid",
        paidAt: new Date(),
      };
      const result = await payments.insertOne(payment, { session: mongoSession });
      receipt = { _id: result.insertedId, ...payment };
    });
    if (!receipt) throw new Error("Payment transaction did not return a receipt");
    return receipt;
  } catch (error) {
    if (error instanceof MongoServerError && error.code === 11000) {
      const existing = await payments.findOne({ stripeSessionId: checkout.id, bookingId });
      if (existing && (!expectedCustomerId || existing.customerId === expectedCustomerId)) return existing;
      throw new PaymentVerificationError(409, "Booking has already been paid");
    }
    throw error;
  } finally {
    await mongoSession.endSession();
  }
}
