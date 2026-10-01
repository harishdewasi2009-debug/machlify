import { z } from "zod";

export const checkoutSchema = z.object({
  plan: z.enum(["PREMIUM", "VIP"]),
});

export const verifyCheckoutSchema = z.object({
  razorpay_order_id: z.string().min(1),
  razorpay_payment_id: z.string().min(1),
  razorpay_signature: z.string().min(1),
});
