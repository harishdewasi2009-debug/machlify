import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { prisma } from "../config/prisma";
import { env, faceVerificationConfigured } from "../config/env";
import { ApiError } from "../utils/apiError";
import * as rekognition from "../integrations/rekognition.provider";
import { Errors } from "../utils/apiError";
import * as stripeIdentity from "../integrations/stripeIdentity.provider";
import { recomputeDiscoverability } from "./profile.service";
import { processUploadedImage } from "./image.service";
import { moderateImage } from "./moderation.service";
import { buildVerificationSelfieKey, getObjectBuffer, putObject } from "./storage.service";

const ACTIVE_SESSION_STATUSES = ["PENDING", "PROCESSING"] as const;

export async function startVerification(userId: string) {
  const existingActive = await prisma.verificationSession.findFirst({
    where: { userId, status: { in: [...ACTIVE_SESSION_STATUSES] } },
    orderBy: { createdAt: "desc" },
  });
  // Re-issuing a new provider session while one is already in flight would
  // orphan the first one server-side and could let a user open multiple
  // concurrent verification attempts; just hand back the existing one.
  if (existingActive) {
    return { sessionId: existingActive.id, status: existingActive.status, reused: true };
  }

  const returnUrl = `${env.APP_ORIGIN}/verification/return`;
  const providerSession = await stripeIdentity.createVerificationSession(userId, returnUrl);

  const session = await prisma.verificationSession.create({
    data: {
      userId,
      provider: "stripe_identity",
      providerSessionId: providerSession.id,
      status: "PENDING",
    },
  });

  await prisma.user.update({ where: { id: userId }, data: { verificationStatus: "PENDING" } });

  return {
    sessionId: session.id,
    status: session.status,
    verificationUrl: providerSession.url ?? null,
    clientSecret: providerSession.client_secret ?? null,
    reused: false,
  };
}

// Lower-cost alternative to Stripe Identity: the user uploads a selfie
// directly, a human moderator reviews it via the existing admin
// verification queue (GET /api/admin/verifications, which now also signs a
// URL to view the selfie — see adminModeration.service.ts), and only an
// admin action moves it to VERIFIED or REJECTED. This never auto-approves —
// the backend remains the sole source of truth for verification status,
// same as the Stripe path above.
export async function submitSelfieVerification(userId: string, file: { buffer: Buffer; size: number }) {
  const existingActive = await prisma.verificationSession.findFirst({
    where: { userId, status: { in: [...ACTIVE_SESSION_STATUSES, "MANUAL_REVIEW"] } },
    orderBy: { createdAt: "desc" },
  });
  if (existingActive) {
    return { sessionId: existingActive.id, status: existingActive.status, reused: true };
  }

  // Reuses the same real content-type sniffing / dimension checks / EXIF
  // stripping / re-encoding as regular profile photo uploads — a selfie is
  // still just an image upload as far as that pipeline is concerned.
  const processed = await processUploadedImage(file.buffer);

  // Same automated moderation regular photos get, run before any human ever
  // sees it — catches obviously-wrong uploads (nudity, gore, spam) without
  // burning moderator time, but never auto-approves a real verification on
  // its own: passing this only gets you into MANUAL_REVIEW below, not VERIFIED.
  const moderation = await moderateImage(processed.large.buffer);
  if (moderation.status === "REJECTED") {
    throw Errors.validation("That photo didn't pass our content check. Please upload a clear, appropriate selfie.");
  }

  const session = await prisma.verificationSession.create({
    data: { userId, provider: "selfie_manual_review", status: "MANUAL_REVIEW" },
  });

  const key = buildVerificationSelfieKey(userId, session.id);
  await putObject(key, processed.large.buffer, "image/jpeg");

  await prisma.verificationSession.update({
    where: { id: session.id },
    data: { providerSessionId: key },
  });
  await prisma.user.update({ where: { id: userId }, data: { verificationStatus: "MANUAL_REVIEW" } });
  await prisma.verificationEvent.create({
    data: {
      verificationSessionId: session.id,
      status: "MANUAL_REVIEW",
      rawPayloadHash: crypto.createHash("sha256").update(processed.contentHash).digest("hex"),
    },
  });

  return { sessionId: session.id, status: "MANUAL_REVIEW" as const, reused: false };
}

// ---------------------------------------------------------------------------
// Real face verification (AWS Rekognition)
//
// 1. GET  /api/verification/challenge  -> a random liveness step ("smile" or
//    "turn your head") inside a short-lived signed token.
// 2. POST /api/verification/face       -> two live camera frames: a neutral one
//    and one performing the step. The server checks, with Rekognition, that
//    each frame has exactly one clear face, that the step really happened,
//    that both frames are the same person, and that the person matches their
//    own approved profile photo. Only a strong match becomes VERIFIED; a
//    borderline match goes to a human moderator; a clear mismatch is rejected.
// The frontend can never set VERIFIED - only this server-side check can.
// ---------------------------------------------------------------------------
export type FaceChallengeType = "smile" | "turn";

const CHALLENGE_TTL_SECONDS = 300;
const MAX_FACE_ATTEMPTS_PER_HOUR = 5;
const SAME_PERSON_MIN_SIMILARITY = 80; // neutral frame vs challenge frame (head turn lowers similarity)
const challengeSecret = () => `${env.JWT_ACCESS_SECRET}:face-challenge`;

export function issueFaceChallenge(userId: string) {
  const type: FaceChallengeType = crypto.randomInt(2) === 0 ? "smile" : "turn";
  const token = jwt.sign({ sub: userId, type }, challengeSecret(), {
    audience: "face-challenge",
    expiresIn: CHALLENGE_TTL_SECONDS,
  });
  return {
    token,
    type,
    automatic: faceVerificationConfigured,
    instruction: type === "smile" ? "Smile with your teeth showing" : "Slowly turn your head to one side",
  };
}

function readChallenge(token: string, userId: string): FaceChallengeType {
  try {
    const payload = jwt.verify(token, challengeSecret(), { audience: "face-challenge" }) as { sub?: string; type?: string };
    if (payload.sub !== userId || (payload.type !== "smile" && payload.type !== "turn")) throw new Error("bad");
    return payload.type;
  } catch {
    throw Errors.validation("This verification step expired. Please start again.");
  }
}

type Faces = Awaited<ReturnType<typeof rekognition.detectFaces>>;

// Returns a user-facing problem, or null if the frame is a clear, front-facing face.
function checkNeutralFrame(faces: Faces): string | null {
  if (faces.length === 0) return "We couldn't see your face. Face the camera in good light.";
  if (faces.length > 1) return "Only you should be in the frame.";
  const f = faces[0];
  if ((f.Confidence ?? 0) < 90) return "We couldn't see your face clearly. Try better lighting.";
  if (f.Sunglasses?.Value && (f.Sunglasses.Confidence ?? 0) > 70) return "Please take off your sunglasses.";
  if (f.FaceOccluded?.Value && (f.FaceOccluded.Confidence ?? 0) > 70) return "Something is covering your face. Please remove it.";
  if (f.EyesOpen && f.EyesOpen.Value === false && (f.EyesOpen.Confidence ?? 0) > 70) return "Keep your eyes open and look at the camera.";
  if (Math.abs(f.Pose?.Yaw ?? 0) > 25 || Math.abs(f.Pose?.Pitch ?? 0) > 25) return "Look straight at the camera for the first photo.";
  if ((f.Quality?.Sharpness ?? 100) < 30) return "The photo is blurry. Hold still and try again.";
  const brightness = f.Quality?.Brightness ?? 50;
  if (brightness < 20 || brightness > 97) return "The lighting is too dark or too bright. Try again.";
  return null;
}

function checkChallengeFrame(type: FaceChallengeType, neutral: Faces, challenge: Faces): string | null {
  if (challenge.length !== 1) return challenge.length === 0 ? "We couldn't see your face in the second photo." : "Only you should be in the frame.";
  const n = neutral[0];
  const c = challenge[0];
  if ((c.Confidence ?? 0) < 85) return "We couldn't see your face clearly in the second photo.";
  if (type === "smile") {
    const smiling = c.Smile?.Value === true && (c.Smile.Confidence ?? 0) >= 80;
    const neutralSmiling = n.Smile?.Value === true && (n.Smile.Confidence ?? 0) >= 70;
    if (!smiling) return "We didn't detect a smile in the second photo. Please smile and try again.";
    if (neutralSmiling) return "Keep a neutral face in the first photo, then smile in the second.";
    return null;
  }
  const yawC = c.Pose?.Yaw ?? 0;
  const yawN = n.Pose?.Yaw ?? 0;
  if (Math.abs(yawC) < 20 || Math.abs(yawC - yawN) < 15) return "We didn't detect a head turn in the second photo. Turn your head to the side and try again.";
  return null;
}

export async function submitFaceVerification(
  userId: string,
  input: { neutral: Buffer; challenge: Buffer; challengeToken: string }
) {
  const type = readChallenge(input.challengeToken, userId);

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { verificationStatus: true } });
  if (!user) throw Errors.notFound("User");
  if (user.verificationStatus === "VERIFIED") return { status: "VERIFIED" as const, reused: true, automatic: true };

  // No face-matching provider configured: keep the human-review path (never auto-approves).
  if (!faceVerificationConfigured) {
    const r = await submitSelfieVerification(userId, { buffer: input.neutral, size: input.neutral.length });
    return { ...r, automatic: false };
  }

  const inFlight = await prisma.verificationSession.findFirst({
    where: { userId, status: { in: [...ACTIVE_SESSION_STATUSES, "MANUAL_REVIEW"] } },
    orderBy: { createdAt: "desc" },
  });
  if (inFlight) return { sessionId: inFlight.id, status: inFlight.status, reused: true, automatic: true };

  const recentAttempts = await prisma.verificationSession.count({
    where: { userId, provider: "face_rekognition", createdAt: { gte: new Date(Date.now() - 3600_000) } },
  });
  if (recentAttempts >= MAX_FACE_ATTEMPTS_PER_HOUR) {
    throw new ApiError(429, "TOO_MANY_ATTEMPTS", "Too many verification attempts. Please try again in an hour.");
  }

  const references = await prisma.photo.findMany({
    where: { userId, status: "APPROVED" },
    orderBy: [{ isPrimary: "desc" }, { position: "asc" }],
    take: 3,
    select: { largeKey: true, storageKey: true },
  });
  if (references.length === 0) {
    throw Errors.validation("Add a profile photo of yourself first - we compare your live selfie with it.");
  }

  const neutral = await processUploadedImage(input.neutral);
  const challenge = await processUploadedImage(input.challenge);
  if (neutral.contentHash === challenge.contentHash) {
    throw Errors.validation("Please take two different photos: one neutral and one following the instruction.");
  }
  const moderation = await moderateImage(neutral.large.buffer);
  if (moderation.status === "REJECTED") {
    throw Errors.validation("That photo didn't pass our content check. Please take a clear, appropriate selfie.");
  }

  const record = async (status: "VERIFIED" | "REJECTED" | "MANUAL_REVIEW", userStatus: "VERIFIED" | "REJECTED" | "MANUAL_REVIEW" | null, similarity: number, keepSelfie: boolean) => {
    const session = await prisma.verificationSession.create({ data: { userId, provider: "face_rekognition", status } });
    if (keepSelfie) {
      const key = buildVerificationSelfieKey(userId, session.id);
      await putObject(key, neutral.large.buffer, "image/jpeg");
      await prisma.verificationSession.update({ where: { id: session.id }, data: { providerSessionId: key } });
    }
    await prisma.verificationEvent.create({
      data: {
        verificationSessionId: session.id,
        status,
        rawPayloadHash: crypto.createHash("sha256").update(`${neutral.contentHash}:${similarity.toFixed(1)}`).digest("hex"),
      },
    });
    if (userStatus) await prisma.user.update({ where: { id: userId }, data: { verificationStatus: userStatus } });
    if (userStatus === "VERIFIED") await recomputeDiscoverability(userId);
    return session.id;
  };

  const [neutralFaces, challengeFaces] = await Promise.all([
    rekognition.detectFaces(neutral.large.buffer),
    rekognition.detectFaces(challenge.large.buffer),
  ]);
  const problem = checkNeutralFrame(neutralFaces) ?? checkChallengeFrame(type, neutralFaces, challengeFaces);
  if (problem) {
    await record("REJECTED", null, 0, false);
    return { status: "RETRY" as const, message: problem, automatic: true };
  }

  const samePerson = await rekognition.compareFaces(neutral.large.buffer, challenge.large.buffer, SAME_PERSON_MIN_SIMILARITY);
  if (samePerson < SAME_PERSON_MIN_SIMILARITY) {
    await record("REJECTED", null, samePerson, false);
    return { status: "RETRY" as const, message: "Both photos need to show the same person. Please try again.", automatic: true };
  }

  let best = 0;
  for (const ref of references) {
    const bytes = await getObjectBuffer(ref.largeKey ?? ref.storageKey);
    best = Math.max(best, await rekognition.compareFaces(neutral.large.buffer, bytes, 50));
  }

  if (best >= env.FACE_MATCH_THRESHOLD) {
    const sessionId = await record("VERIFIED", "VERIFIED", best, false);
    return { sessionId, status: "VERIFIED" as const, reused: false, automatic: true };
  }
  if (best >= env.FACE_REVIEW_THRESHOLD) {
    const sessionId = await record("MANUAL_REVIEW", "MANUAL_REVIEW", best, true);
    return { sessionId, status: "MANUAL_REVIEW" as const, reused: false, automatic: true };
  }
  const sessionId = await record("REJECTED", "REJECTED", best, false);
  return {
    sessionId,
    status: "REJECTED" as const,
    reused: false,
    automatic: true,
    message: "Your selfie didn't match your profile photos. Use a clear photo of your own face as your main photo, then try again.",
  };
}

export async function getStatus(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { verificationStatus: true } });
  if (!user) throw Errors.notFound("User");

  const latestSession = await prisma.verificationSession.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });

  return {
    status: user.verificationStatus,
    session: latestSession
      ? { id: latestSession.id, status: latestSession.status, createdAt: latestSession.createdAt }
      : null,
  };
}

interface StripeWebhookEvent {
  id: string;
  type: string;
  data: { object: { id: string } };
}

// Only these event types move our state machine; anything else (Stripe
// sends many identity.* and unrelated event types to a shared endpoint) is
// intentionally ignored rather than erroring, since Stripe treats a non-2xx
// response as "please retry" and will keep hammering an endpoint that 4xxs
// on events it was never going to act on.
const STATUS_BY_EVENT_TYPE: Record<string, "PROCESSING" | "VERIFIED" | "REJECTED" | "MANUAL_REVIEW"> = {
  "identity.verification_session.processing": "PROCESSING",
  "identity.verification_session.verified": "VERIFIED",
  // requires_input can mean either an outright failure or "needs a human/
  // resubmission" — routing it to manual review rather than an immediate
  // REJECTED avoids auto-rejecting someone over e.g. a blurry photo.
  "identity.verification_session.requires_input": "MANUAL_REVIEW",
  "identity.verification_session.canceled": "REJECTED",
};

export async function handleWebhookEvent(event: StripeWebhookEvent): Promise<void> {
  const mappedStatus = STATUS_BY_EVENT_TYPE[event.type];
  if (!mappedStatus) return;

  const providerSessionId = event.data.object.id;
  const session = await prisma.verificationSession.findFirst({ where: { providerSessionId } });
  // An event for a session this backend never created (different mode/key,
  // stale test data) — ignore rather than error, same reasoning as above.
  if (!session) return;

  // Per the schema's own comment, only a hash of the event is retained
  // (never the raw payload, which can include verification detail we don't
  // need to keep), keyed on Stripe's own event id so redelivery of the same
  // event — normal Stripe behavior on retry, or a duplicate endpoint — is a
  // no-op instead of double-processing.
  const eventHash = crypto.createHash("sha256").update(event.id).digest("hex");

  const applied = await prisma.$transaction(async (tx) => {
    const duplicate = await tx.verificationEvent.findFirst({
      where: { verificationSessionId: session.id, rawPayloadHash: eventHash },
    });
    if (duplicate) return false;

    await tx.verificationEvent.create({
      data: { verificationSessionId: session.id, status: mappedStatus, rawPayloadHash: eventHash },
    });
    await tx.verificationSession.update({ where: { id: session.id }, data: { status: mappedStatus } });
    await tx.user.update({ where: { id: session.userId }, data: { verificationStatus: mappedStatus } });
    return true;
  });

  if (applied) {
    await recomputeDiscoverability(session.userId);
  }
}
