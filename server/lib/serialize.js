const { parseJson, userAge, distanceBand, distanceLabel } = require('./util');
const { planOf } = require('./entitlements');
const { PLAN_ENTITLEMENTS } = require('../config');

// What a user may see about THEMSELVES.
function serializeSelf(u, extra = {}) {
  const plan = planOf(u);
  return {
    id: u.id,
    email: u.email,
    emailVerified: !!u.email_verified_at,
    phone: u.phone ? u.phone.replace(/.(?=.{3})/g, '•') : null,
    phoneVerified: !!u.phone_verified_at,
    name: u.name,
    dob: u.dob ? new Date(u.dob).toISOString().slice(0, 10) : null,
    needsDob: !u.dob,
    age: userAge(u),
    gender: u.gender,
    interestedIn: u.interested_in,
    prefGenders: u.pref_genders || [],
    prefAgeMin: u.pref_age_min, prefAgeMax: u.pref_age_max, prefDistanceKm: u.pref_distance_km,
    bio: u.bio || '', job: u.job || '', location: u.location || '', country: u.country || '',
    hasLocation: u.lat != null && u.lng != null,
    interests: parseJson(u.interests, []),
    photos: parseJson(u.photos, []),
    prompts: extra.prompts || [],
    photoItems: extra.photoItems || undefined,
    relationshipIntent: u.relationship_intent, heightCm: u.height_cm, language: u.language,
    privacy: { showDistance: !!u.show_distance, showOnline: !!u.show_online, readReceipts: !!u.read_receipts,
               incognito: !!u.incognito, discoverable: !!u.discoverable },
    notificationPrefs: u.notification_prefs || {},
    verified: !!u.photo_verified,                     // blue "photo verified" badge
    verificationStatus: u.verification_status || 'unverified',  // 18+ ID gate
    over18: !!u.over_18,
    plan, premium: plan !== 'free',
    planExpiresAt: u.plan_expires_at, billingCycle: u.billing_cycle || null, autopay: !!u.autopay,
    boostCredits: u.boost_credits || 0,
    entitlements: PLAN_ENTITLEMENTS[plan],
    role: u.role, status: u.status,
    profileStrength: u.profile_strength || 0,
    authProvider: u.auth_provider || 'local',
    isDemo: !!u.is_demo,
    randomRulesAccepted: !!u.random_rules_accepted_at,
  };
}

// What OTHER users may see. Never email/phone/coords/risk/role/dob.
function serializePublicProfile(u, opts = {}) {
  const online = !!(u.show_online && u.is_online);
  const out = {
    id: u.id,
    name: u.name,
    age: userAge(u),
    gender: u.gender,
    bio: u.bio || '',
    job: u.job || '',
    location: u.location || '',
    country: u.country || '',
    interests: parseJson(u.interests, []),
    photos: parseJson(u.photos, []),
    prompts: opts.prompts || [],
    relationshipIntent: u.relationship_intent,
    heightCm: u.height_cm,
    verified: !!u.photo_verified,
    isDemo: !!u.is_demo,
    online,
    lastActive: u.show_online ? activeBand(u.last_active_at) : null,
  };
  if (u.show_distance && opts.distanceKm != null) {
    out.distanceKm = distanceBand(opts.distanceKm);
    out.distanceLabel = distanceLabel(opts.distanceKm);
  }
  if (opts.compat != null) out.compat = opts.compat;
  if (opts.likedYou) out.likedYou = true;
  if (opts.boosted) out.boosted = true;
  return out;
}

function activeBand(ts) {
  if (!ts) return null;
  const mins = (Date.now() - new Date(ts).getTime()) / 60000;
  if (mins < 15) return 'Active now';
  if (mins < 60 * 24) return 'Active today';
  if (mins < 60 * 24 * 7) return 'Active this week';
  return null;
}

module.exports = { serializeSelf, serializePublicProfile, activeBand };
