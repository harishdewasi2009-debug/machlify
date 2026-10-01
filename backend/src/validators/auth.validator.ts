import { z } from "zod";

export const registerSchema = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().email().toLowerCase(),
  password: z.string().min(10).max(128),
  dateOfBirth: z.coerce.date(),
  gender: z.string().min(1).max(40),
});

export const loginSchema = z.object({
  email: z.string().trim().email().toLowerCase(),
  password: z.string().min(1),
});

export const googleLoginSchema = z.object({
  idToken: z.string().min(1),
});

// Google doesn't give us a date of birth or gender, so a brand-new Google
// sign-up must supply them here (age is still calculated server-side).
export const googleRegisterSchema = z.object({
  idToken: z.string().min(1),
  name: z.string().trim().min(1).max(80),
  dateOfBirth: z.coerce.date(),
  gender: z.string().min(1).max(40),
});

export const requestPasswordResetSchema = z.object({
  email: z.string().trim().email().toLowerCase(),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(10).max(128),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(10).max(128),
});

export const verifyEmailSchema = z.object({
  token: z.string().min(1),
});

// password is required for password-auth accounts (checked in the service,
// since whether it's required depends on the user's provider, not the shape
// of the request body) and ignored for Google-only accounts.
export const deleteAccountSchema = z.object({
  password: z.string().min(1).optional(),
});

export const restoreAccountSchema = z.object({
  token: z.string().min(1),
});
