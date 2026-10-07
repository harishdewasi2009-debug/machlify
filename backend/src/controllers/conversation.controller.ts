import { Request, Response } from "express";
import { Errors } from "../utils/apiError";
import { listMessagesQuerySchema, sendMessageSchema } from "../validators/chat.validator";
import * as chatService from "../services/chat.service";
import { emitToConversation } from "../websocket/socket";

export async function list(req: Request, res: Response) {
  if (!req.userId) throw Errors.unauthorized();
  const conversations = await chatService.listConversations(req.userId);
  res.json({ success: true, data: { conversations } });
}

export async function getMessages(req: Request, res: Response) {
  if (!req.userId) throw Errors.unauthorized();
  const { cursor } = listMessagesQuerySchema.parse(req.query);
  const result = await chatService.getMessages(req.userId, req.params.id, cursor);
  res.json({ success: true, data: result });
}

// REST fallback for clients that aren't holding a socket connection open
// (e.g. a push-notification tap that opens straight to a conversation). It
// goes through the exact same chatService.sendMessage the socket handler
// uses, then broadcasts the result to anyone who *is* connected, so the two
// paths can never produce diverging behavior.
export async function sendMessage(req: Request, res: Response) {
  if (!req.userId) throw Errors.unauthorized();
  const { content, type } = sendMessageSchema.parse(req.body);
  const message = await chatService.sendMessage(req.userId, req.params.id, content, type);
  emitToConversation(message.conversationId, "message:new", message);
  res.status(201).json({ success: true, data: { message } });
}

export async function sendMedia(req: Request, res: Response) {
  if (!req.userId) throw Errors.unauthorized();
  if (!req.file) throw Errors.validation("No file was uploaded.");
  const message = await chatService.sendMediaMessage(req.userId, req.params.id, req.file);
  emitToConversation(message.conversationId, "message:new", message);
  res.status(201).json({ success: true, data: { message } });
}

export async function markRead(req: Request, res: Response) {
  if (!req.userId) throw Errors.unauthorized();
  await chatService.markConversationRead(req.userId, req.params.id);
  emitToConversation(req.params.id, "message:read", { conversationId: req.params.id, readByUserId: req.userId });
  res.json({ success: true, data: { read: true } });
}
