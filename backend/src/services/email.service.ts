import nodemailer from "nodemailer";
import { env, emailConfigured } from "../config/env";
import { Errors } from "../utils/apiError";

const transporter = emailConfigured
  ? nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD },
    })
  : null;

interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
}

// Never pretend an email was sent when no provider is configured — the
// caller must surface a real "email not configured" state, not a fake
// "check your inbox" success message.
export async function sendEmail({ to, subject, html }: SendEmailInput): Promise<void> {
  if (!transporter) {
    throw Errors.configurationMissing("Email delivery");
  }
  await transporter.sendMail({ from: env.EMAIL_FROM, to, subject, html });
}

export async function sendVerificationEmail(to: string, rawToken: string, appOrigin: string): Promise<void> {
  const link = `${appOrigin}/verify-email?token=${rawToken}`;
  await sendEmail({
    to,
    subject: "Verify your Matchify email",
    html: `<p>Confirm your email address to activate your Matchify account.</p><p><a href="${link}">Verify email</a></p><p>This link expires in 24 hours.</p>`,
  });
}

export async function sendPasswordResetEmail(to: string, rawToken: string, appOrigin: string): Promise<void> {
  const link = `${appOrigin}/reset-password?token=${rawToken}`;
  await sendEmail({
    to,
    subject: "Reset your Matchify password",
    html: `<p>We received a request to reset your password.</p><p><a href="${link}">Reset password</a></p><p>If you didn't request this, you can ignore this email. This link expires in 1 hour.</p>`,
  });
}

export async function sendAccountDeletionEmail(
  to: string,
  rawToken: string,
  appOrigin: string,
  scheduledDeletionAt: Date
): Promise<void> {
  const link = `${appOrigin}/restore-account?token=${rawToken}`;
  const when = scheduledDeletionAt.toDateString();
  await sendEmail({
    to,
    subject: "Your Matchify account is scheduled for deletion",
    html: `<p>We've received a request to delete your Matchify account. You've been logged out of every device.</p><p>Your account and data will be permanently deleted on <strong>${when}</strong>. If this wasn't you, or you've changed your mind, you can cancel this before then:</p><p><a href="${link}">Cancel account deletion</a></p><p>If you don't recognize this request, use the link above to keep your account — no further action is needed otherwise.</p>`,
  });
}
