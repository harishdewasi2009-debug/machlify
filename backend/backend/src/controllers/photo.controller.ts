import { Request, Response } from "express";
import { Errors } from "../utils/apiError";
import { reorderPhotosSchema } from "../validators/photo.validator";
import * as photoService from "../services/photo.service";

export async function upload(req: Request, res: Response) {
  if (!req.userId) throw Errors.unauthorized();
  if (!req.file) throw Errors.validation("No file uploaded. Send it as multipart/form-data field 'file'.");

  const photo = await photoService.uploadPhoto(req.userId, {
    buffer: req.file.buffer,
    size: req.file.size,
  });

  res.status(201).json({ success: true, data: { photo } });
}

export async function list(req: Request, res: Response) {
  if (!req.userId) throw Errors.unauthorized();
  const photos = await photoService.listOwnPhotos(req.userId);
  res.json({ success: true, data: { photos } });
}

export async function reorder(req: Request, res: Response) {
  if (!req.userId) throw Errors.unauthorized();
  const { order } = reorderPhotosSchema.parse(req.body);
  await photoService.reorderPhotos(req.userId, order);
  res.json({ success: true, data: { reordered: true } });
}

export async function setPrimary(req: Request, res: Response) {
  if (!req.userId) throw Errors.unauthorized();
  await photoService.setPrimaryPhoto(req.userId, req.params.id);
  res.json({ success: true, data: { primary: true } });
}

export async function remove(req: Request, res: Response) {
  if (!req.userId) throw Errors.unauthorized();
  await photoService.deletePhoto(req.userId, req.params.id);
  res.json({ success: true, data: { deleted: true } });
}
