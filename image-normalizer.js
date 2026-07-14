import sharp from "sharp";

const MAX_INPUT_PIXELS = 64_000_000;
const PRIMARY_MAX_DIMENSION = 6000;
const FALLBACK_MAX_DIMENSION = 4096;
const PRIMARY_JPEG_QUALITY = 92;
const FALLBACK_JPEG_QUALITY = 85;
const MPF_SIGNATURE = Buffer.from("MPF\0", "ascii");

class ImageNormalizationError extends Error {
  constructor(message, status = 400, options) {
    super(message, options);
    this.name = "ImageNormalizationError";
    this.status = status;
  }
}

function detectImageMime(bytes) {
  if (!Buffer.isBuffer(bytes)) return null;
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

function sanitizeJpegContainer(bytes) {
  if (detectImageMime(bytes) !== "image/jpeg") {
    throw new ImageNormalizationError("图片不是有效的 JPEG 文件。");
  }

  const chunks = [bytes.subarray(0, 2)];
  let copyStart = 2;
  let cursor = 2;
  let foundMpf = false;

  while (cursor < bytes.length) {
    const marker = readMarker(bytes, cursor);
    cursor = marker.next;

    if (marker.code === 0xd9) {
      chunks.push(bytes.subarray(copyStart, cursor));
      return {
        bytes: Buffer.concat(chunks),
        wasMpo: foundMpf,
        hadTrailingData: cursor < bytes.length,
      };
    }

    if (marker.code === 0xda) {
      const segmentEnd = readSegmentEnd(bytes, cursor);
      const imageEnd = findJpegEnd(bytes, segmentEnd);
      chunks.push(bytes.subarray(copyStart, imageEnd));
      return {
        bytes: Buffer.concat(chunks),
        wasMpo: foundMpf,
        hadTrailingData: imageEnd < bytes.length,
      };
    }

    if (isStandaloneMarker(marker.code)) continue;

    const segmentEnd = readSegmentEnd(bytes, cursor);
    const isMpf = marker.code === 0xe2
      && cursor + 6 <= segmentEnd
      && bytes.subarray(cursor + 2, cursor + 6).equals(MPF_SIGNATURE);

    if (isMpf) {
      chunks.push(bytes.subarray(copyStart, marker.start));
      copyStart = segmentEnd;
      foundMpf = true;
    }
    cursor = segmentEnd;
  }

  throw new ImageNormalizationError("JPEG 图片不完整，找不到结束标记。");
}

function readMarker(bytes, offset) {
  if (offset >= bytes.length || bytes[offset] !== 0xff) {
    throw new ImageNormalizationError("JPEG 标记结构损坏。");
  }
  const start = offset;
  while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
  if (offset >= bytes.length || bytes[offset] === 0x00) {
    throw new ImageNormalizationError("JPEG 标记结构损坏。");
  }
  return { start, code: bytes[offset], next: offset + 1 };
}

function readSegmentEnd(bytes, lengthOffset) {
  if (lengthOffset + 2 > bytes.length) {
    throw new ImageNormalizationError("JPEG 数据段不完整。");
  }
  const length = bytes.readUInt16BE(lengthOffset);
  if (length < 2 || lengthOffset + length > bytes.length) {
    throw new ImageNormalizationError("JPEG 数据段长度无效。");
  }
  return lengthOffset + length;
}

function findJpegEnd(bytes, scanOffset) {
  let cursor = scanOffset;
  let inEntropyData = true;

  while (cursor < bytes.length) {
    if (inEntropyData) {
      while (cursor < bytes.length && bytes[cursor] !== 0xff) cursor += 1;
      if (cursor >= bytes.length) break;

      const marker = readEntropyMarker(bytes, cursor);
      cursor = marker.next;
      if (marker.code === 0x00 || marker.code >= 0xd0 && marker.code <= 0xd7) continue;
      if (marker.code === 0xd9) return cursor;
      if (marker.code === 0xda) {
        cursor = readSegmentEnd(bytes, cursor);
        continue;
      }
      if (isStandaloneMarker(marker.code)) continue;

      cursor = readSegmentEnd(bytes, cursor);
      inEntropyData = false;
      continue;
    }

    const marker = readMarker(bytes, cursor);
    cursor = marker.next;
    if (marker.code === 0xd9) return cursor;
    if (marker.code === 0xda) {
      cursor = readSegmentEnd(bytes, cursor);
      inEntropyData = true;
      continue;
    }
    if (isStandaloneMarker(marker.code)) continue;
    cursor = readSegmentEnd(bytes, cursor);
  }

  throw new ImageNormalizationError("JPEG 图片不完整，找不到结束标记。");
}

function readEntropyMarker(bytes, offset) {
  const start = offset;
  offset += 1;
  while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
  if (offset >= bytes.length) {
    throw new ImageNormalizationError("JPEG 扫描数据不完整。");
  }
  return { start, code: bytes[offset], next: offset + 1 };
}

function isStandaloneMarker(code) {
  return code === 0x01 || code === 0xd8 || code >= 0xd0 && code <= 0xd9;
}

async function normalizeUploadedImage(bytes, { maxOutputBytes }) {
  const sourceMime = detectImageMime(bytes);
  if (!sourceMime) {
    throw new ImageNormalizationError("只支持真实的 JPG、PNG 或 WEBP 图片。");
  }

  let source = bytes;
  let wasMpo = false;
  let hadTrailingData = false;
  if (sourceMime === "image/jpeg") {
    const sanitized = sanitizeJpegContainer(bytes);
    source = sanitized.bytes;
    wasMpo = sanitized.wasMpo;
    hadTrailingData = sanitized.hadTrailingData;
  }

  let metadata;
  try {
    metadata = await sharp(source, sharpOptions()).metadata();
  } catch (error) {
    throw normalizeSharpError(error);
  }

  const hasAlpha = Boolean(metadata.hasAlpha);
  const attempts = hasAlpha
    ? [
        { maxDimension: PRIMARY_MAX_DIMENSION, format: "png" },
        { maxDimension: FALLBACK_MAX_DIMENSION, format: "png" },
      ]
    : [
        { maxDimension: PRIMARY_MAX_DIMENSION, format: "jpeg", quality: PRIMARY_JPEG_QUALITY },
        { maxDimension: PRIMARY_MAX_DIMENSION, format: "jpeg", quality: FALLBACK_JPEG_QUALITY },
        { maxDimension: FALLBACK_MAX_DIMENSION, format: "jpeg", quality: FALLBACK_JPEG_QUALITY },
      ];

  let lastResult;
  try {
    for (const attempt of attempts) {
      lastResult = await encodeStandardImage(source, attempt);
      if (lastResult.data.length <= maxOutputBytes) break;
    }
  } catch (error) {
    throw normalizeSharpError(error);
  }

  if (!lastResult || lastResult.data.length > maxOutputBytes) {
    throw new ImageNormalizationError("图片转换后仍然过大，请缩小图片后重试。", 413);
  }

  return {
    bytes: lastResult.data,
    mime: lastResult.info.format === "png" ? "image/png" : "image/jpeg",
    width: lastResult.info.width,
    height: lastResult.info.height,
    sourceMime,
    wasMpo,
    hadTrailingData,
  };
}

function sharpOptions() {
  return {
    animated: false,
    failOn: "error",
    limitInputPixels: MAX_INPUT_PIXELS,
    sequentialRead: true,
  };
}

async function encodeStandardImage(source, { maxDimension, format, quality }) {
  let pipeline = sharp(source, sharpOptions())
    .rotate()
    .resize({
      width: maxDimension,
      height: maxDimension,
      fit: "inside",
      withoutEnlargement: true,
    })
    .toColourspace("srgb");

  pipeline = format === "png"
    ? pipeline.png({ compressionLevel: 9, adaptiveFiltering: true })
    : pipeline.jpeg({ quality, chromaSubsampling: "4:4:4" });

  return pipeline.toBuffer({ resolveWithObject: true });
}

function normalizeSharpError(error) {
  if (error instanceof ImageNormalizationError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/pixel limit|Input image exceeds pixel limit/i.test(message)) {
    return new ImageNormalizationError("图片像素尺寸过大，请缩小后重试。", 413, { cause: error });
  }
  return new ImageNormalizationError("图片无法读取，请重新导出为 JPG、PNG 或 WEBP 后重试。", 400, { cause: error });
}

export {
  ImageNormalizationError,
  detectImageMime,
  normalizeUploadedImage,
  sanitizeJpegContainer,
};
