import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import sharp from "sharp";

import {
  detectImageMime,
  normalizeUploadedImage,
  sanitizeJpegContainer,
} from "../image-normalizer.js";

const MAX_OUTPUT_BYTES = 12 * 1024 * 1024;
const realMpoPath = new URL("../test.jpeg", import.meta.url);

describe("MPO and image normalization", () => {
  it("removes MPF metadata and trailing images from an MPO container", async () => {
    const primary = await createJpeg(32, 24, { r: 240, g: 240, b: 240 });
    const secondary = await createJpeg(16, 12, { r: 20, g: 20, b: 20 });
    const mpo = makeSyntheticMpo(primary, secondary);

    const sanitized = sanitizeJpegContainer(mpo);

    assert.equal(sanitized.wasMpo, true);
    assert.equal(sanitized.hadTrailingData, true);
    assert.equal(sanitized.bytes.includes(Buffer.from("MPF\0")), false);
    assert.deepEqual(sanitized.bytes, primary);
  });

  it("normalizes a synthetic MPO into one standard sRGB JPEG", async () => {
    const primary = await createJpeg(32, 24, { r: 220, g: 200, b: 180 });
    const secondary = await createJpeg(16, 12, { r: 10, g: 20, b: 30 });
    const result = await normalizeUploadedImage(makeSyntheticMpo(primary, secondary), {
      maxOutputBytes: MAX_OUTPUT_BYTES,
    });
    const metadata = await sharp(result.bytes).metadata();

    assert.equal(result.wasMpo, true);
    assert.equal(result.hadTrailingData, true);
    assert.equal(result.mime, "image/jpeg");
    assert.equal(result.bytes.includes(Buffer.from("MPF\0")), false);
    assert.equal(metadata.format, "jpeg");
    assert.equal(metadata.space, "srgb");
    assert.equal(metadata.pages, undefined);
  });

  it("preserves transparency as a static PNG", async () => {
    const input = await sharp({
      create: { width: 20, height: 10, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } },
    }).webp().toBuffer();
    const result = await normalizeUploadedImage(input, { maxOutputBytes: MAX_OUTPUT_BYTES });
    const metadata = await sharp(result.bytes).metadata();

    assert.equal(result.sourceMime, "image/webp");
    assert.equal(result.mime, "image/png");
    assert.equal(metadata.hasAlpha, true);
  });

  it("rejects damaged images even when their file signature looks supported", async () => {
    const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(detectImageMime(fakePng), "image/png");
    await assert.rejects(
      normalizeUploadedImage(fakePng, { maxOutputBytes: MAX_OUTPUT_BYTES }),
      error => error.status === 400 && /无法读取/.test(error.message),
    );
  });

  it("normalizes the supplied real MPO with orientation and size limits", { skip: !existsSync(realMpoPath) }, async () => {
    const input = readFileSync(realMpoPath);
    const sanitized = sanitizeJpegContainer(input);
    const result = await normalizeUploadedImage(input, { maxOutputBytes: MAX_OUTPUT_BYTES });
    const metadata = await sharp(result.bytes).metadata();

    assert.equal(input.length, 11_711_699);
    assert.equal(sanitized.wasMpo, true);
    assert.equal(sanitized.hadTrailingData, true);
    assert.equal(sanitized.bytes.includes(Buffer.from("MPF\0")), false);
    assert.equal(result.mime, "image/jpeg");
    assert.equal(result.width, 4000);
    assert.equal(result.height, 6000);
    assert.ok(result.bytes.length <= MAX_OUTPUT_BYTES);
    assert.equal(metadata.orientation, undefined);
    assert.equal(metadata.space, "srgb");
  });
});

async function createJpeg(width, height, background) {
  return sharp({ create: { width, height, channels: 3, background } })
    .jpeg({ quality: 90 })
    .toBuffer();
}

function makeSyntheticMpo(primary, secondary) {
  const payload = Buffer.concat([Buffer.from("MPF\0", "ascii"), Buffer.from("synthetic-index", "ascii")]);
  const app2 = Buffer.alloc(payload.length + 4);
  app2[0] = 0xff;
  app2[1] = 0xe2;
  app2.writeUInt16BE(payload.length + 2, 2);
  payload.copy(app2, 4);
  return Buffer.concat([primary.subarray(0, 2), app2, primary.subarray(2), secondary]);
}
