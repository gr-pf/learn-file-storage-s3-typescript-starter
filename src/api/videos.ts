import { respondWithJSON } from "./json";

import { type ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo, type Video } from "../db/videos";
import path from "path";
import { uploadVideoToS3 } from "../s3";
import { rm } from "fs/promises";

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const MAX_UPLOAD_SIZE = 1 << 30;

  // Extract the videoId from the URL path parameters
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  // Authenticate the user to get a userID
  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("uploading thumbnail for video", videoId, "by user", userID);

  // Get the video metadata from the database
  const db = cfg.db;
  const video = getVideo(db, videoId);
  if (!video) {
    throw new NotFoundError("Video not found")
  }
  if (video.userID !== userID) {
    throw new UserForbiddenError("Forbidden: cant access this video")
  }

  const formData = await req.formData();
  const file = formData.get("video");
  if (!(file instanceof File)) {
    throw new BadRequestError("Video file missing");
  }

  if (file.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("Video file size is too big");
  }

  // Validate the uploaded file to ensure it's an MP4 video
  const mediaType = file.type;
  if (mediaType !== "video/mp4") {
    throw new BadRequestError("Invalide Content-Type for video. Only MP4 allowed.");
  }


  const tempFilePath = path.join("/tmp", `${videoId}.mp4`);
  await Bun.write(tempFilePath, file);
  const aspectRatio = await getVideoAspectRatio(tempFilePath);
  const processVideoPath = await processVideoForFastStart(tempFilePath);

  let key = `${aspectRatio}/${videoId}.mp4`;
  await uploadVideoToS3(cfg, key, processVideoPath, "video/mp4");

  const fileURL = `https://${cfg.s3CfDistribution}.cloudfront.net/${key}`;

  video.videoURL = fileURL;
  updateVideo(db, video);

  await Promise.all([rm(tempFilePath, { force: true }), rm(processVideoPath, { force: true })]);


  return respondWithJSON(200, video);
}


async function getVideoAspectRatio(filePath: string): Promise<string> {
  const proc = Bun.spawn(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", filePath], {
    stdout: "pipe",
    stderr: "pipe"
  })
  const stdoutText = await new Response(proc.stdout).text();
  const stderrText = await new Response(proc.stderr).text();
  await proc.exited;

  const exitCode = proc.exitCode;


  if (exitCode !== 0) {
    throw new Error(`ffprobe error: ${stderrText}`);
  }

  const data = await JSON.parse(stdoutText);
  if (!data.streams || data.streams.length === 0) {
    throw new Error("No video streams found");
  }

  const width = data["streams"][0].width;
  const height = data["streams"][0]["height"];
  let ratio: string = "other";
  if (((15.9 * height) <= (9 * width)) && ((9 * width) <= (16.1 * height))) {
    ratio = "landscape";
  } else if (((15.9 * width) <= (9 * height)) && ((9 * height) <= (16.1 * width))) {
    ratio = "portrait";
  }
  return ratio;
};

async function processVideoForFastStart(inputFilePath: string): Promise<string> {
  const outputFilePath = `${inputFilePath}.processed`;

  const proc = Bun.spawn(["ffmpeg", "-i", inputFilePath, "-movflags", "faststart", "-map_metadata", "0", "-codec", "copy", "-f", "mp4", outputFilePath], {
    stderr: "pipe"
  })
  const stderrText = await new Response(proc.stderr).text();
  await proc.exited;

  const exitCode = proc.exitCode;


  if (exitCode !== 0) {
    throw new Error(`ffprobe error: ${stderrText}`);
  }

  return outputFilePath;
}

