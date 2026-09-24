// SMS for phone OTP. SMS_PROVIDER=twilio enables real delivery via Twilio's
// Messages REST API. In India, transactional SMS additionally needs TRAI DLT
// registration (sender ID + template) with your SMS provider.
const logger = require('./logger');
const outbox = [];

async function sendSms(to, body) {
  const provider = (process.env.SMS_PROVIDER || '').toLowerCase();
  if (provider === 'twilio') {
    const sid = process.env.TWILIO_ACCOUNT_SID, token = process.env.TWILIO_AUTH_TOKEN, from = process.env.TWILIO_FROM;
    if (!sid || !token || !from) throw new Error('Twilio SMS is not fully configured (TWILIO_ACCOUNT_SID/AUTH_TOKEN/FROM).');
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: to, From: from, Body: body }),
    });
    if (!res.ok) throw new Error('SMS provider error ' + res.status);
    return { delivered: true };
  }
  outbox.push({ to, body, at: new Date() });
  if (outbox.length > 200) outbox.shift();
  if (process.env.NODE_ENV !== 'test') logger.info({ to }, 'sms (not sent — SMS_PROVIDER unset)');
  return { delivered: false };
}
module.exports = { sendSms, outbox };
