import { prisma } from "../config/prisma";
import { Errors } from "../utils/apiError";
import { createNotification } from "./notification.service";

const CALL_HISTORY_PAGE_SIZE = 30;
const ACTIVE_STATUSES = ["RINGING", "ACCEPTED"] as const;

// A call can only happen between two users with a live match — the same
// trust boundary chat.service uses. A caller can't reach someone by posting
// a guessed userId directly; this is re-checked here independent of whatever
// the client believes the match state is.
async function assertActiveMatch(userId: string, otherUserId: string) {
  const [userAId, userBId] = [userId, otherUserId].sort();
  const match = await prisma.match.findUnique({
    where: { userAId_userBId: { userAId, userBId } },
  });
  if (!match || match.status !== "ACTIVE") {
    throw Errors.forbidden("You can only call an active match.");
  }
  return match;
}

// One active call (ringing or in progress) per user at a time. This is what
// produces a real "busy" signal instead of overlapping calls stacking up.
// Exported so the socket layer can look up and terminate a user's in-progress
// call when their last socket disconnects mid-call.
export async function findActiveCallForUser(userId: string) {
  return prisma.call.findFirst({
    where: {
      status: { in: [...ACTIVE_STATUSES] },
      OR: [{ callerId: userId }, { calleeId: userId }],
    },
  });
}

async function assertParticipant(userId: string, call: { callerId: string; calleeId: string }) {
  if (call.callerId !== userId && call.calleeId !== userId) {
    throw Errors.notFound("Call");
  }
}

export async function initiateCall(callerId: string, calleeId: string, type: "VOICE" | "VIDEO") {
  if (callerId === calleeId) throw Errors.validation("You can't call yourself.");

  const match = await assertActiveMatch(callerId, calleeId);

  const callerBusy = await findActiveCallForUser(callerId);
  if (callerBusy) throw Errors.validation("You're already on a call.");

  const calleeBusy = await findActiveCallForUser(calleeId);
  if (calleeBusy) {
    // Record the attempt as BUSY rather than silently refusing — this is
    // what makes the caller's own call history show "no answer" vs "busy"
    // accurately instead of the call simply vanishing.
    return prisma.call.create({
      data: { matchId: match.id, callerId, calleeId, type, status: "BUSY", endedAt: new Date() },
    });
  }

  const call = await prisma.call.create({
    data: { matchId: match.id, callerId, calleeId, type, status: "RINGING" },
  });

  await createNotification(calleeId, "CALL", { callId: call.id, callerId, type });

  return call;
}

export async function acceptCall(userId: string, callId: string) {
  const call = await prisma.call.findUnique({ where: { id: callId } });
  if (!call) throw Errors.notFound("Call");
  await assertParticipant(userId, call);
  if (call.calleeId !== userId) throw Errors.forbidden("Only the callee can accept.");
  if (call.status !== "RINGING") throw Errors.validation("This call is no longer ringing.");

  return prisma.call.update({ where: { id: callId }, data: { status: "ACCEPTED", startedAt: new Date() } });
}

export async function rejectCall(userId: string, callId: string) {
  const call = await prisma.call.findUnique({ where: { id: callId } });
  if (!call) throw Errors.notFound("Call");
  await assertParticipant(userId, call);
  if (call.status !== "RINGING") throw Errors.validation("This call is no longer ringing.");

  return prisma.call.update({
    where: { id: callId },
    data: { status: "REJECTED", endedAt: new Date() },
  });
}

// Covers both a normal hangup after ACCEPTED and the caller cancelling
// before the callee answers (RINGING -> ENDED, distinct from REJECTED so
// call history can tell "they declined" apart from "I hung up first").
export async function endCall(userId: string, callId: string) {
  const call = await prisma.call.findUnique({ where: { id: callId } });
  if (!call) throw Errors.notFound("Call");
  await assertParticipant(userId, call);
  if (call.status !== "RINGING" && call.status !== "ACCEPTED") {
    return call; // already terminal — idempotent, not an error, for a late/duplicate hangup event
  }

  return prisma.call.update({ where: { id: callId }, data: { status: "ENDED", endedAt: new Date() } });
}

// Called by the socket layer's ring timer, never by a client message — a
// client can't mark its own missed call to hide it from the other party's
// history.
export async function markMissedIfStillRinging(callId: string) {
  const result = await prisma.call.updateMany({
    where: { id: callId, status: "RINGING" },
    data: { status: "MISSED", endedAt: new Date() },
  });
  return result.count > 0;
}

// A peer disconnecting mid-handshake (before either side confirms media is
// flowing) is not a graceful hangup or a decline — recorded distinctly so
// call history/observability can tell "someone answered and it worked" apart
// from "it never actually connected".
export async function markFailed(callId: string) {
  await prisma.call.updateMany({
    where: { id: callId, status: { in: [...ACTIVE_STATUSES] } },
    data: { status: "FAILED", endedAt: new Date() },
  });
}

export async function getCall(userId: string, callId: string) {
  const call = await prisma.call.findUnique({ where: { id: callId } });
  if (!call) throw Errors.notFound("Call");
  await assertParticipant(userId, call);
  return call;
}

export async function listCallHistory(userId: string, cursor?: string) {
  const calls = await prisma.call.findMany({
    where: { OR: [{ callerId: userId }, { calleeId: userId }] },
    include: {
      caller: { include: { profile: true } },
      callee: { include: { profile: true } },
    },
    orderBy: { createdAt: "desc" },
    take: CALL_HISTORY_PAGE_SIZE,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const nextCursor = calls.length === CALL_HISTORY_PAGE_SIZE ? calls[calls.length - 1].id : null;

  const items = calls.map((c) => {
    const other = c.callerId === userId ? c.callee : c.caller;
    const durationSeconds =
      c.startedAt && c.endedAt ? Math.round((c.endedAt.getTime() - c.startedAt.getTime()) / 1000) : 0;
    return {
      id: c.id,
      type: c.type,
      status: c.status,
      direction: c.callerId === userId ? "OUTGOING" : "INCOMING",
      otherUser: { id: other.id, name: other.profile?.displayName ?? "Matchify user" },
      durationSeconds,
      createdAt: c.createdAt,
      endedAt: c.endedAt,
    };
  });

  return { calls: items, nextCursor };
}
