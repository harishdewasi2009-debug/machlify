import { z } from "zod";

export const adminLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const suspendUserSchema = z.object({
  reason: z.string().min(3, "A reason is required.").max(500),
});

export const rejectSchema = z.object({
  reason: z.string().max(500).optional(),
});

export const reportStatusSchema = z.object({
  status: z.enum(["OPEN", "INVESTIGATING", "RESOLVED", "DISMISSED"]),
});

export const photoStatusQuerySchema = z.object({
  status: z.enum(["PENDING", "APPROVED", "REJECTED", "MANUAL_REVIEW"]).optional(),
  cursor: z.string().optional(),
});

export const verificationStatusQuerySchema = z.object({
  status: z.enum(["UNVERIFIED", "PENDING", "PROCESSING", "MANUAL_REVIEW", "VERIFIED", "REJECTED"]).optional(),
  cursor: z.string().optional(),
});

export const reportStatusQuerySchema = z.object({
  status: z.enum(["OPEN", "INVESTIGATING", "RESOLVED", "DISMISSED"]).optional(),
  cursor: z.string().optional(),
});

export const userListQuerySchema = z.object({
  query: z.string().optional(),
  status: z.enum(["ACTIVE", "SUSPENDED", "DELETED", "PENDING_DELETION"]).optional(),
  verificationStatus: z
    .enum(["UNVERIFIED", "PENDING", "PROCESSING", "MANUAL_REVIEW", "VERIFIED", "REJECTED"])
    .optional(),
  cursor: z.string().optional(),
});

export const paymentStatusQuerySchema = z.object({
  status: z.enum(["CREATED", "PAID", "FAILED", "REFUNDED"]).optional(),
  cursor: z.string().optional(),
});

export const subscriptionStatusQuerySchema = z.object({
  status: z.enum(["ACTIVE", "CANCELLED", "ENDED", "REFUNDED"]).optional(),
  cursor: z.string().optional(),
});
