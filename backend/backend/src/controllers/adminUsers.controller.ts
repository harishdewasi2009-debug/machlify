import { Request, Response } from "express";
import { Errors } from "../utils/apiError";
import { userListQuerySchema, suspendUserSchema } from "../validators/admin.validator";
import * as adminUsersService from "../services/adminUsers.service";

export async function list(req: Request, res: Response) {
  const query = userListQuerySchema.parse(req.query);
  const result = await adminUsersService.listUsers(query);
  res.json({ success: true, data: result });
}

export async function detail(req: Request, res: Response) {
  const result = await adminUsersService.getUserDetail(req.params.id);
  res.json({ success: true, data: result });
}

export async function suspend(req: Request, res: Response) {
  if (!req.adminUserId) throw Errors.adminUnauthorized();
  const { reason } = suspendUserSchema.parse(req.body);
  await adminUsersService.suspendUser(req.adminUserId, req.params.id, reason);
  res.json({ success: true, data: null });
}

export async function restore(req: Request, res: Response) {
  if (!req.adminUserId) throw Errors.adminUnauthorized();
  await adminUsersService.restoreUser(req.adminUserId, req.params.id);
  res.json({ success: true, data: null });
}
