import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createRazorpayOrder, verifyRazorpaySignature, verifyRazorpayWebhookSignature } from "../src/lib/payments/razorpay";

afterEach(() => {
  delete process.env.RAZORPAY_KEY_ID;
  delete process.env.RAZORPAY_KEY_SECRET;
  delete process.env.RAZORPAY_KEY;
  delete process.env.RAZORPAY_SECRET;
});

describe("Razorpay order validation", () => {
  it("rejects amounts below Razorpay minimum before making a network request", async () => {
    process.env.RAZORPAY_KEY_ID = "rzp_test_key";
    process.env.RAZORPAY_KEY_SECRET = "test-secret";
    await expect(createRazorpayOrder({
      amountPaise: 99,
      receipt: "receipt_test123",
      notes: {},
    })).rejects.toThrow("INVALID_PAYMENT_AMOUNT");
  });
});

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

describe("Razorpay configuration and malformed input", () => {
  it("rejects order creation when credentials are missing", async () => {
    delete process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_SECRET;
    delete process.env.RAZORPAY_KEY;
    delete process.env.RAZORPAY_SECRET;

    await expect(createRazorpayOrder({
      amountPaise: 10000,
      receipt: "receipt_test_missing_config",
      notes: {},
    })).rejects.toThrow("RAZORPAY_NOT_CONFIGURED");
  });

  it("rejects non-integer and unsafe payment amounts", async () => {
    process.env.RAZORPAY_KEY_ID = "rzp_test_key";
    process.env.RAZORPAY_KEY_SECRET = "test-secret";

    await expect(createRazorpayOrder({
      amountPaise: 100.5,
      receipt: "receipt_test_fractional",
      notes: {},
    })).rejects.toThrow("INVALID_PAYMENT_AMOUNT");

    await expect(createRazorpayOrder({
      amountPaise: Number.MAX_SAFE_INTEGER + 1,
      receipt: "receipt_test_unsafe",
      notes: {},
    })).rejects.toThrow("INVALID_PAYMENT_AMOUNT");
  });

  it("rejects missing webhook signature or secret", () => {
    expect(verifyRazorpayWebhookSignature('{"event":"payment.captured"}', "", "secret")).toBe(false);
    expect(verifyRazorpayWebhookSignature('{"event":"payment.captured"}', "signature", "")).toBe(false);
  });

  it("rejects malformed checkout signatures", () => {
    expect(verifyRazorpaySignature("order_test123", "pay_test123", "not-hex", "test-secret")).toBe(false);
  });
});
