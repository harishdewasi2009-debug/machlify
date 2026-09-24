// Text moderation: cheap rules first. An AI classifier (optional) is only used
// on already-flagged / borderline content (see services in routes/ai.js).
//
// Returns { action: 'allow'|'flag'|'block', reasons: [ids], support: bool, highRisk: bool }.

const RULES = [
  // ---- block (never delivered) ----
  { id: 'minor_claim', sev: 'block', re: /\b(?:i\s*am|i'?m|im)\s*(?:1[0-7]|[1-9])\s*(?:years?|yrs?|yo|y\/o)\b|\b(?:i\s*am|i'?m|im)\s*(?:1[0-7]|[1-9])\s+old\b|\bage\s*[:\-]?\s*(?:1[0-7]|[1-9])\b(?!\d)|\bunder\s*-?\s*age\b|\bi(?:'m| am) (?:still )?in (?:school|grade\s*\d+|class\s*\d+)\b|\bclass\s*(?:[1-9]|1[0-2])\s*student\b/i },
  { id: 'sexual_solicitation', sev: 'block', re: /\b(?:escort|call\s*girls?|nudes?|sex\s*chat|paid\s*(?:meet|meetup|sex)|sugar\s*(?:daddy|mommy|mama)|hook\s*up\s+for\s+money|naked\s+(?:pics?|photos?|video)|send\s+(?:me\s+)?(?:pics?|photos?)\s+naked)\b/i },
  { id: 'threat', sev: 'block', re: /\b(?:i(?:'ll|\s*will)\s+(?:kill|hurt|find|rape|stab|burn)\s+you|kill\s+you|rape\s+you|acid\s+attack)\b/i },
  // ---- flag (delivered with a warning to the recipient + risk signal) ----
  { id: 'offplatform', sev: 'flag', re: /\b(?:whats\s*app|whatsapp|telegram|signal\s+app|snap\s*chat|snapchat|insta(?:gram)?\s*(?:id|handle)?|wechat|kik|hike|imo)\b/i },
  { id: 'money_request', sev: 'flag', re: /\b(?:send\s+(?:me\s+)?money|need\s+(?:some\s+)?money|(?:gift|amazon|google\s*play|itunes)\s*cards?|western\s*union|money\s*gram|wire\s*transfer|recharge\s+(?:my|me)|emergency\s+funds?|pay\s+my\s+(?:bill|fees|rent)|loan\s+(?:me|urgently))\b/i },
  { id: 'crypto_invest', sev: 'flag', re: /\b(?:bitcoin|btc|usdt|crypto(?:currency)?|forex|trading\s+(?:platform|app|signals?)|investment\s+(?:plan|opportunity|scheme)|guaranteed\s+returns?|double\s+your\s+money)\b/i },
  { id: 'sensitive_credentials', sev: 'flag', re: /\b(?:otp|cvv|card\s+number|bank\s+account|account\s+number|ifsc|upi\s*pin|net\s*banking|password)\b/i },
  { id: 'upi_id', sev: 'flag', re: /\b[a-z0-9._-]{2,}@(?:ok(?:axis|hdfcbank|icici|sbi)|ybl|paytm|upi|axl|ibl|apl|sbi|icici|hdfcbank|axisbank|okaxis)\b/i },
  { id: 'phone_number', sev: 'flag', re: /(?:\+?\d[\d\s().-]{8,}\d)/, test: (t) => t.replace(/\D/g, '').length >= 10 },
  { id: 'link', sev: 'flag', re: /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|in|net|org|io|me|xyz|co|link|top|club|live|ly)\b(?:\/\S*)?/i },
  { id: 'abuse', sev: 'flag', re: /\b(?:bitch|bastard|slut|whore|madarchod|bhenchod|behenchod|chutiya|randi|harami|gandu)\b/i },
  // ---- support (delivered; sender is shown support info) ----
  { id: 'self_harm', sev: 'support', re: /\b(?:kill\s+myself|suicide|end\s+my\s+life|want\s+to\s+die|self[-\s]?harm|hurt\s+myself)\b/i },
];

function moderateText(text) {
  const t = String(text || '');
  const reasons = [];
  let action = 'allow', support = false;
  for (const r of RULES) {
    const hit = r.test ? (r.re.test(t) && r.test(t)) : r.re.test(t);
    if (!hit) continue;
    reasons.push(r.id);
    if (r.sev === 'block') action = 'block';
    else if (r.sev === 'flag' && action !== 'block') action = 'flag';
    else if (r.sev === 'support') support = true;
  }
  const highRisk = reasons.includes('money_request') || reasons.includes('sensitive_credentials') ||
    (reasons.includes('offplatform') && (reasons.includes('link') || reasons.includes('phone_number')));
  return { action, reasons, support, highRisk };
}

const WARNINGS = {
  offplatform: 'This person suggested moving to another app. Take your time — keep chatting here until you trust them.',
  money_request: 'Never send money, gift cards or crypto to someone you have not met. This looks like a possible scam.',
  crypto_invest: 'Investment or crypto offers from matches are a very common scam. Do not share money or account details.',
  sensitive_credentials: 'Never share OTPs, card numbers, passwords or bank details with anyone.',
  upi_id: 'Be careful with payment requests. Do not pay people you have not met.',
  phone_number: 'A phone number was shared. Only share personal contact details when you feel safe.',
  link: 'This message contains a link. Do not open links or install apps from people you do not know.',
  abuse: 'This message may be abusive. You can block or report this person.',
};
const warningFor = (reasons) => {
  for (const k of ['money_request', 'crypto_invest', 'sensitive_credentials', 'upi_id', 'offplatform', 'abuse', 'phone_number', 'link']) {
    if (reasons.includes(k)) return WARNINGS[k];
  }
  return null;
};

const SUPPORT_TEXT = 'If you are struggling, you are not alone. In India you can call Tele-MANAS at 14416 (free, 24×7) or 112 in an emergency. Please also reach out to someone you trust.';

module.exports = { moderateText, warningFor, SUPPORT_TEXT, RULES };
