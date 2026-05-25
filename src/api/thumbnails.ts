import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo } from "../db/videos";
import type { ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { Buffer } from 'node:buffer';
import path from "node:path";
import { getAssetDiskPath, getAssetPath, getAssetURL, mediaTypeToExt } from "./assets";
import { randomBytes } from "node:crypto";


export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("uploading thumbnail for video", videoId, "by user", userID);

  // TODO: implement the upload here
  const db = cfg.db;
  const video = getVideo(db, videoId);
  if (!video) {
    throw new NotFoundError("Video not found")
  }
  if (video.userID !== userID) {
    throw new UserForbiddenError("Forbidden: cant access this video")
  }

  const formData = await req.formData();
  const file = formData.get("thumbnail");
  if (!(file instanceof File)) {
    throw new BadRequestError("Thumbnail file missing");
  }

  const MAX_UPLOAD_SIZE = 10 << 20;
  if (file.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("Thumbnail file size is too big");
  }

  const mediaType = file.type;
  if (!mediaType) {
    throw new BadRequestError("Missing Content-Type for thumbnail");
  }
  if (mediaType !== "image/jpeg" && mediaType !== "image/png") {
    throw new BadRequestError("Invalide Content-Type for thumbnail. Only JPEG or PNG allowed.");
  }

  const fileExt = mediaTypeToExt(mediaType);
  if (!fileExt) {
    throw new BadRequestError("Invalid fileExt for thumbnail");
  }

  const fileData = await file.arrayBuffer();
  if (!fileData) {
    throw new Error("Error reading file data");
  }

  // const rndBase64Name = randomBytes(32).toString("base64");
  // const fileName = `${rndBase64Name}${fileExt}`
  const fileName = getAssetPath(mediaType);

  const filePath = getAssetDiskPath(cfg, fileName);
  await Bun.write(filePath, fileData);

  const fileURL = getAssetURL(cfg, fileName);
  video.thumbnailURL = fileURL;
  updateVideo(db, video);

  return respondWithJSON(200, video);
}
