import type { RequestHandler } from "express";
import multer from "multer";
import "../lib/mongodb.ts";

const maxImageBytes = 5 * 1024 * 1024;
const imageTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const imgbbApiKey = process.env.IMGBB_API_KEY;

if (!imgbbApiKey) {
  throw new Error("IMGBB_API_KEY must be set.");
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxImageBytes, files: 1, fields: 0 },
  fileFilter: (_request, file, callback) => callback(null, imageTypes.has(file.mimetype)),
}).single("image");

function matchesImageType(file: Express.Multer.File) {
  const bytes = file.buffer;
  if (file.mimetype === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (file.mimetype === "image/png") {
    return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  return bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
}

export const parseImage: RequestHandler = (request, response, next) => {
  upload(request, response, (error) => {
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      response.status(413).json({ message: "Image must be 5 MB or smaller" });
      return;
    }
    if (error) {
      response.status(400).json({ message: "Invalid image upload" });
      return;
    }
    next();
  });
};

export const uploadImage: RequestHandler = async (request, response) => {
  const file = request.file;
  if (!file || !matchesImageType(file)) {
    response.status(400).json({ message: "Upload a JPEG, PNG or WebP image in the image field" });
    return;
  }

  const form = new FormData();
  form.append("image", new Blob([new Uint8Array(file.buffer)], { type: file.mimetype }), file.originalname);

  try {
    const upstream = await fetch(`https://api.imgbb.com/1/upload?key=${encodeURIComponent(imgbbApiKey)}`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(20_000),
    });
    const result: unknown = await upstream.json();
    const imageUrl =
      result && typeof result === "object" && "data" in result &&
      result.data && typeof result.data === "object" && "url" in result.data
        ? result.data.url
        : undefined;

    const succeeded = result && typeof result === "object" && "success" in result && result.success === true;
    if (!upstream.ok || !succeeded || typeof imageUrl !== "string" || !isHttpsImgBbUrl(imageUrl)) {
      response.status(502).json({ message: "Image upload failed" });
      return;
    }

    response.json({ url: imageUrl });
  } catch {
    response.status(502).json({ message: "Image upload failed" });
  }
};

function isHttpsImgBbUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "i.ibb.co" && url.pathname.length > 1;
  } catch {
    return false;
  }
}
