import { env, moderationConfigured } from "../config/env";
import { Errors } from "../utils/apiError";

export type ModerationStatus = "APPROVED" | "REJECTED" | "MANUAL_REVIEW";

export interface ModerationResult {
  status: ModerationStatus;
  scores: Record<string, number>;
}

interface SightengineResponse {
  nudity?: { sexual_activity?: number; sexual_display?: number; erotica?: number };
  offensive?: { prob?: number };
  gore?: { prob?: number };
  error?: { message?: string };
}

// Sightengine (https://sightengine.com) is used here as a concrete, real
// moderation provider — swap this file for another vendor's SDK without
// touching photo.service.ts, since callers only depend on ModerationResult.
export async function moderateImage(imageBuffer: Buffer): Promise<ModerationResult> {
  if (!moderationConfigured) {
    // Never default to APPROVED when moderation isn't configured — that
    // would let real, un-moderated photos reach discovery.
    throw Errors.configurationMissing("Photo moderation");
  }

  const form = new FormData();
  form.append("media", new Blob([imageBuffer]), "photo.jpg");
  form.append("models", "nudity-2.1,offensive,gore");
  form.append("api_user", env.MODERATION_API_USER);
  form.append("api_secret", env.MODERATION_API_SECRET);

  const response = await fetch("https://api.sightengine.com/1.0/check.json", {
    method: "POST",
    body: form,
  });

  if (!response.ok) {
    throw new Error(`Moderation provider returned HTTP ${response.status}`);
  }

  const data = (await response.json()) as SightengineResponse;

  if (data.error) {
    throw new Error(`Moderation provider error: ${data.error.message ?? "unknown"}`);
  }

  const scores: Record<string, number> = {
    sexualActivity: data.nudity?.sexual_activity ?? 0,
    sexualDisplay: data.nudity?.sexual_display ?? 0,
    erotica: data.nudity?.erotica ?? 0,
    offensive: data.offensive?.prob ?? 0,
    gore: data.gore?.prob ?? 0,
  };

  const worstScore = Math.max(...Object.values(scores));

  let status: ModerationStatus = "APPROVED";
  if (worstScore >= env.MODERATION_REJECT_THRESHOLD) {
    status = "REJECTED";
  } else if (worstScore >= env.MODERATION_REVIEW_THRESHOLD) {
    // Uncertain cases go to a human, per policy — never auto-ban on one
    // borderline automated score.
    status = "MANUAL_REVIEW";
  }

  return { status, scores };
}
