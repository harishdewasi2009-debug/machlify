// Email. SMTP_URL (e.g. smtps://user:pass@smtp.resend.com:465) enables real
// delivery. Without it, emails are logged and kept in `outbox` (dev / tests).
const nodemailer = require('nodemailer');
const logger = require('./logger');
const { BRAND_NAME } = require('../config');

const outbox = [];
let transport = null;
function getTransport() {
  if (transport) return transport;
  if (process.env.SMTP_URL) transport = nodemailer.createTransport(process.env.SMTP_URL);
  return transport;
}

async function sendMail({ to, subject, text, html }) {
  const from = process.env.EMAIL_FROM || `${BRAND_NAME} <no-reply@matchify.invalid>`;
  const msg = { from, to, subject, text, html: html || undefined };
  const t = getTransport();
  if (!t) {
    outbox.push({ ...msg, at: new Date() });
    if (outbox.length > 200) outbox.shift();
    if (process.env.NODE_ENV !== 'test') logger.info({ to, subject }, 'email (not sent — SMTP_URL unset)');
    return { delivered: false };
  }
  await t.sendMail(msg);
  return { delivered: true };
}
module.exports = { sendMail, outbox };
