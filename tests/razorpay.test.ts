import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { verifyRazorpaySignature, verifyRazorpayWebhookSignature } from "../src/lib/payments/razorpay";

afterEach(() => { delete process.env.RAZORPAY_KEY_ID; delete process.env.RAZORPAY_KEY_SECRET; });

describe("Razorpay signature verification", () => {
  it("accepts valid checkout signature", () => {
    const orderId = "order_test123";
    const paymentId = "pay_test123";
    const secret = "test-secret";
    const signature = createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");
    expect(verifyRazorpaySignature(orderId, paymentId, signature, secret)).toBe(true);
  });

  it("rejects altered checkout signature", () => {
    expect(verifyRazorpaySignature("order_test123", "pay_test123", "00", "test-secret")).toBe(false);
  });

  it("accepts valid raw-body webhook signature", () => {
    const body = '{"event":"payment.captured"}';
    const secret = "webhook-secret";
    const signature = createHmac("sha256", secret).update(body).digest("hex");
    expect(verifyRazorpayWebhookSignature(body, signature, secret)).toBe(true);
  });

  it("rejects altered webhook body", () => {
    const secret = "webhook-secret";
    const signature = createHmac("sha256", secret).update("original").digest("hex");
    expect(verifyRazorpayWebhookSignature("altered", signature, secret)).toBe(false);
  });
});
