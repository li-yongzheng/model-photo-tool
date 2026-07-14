import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { symlink, unlink } from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import { describe, it } from "node:test";
import sharp from "sharp";

import {
  decodeBase64Image,
  detectImageMime,
  isSupportedDataImage,
  isSameOriginRequest,
  normalizeGarmentAnalysis,
  parseJsonObject,
  requestHandler,
  safePublicPath,
  updateEnvContent,
  validateDataImage,
} from "../server.js";

describe("environment key updates", () => {
  it("preserves the other API key and unrelated formatting", () => {
    const lines = [
      "# local keys",
      "SILICONFLOW_API_KEY=old-analysis",
      "",
      "ARK_API_KEY=keep-image",
      "HOST=127.0.0.1",
      "",
    ];

    const result = updateEnvContent(lines, new Map([["SILICONFLOW_API_KEY", "new-analysis"]]));

    assert.equal(result, [
      "# local keys",
      "SILICONFLOW_API_KEY=new-analysis",
      "",
      "ARK_API_KEY=keep-image",
      "HOST=127.0.0.1",
      "",
    ].join("\n"));
  });

  it("adds a missing key once and removes duplicate replaced entries", () => {
    const result = updateEnvContent(
      ["ARK_API_KEY=old", "ARK_API_KEY=duplicate"],
      new Map([["ARK_API_KEY", "new"], ["SILICONFLOW_API_KEY", "analysis"]]),
    );
    assert.equal(result, "ARK_API_KEY=new\nSILICONFLOW_API_KEY=analysis\n");
  });
});

describe("image validation", () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xdb]);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const webp = Buffer.from("RIFF0000WEBP", "ascii");

  it("detects supported formats by content rather than filename", () => {
    assert.equal(detectImageMime(jpeg), "image/jpeg");
    assert.equal(detectImageMime(png), "image/png");
    assert.equal(detectImageMime(webp), "image/webp");
    assert.equal(detectImageMime(Buffer.from("not an image")), null);
  });

  it("rejects malformed and oversized base64", () => {
    assert.deepEqual(decodeBase64Image(png.toString("base64"), 100), png);
    assert.throws(() => decodeBase64Image("%%%", 100), /编码无效/);
    assert.throws(() => decodeBase64Image(png.toString("base64"), 2), /过大/);
  });

  it("accepts only supported base64 data image URLs", () => {
    assert.equal(isSupportedDataImage(`data:image/png;base64,${png.toString("base64")}`), true);
    assert.equal(isSupportedDataImage("https://example.com/image.png"), false);
    assert.equal(isSupportedDataImage("data:image/svg+xml;base64,AAAA"), false);
    assert.equal(validateDataImage(`data:image/png;base64,${png.toString("base64")}`, 100).mime, "image/png");
    assert.throws(
      () => validateDataImage(`data:image/jpeg;base64,${png.toString("base64")}`, 100),
      /不匹配/,
    );
  });

  it("allows direct and same-origin requests but rejects other origins", () => {
    assert.equal(isSameOriginRequest({ headers: { host: "127.0.0.1:5178" } }), true);
    assert.equal(isSameOriginRequest({ headers: { host: "127.0.0.1:5178", origin: "http://127.0.0.1:5178" } }), true);
    assert.equal(isSameOriginRequest({ headers: { host: "127.0.0.1:5178", origin: "https://evil.example" } }), false);
  });
});

describe("analysis parsing", () => {
  it("parses fenced JSON and normalizes missing fields", () => {
    const parsed = parseJsonObject('```json\n{"color":" black ","detailsToPreserve":[" collar ",3]}\n```');
    const normalized = normalizeGarmentAnalysis(parsed);
    assert.equal(normalized.color, "black");
    assert.deepEqual(normalized.detailsToPreserve, ["collar"]);
    assert.equal(normalized.collar, "未明显可见");
  });

  it("does not let traversal escape the public path", () => {
    assert.equal(safePublicPath("/../../server.js"), "server.js");
    assert.equal(safePublicPath("/assets/app.js"), "assets/app.js");
  });
});

describe("HTTP server", () => {
  it("serves the app with safe content headers", async () => {
    const response = await runRequest("GET", "/");
    assert.equal(response.status, 200);
    assert.match(response.headers["Content-Type"], /^text\/html/);
    assert.equal(response.headers["X-Content-Type-Options"], "nosniff");
    assert.match(response.body, /模特图生成工具/);
  });

  it("returns a JSON 404 without exposing project files", async () => {
    const response = await runRequest("GET", "/../../server.js");
    assert.equal(response.status, 404);
    assert.deepEqual(JSON.parse(response.body), { error: "没有找到这个文件。" });
  });

  it("does not follow public symlinks outside the public directory", async () => {
    const link = new URL("../public/.test-secret-link", import.meta.url);
    try {
      await symlink(new URL("../server.js", import.meta.url), link);
      const response = await runRequest("GET", "/.test-secret-link");
      assert.equal(response.status, 404);
    } finally {
      await unlink(link).catch(() => {});
    }
  });

  it("rejects unsupported methods", async () => {
    const response = await runRequest("PUT", "/api/status");
    assert.equal(response.status, 405);
  });

  it("rejects cross-origin POST requests", async () => {
    const response = await runRequest("POST", "/api/feedback", {
      origin: "https://attacker.example",
      "content-type": "application/json",
    });
    assert.equal(response.status, 403);
  });

  it("requires JSON content types and integer feedback scores", async () => {
    const wrongType = await runRequest("POST", "/api/feedback", {}, '{"score":5}');
    assert.equal(wrongType.status, 415);

    const decimal = await runRequest(
      "POST",
      "/api/feedback",
      { "content-type": "application/json" },
      '{"score":1.5}',
    );
    assert.equal(decimal.status, 400);
  });

  it("rejects declared oversized JSON before reading it", async () => {
    const response = await runRequest(
      "POST",
      "/api/feedback",
      { "content-type": "application/json", "content-length": "20000" },
      "{}",
    );
    assert.equal(response.status, 413);
  });

  it("runs the complete upload, analysis, generation, and save flow", async () => {
    const previousAnalysisKey = process.env.SILICONFLOW_API_KEY;
    const previousImageKey = process.env.ARK_API_KEY;
    const previousFetch = globalThis.fetch;
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const inputPng = await sharp({
      create: { width: 24, height: 16, channels: 3, background: { r: 230, g: 220, b: 210 } },
    }).png().toBuffer();
    const suppliedMpo = new URL("../test.jpeg", import.meta.url);
    const uploadBytes = existsSync(suppliedMpo) ? readFileSync(suppliedMpo) : inputPng;
    let fetchCalls = 0;
    let savedFile;

    process.env.SILICONFLOW_API_KEY = "test-analysis-key";
    process.env.ARK_API_KEY = "test-image-key";
    globalThis.fetch = async (url, options) => {
      fetchCalls += 1;
      if (String(url).includes("chat/completions")) {
        const request = JSON.parse(options.body);
        assert.equal(request.messages[0].content[0].type, "image_url");
        const normalizedDataUrl = request.messages[0].content[0].image_url.url;
        assert.match(normalizedDataUrl, /^data:image\/jpeg;base64,/);
        assert.equal(
          Buffer.from(normalizedDataUrl.split(",", 2)[1], "base64").includes(Buffer.from("MPF\0")),
          false,
        );
        return Response.json({
          choices: [{
            message: {
              content: JSON.stringify({
                productName: " Test coat ",
                productParagraph: "A test coat",
                color: "black",
                detailsToPreserve: ["collar"],
              }),
            },
          }],
        });
      }
      const request = JSON.parse(options.body);
      assert.match(request.prompt, /A test coat/);
      assert.match(request.image, /^data:image\/jpeg;base64,/);
      return Response.json({ data: [{ b64_json: png.toString("base64") }] });
    };

    try {
      const form = new FormData();
      form.append("garment", new Blob([uploadBytes], { type: "image/jpeg" }), "coat.jpeg");
      form.append("pose", "quiet-luxury");
      form.append("notes", "keep the collar");
      const encoded = await encodeFormData(form);
      const response = await runRequest("POST", "/api/generate", encoded.headers, encoded.body);

      assert.equal(response.status, 200);
      const payload = JSON.parse(response.body);
      assert.equal(fetchCalls, 2);
      assert.equal(payload.analysis.productName, "Test coat");
      assert.match(payload.image, /^data:image\/png;base64,/);
      assert.match(payload.savedFile, /^agent_outputs\/model_photo_.+\.png$/);
      savedFile = new URL(`../${payload.savedFile}`, import.meta.url);
      assert.deepEqual(readFileSync(savedFile), png);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousAnalysisKey === undefined) delete process.env.SILICONFLOW_API_KEY;
      else process.env.SILICONFLOW_API_KEY = previousAnalysisKey;
      if (previousImageKey === undefined) delete process.env.ARK_API_KEY;
      else process.env.ARK_API_KEY = previousImageKey;
      if (savedFile) await unlink(savedFile).catch(() => {});
    }
  });
});

class MockResponse extends Writable {
  constructor() {
    super();
    this.status = 200;
    this.headers = {};
    this.chunks = [];
  }

  writeHead(status, headers) {
    this.status = status;
    this.headers = headers || {};
    return this;
  }

  _write(chunk, encoding, callback) {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }

  get body() {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

async function runRequest(method, url, headers = {}, body = "") {
  const req = Readable.from(body ? [body] : []);
  req.method = method;
  req.url = url;
  req.headers = { host: "localhost", ...headers };
  const res = new MockResponse();
  const finished = once(res, "finish");
  await requestHandler(req, res);
  await finished;
  return res;
}

async function encodeFormData(form) {
  const request = new Request("http://localhost/", { method: "POST", body: form });
  return {
    headers: { "content-type": request.headers.get("content-type") },
    body: Buffer.from(await request.arrayBuffer()),
  };
}
