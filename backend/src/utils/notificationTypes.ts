// Central list so the preferences endpoint, its validator, and push.service
// all agree on what a "type" is — a typo in one place can't silently create
// a type nobody can ever disable (or that push.service doesn't recognize).
export const NOTIFICATION_TYPES = ["MATCH", "LIKE", "MESSAGE", "CALL", "SUBSCRIPTION", "SECURITY", "SYSTEM"] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

// Security notifications (e.g. a password change, a login from a new
// device) are never suppressed by user preference — silencing them would
// turn a safety feature into a false sense of security for an attacker who
// has already changed the victim's settings.
export const ALWAYS_ON_TYPES: readonly NotificationType[] = ["SECURITY"];

export function isKnownNotificationType(type: string): type is NotificationType {
  return (NOTIFICATION_TYPES as readonly string[]).includes(type);
}
