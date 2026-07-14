import { createReadStream, readFileSync } from "node:fs";
import { chmod, mkdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectImageMime, normalizeUploadedImage } from "./image-normalizer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadLocalEnv();

const configuredPort = Number(process.env.PORT || 5178);
const PORT = Number.isInteger(configuredPort) && configuredPort >= 1 && configuredPort <= 65535
  ? configuredPort
  : 5178;
const HOST = process.env.HOST || "127.0.0.1";
const DEFAULT_IMAGE_MODEL = "doubao-seedream-4-5-251128";
const DEFAULT_VISION_MODEL = "Qwen/Qwen3-VL-32B-Instruct";
const SILICONFLOW_BASE = "https://api.siliconflow.cn/v1";
const ARK_BASE = "https://ark.cn-beijing.volces.com/api/v3/images/generations";
// Keep aggregate limits large enough for every individually permitted image.
// Base64 expands a generated image by roughly one third in the series JSON request.
const MAX_MULTIPART_BYTES = 40 * 1024 * 1024;
const MAX_JSON_BYTES = 60 * 1024 * 1024;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_GENERATED_IMAGE_BYTES = 40 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 120_000;
const VALID_POSES = new Set(["quiet-luxury", "walking", "studio-clean", "detail-forward"]);

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".jfif", "image/jpeg"],
  [".webp", "image/webp"],
  [".svg", "image/svg+xml; charset=utf-8"],
]);
const server = http.createServer(requestHandler);

async function requestHandler(req, res) {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "POST" && !isSameOriginRequest(req)) {
      return sendJson(res, { error: "已拒绝来自其他网站的请求。" }, 403);
    }

    if (req.method === "GET" && url.pathname === "/api/status") {
      return sendJson(res, {
        hasAnalysisKey: Boolean(process.env.SILICONFLOW_API_KEY),
        hasImageKey: Boolean(process.env.ARK_API_KEY),
        hasKey: Boolean(process.env.SILICONFLOW_API_KEY && process.env.ARK_API_KEY),
        analysisModel: process.env.ANALYSIS_MODEL || DEFAULT_VISION_MODEL,
        imageModel: process.env.IMAGE_MODEL || DEFAULT_IMAGE_MODEL,
      });
    }

    if (req.method === "POST" && url.pathname === "/api/save-key") {
      await handleSaveKey(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/generate") {
      await handleGenerate(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/generate-series") {
      await handleGenerateSeries(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/feedback") {
      await handleFeedback(req, res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/feedback-stats") {
      await sendFeedbackStats(res);
      return;
    }

    if (req.method === "GET") {
      const filePath = url.pathname === "/" ? "/index.html" : url.pathname;
      await sendFile(res, path.join(__dirname, "public", safePublicPath(filePath)));
      return;
    }

    sendJson(res, { error: "不支持这个请求。" }, 405);
  } catch (error) {
    console.error(error);
    if (!res.writableEnded) {
      sendJson(res, { error: safeError(error) }, 500);
    }
  }
}

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.log(`模特图工具已经在运行：http://${HOST}:${PORT}`);
    return;
  }

  console.error(error);
  process.exitCode = 1;
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(PORT, HOST, () => {
    console.log(`模特图工具已启动：http://${HOST}:${PORT}`);
  });
}

async function handleGenerate(req, res) {
  const analysisKey = process.env.SILICONFLOW_API_KEY;
  const imageKey = process.env.ARK_API_KEY;
  if (!analysisKey || !imageKey) {
    return sendJson(
      res,
      {
        error: "还没有配置 API 密钥。请在下方填入硅基流动（分析）和火山引擎（生图）的 Key。",
        missingKey: true,
        missingAnalysis: !analysisKey,
        missingImage: !imageKey,
      },
      400,
    );
  }

  let form;
  try {
    form = await parseFormData(req, MAX_MULTIPART_BYTES);
  } catch (error) {
    return sendJson(res, { error: requestErrorMessage(error, "上传数据格式不正确。") }, error?.status || 400);
  }

  // Collect up to 3 garment images
  const imageFields = ["garment", "garment2", "garment3"];
  const imageDataUrls = [];
  for (const field of imageFields) {
    const img = form.get(field);
    if (!img || typeof img === "string") continue;
    const bytes = Buffer.from(await img.arrayBuffer());
    if (bytes.length > MAX_IMAGE_BYTES) {
      return sendJson(res, { error: `每张图片不能超过 ${MAX_IMAGE_BYTES / 1024 / 1024}MB。` }, 413);
    }
    let normalized;
    try {
      normalized = await normalizeUploadedImage(bytes, { maxOutputBytes: MAX_IMAGE_BYTES });
    } catch (error) {
      const name = typeof img.name === "string" && img.name ? `“${img.name}”` : "图片";
      return sendJson(
        res,
        { error: `${name}${requestErrorMessage(error, "无法读取，请重新导出后重试。")}` },
        error?.status || 400,
      );
    }
    imageDataUrls.push(`data:${normalized.mime};base64,${normalized.bytes.toString("base64")}`);
  }
  if (!imageDataUrls.length) {
    return sendJson(res, { error: "请至少选择一张衣服图片。" }, 400);
  }

  const mainImage = imageDataUrls[0];
  const notes = String(form.get("notes") || "").trim().slice(0, 1000);
  const garmentAnalysis = await analyzeGarmentImage({
    imageDataUrls,
    notes,
  });

  const prompt = buildPrompt({
    notes,
    pose: String(form.get("pose") || "quiet-luxury"),
    garmentAnalysis,
  });

  const generateBody = {
    model: process.env.IMAGE_MODEL || DEFAULT_IMAGE_MODEL,
    prompt,
    image: mainImage,
    size: "4K",
    response_format: "b64_json",
    watermark: false,
  };

  const response = await fetchWithTimeout(ARK_BASE, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${imageKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(generateBody),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const msg = data?.error?.message || data?.message || "生成失败，请检查密钥或图片后再试。";
    return sendJson(res, { error: `生成失败：${msg}` }, response.status);
  }

  const firstImage = data.data?.[0]?.b64_json;
  if (!firstImage) {
    return sendJson(res, { error: "生成完成但没有收到图片，请再试一次。" }, 502);
  }

  let imageBytes;
  let imageMime;
  try {
    imageBytes = decodeBase64Image(firstImage, MAX_GENERATED_IMAGE_BYTES);
    imageMime = detectImageMime(imageBytes);
    if (!imageMime) throw new Error("生图服务返回的内容不是支持的图片格式。");
  } catch (error) {
    return sendJson(res, { error: requestErrorMessage(error, "生图服务返回了无效图片。") }, 502);
  }

  await mkdir(path.join(__dirname, "agent_outputs"), { recursive: true });
  const extension = imageMime === "image/jpeg" ? "jpg" : imageMime.split("/")[1];
  const fileName = `model_photo_${fileTimestamp()}_${randomUUID().slice(0, 8)}.${extension}`;
  const savedPath = path.join(__dirname, "agent_outputs", fileName);
  await writeFile(savedPath, imageBytes);

  sendJson(res, {
    image: `data:${imageMime};base64,${firstImage}`,
    savedFile: `agent_outputs/${fileName}`,
    analysis: garmentAnalysis,
  });
}

async function handleGenerateSeries(req, res) {
  const imageKey = process.env.ARK_API_KEY;
  if (!imageKey) {
    return sendJson(res, { error: "缺少火山引擎 API Key。" }, 400);
  }

  let payload;
  try {
    payload = await readJsonBody(req, MAX_JSON_BYTES);
  } catch (error) {
    return sendJson(res, { error: requestErrorMessage(error, "请传入生成参数。") }, error?.status || 400);
  }

  const { mainImage, garmentAnalysis, notes, pose } = payload || {};
  if (!garmentAnalysis || typeof garmentAnalysis !== "object" || Array.isArray(garmentAnalysis)) {
    return sendJson(res, { error: "缺少主图或分析结果。" }, 400);
  }
  try {
    validateDataImage(mainImage, MAX_GENERATED_IMAGE_BYTES);
  } catch {
    return sendJson(res, { error: "主图不是有效的 JPG、PNG 或 WEBP 图片。" }, 400);
  }
  const normalizedAnalysis = normalizeGarmentAnalysis(garmentAnalysis);
  const normalizedNotes = typeof notes === "string" ? notes.trim().slice(0, 1000) : "";
  const normalizedPose = VALID_POSES.has(pose) ? pose : "quiet-luxury";

  await mkdir(path.join(__dirname, "agent_outputs"), { recursive: true });

  // 4 series pose variants — different actions, same outfit + background
  const seriesPoses = [
    "侧身站立，回眸看向镜头，自然微笑，左手自然垂放。注意全身比例协调，头小肩宽腿长。",
    "自然走路姿势，双手插在裤子口袋里，轻松随意。注意腿长占身高0.6以上，步幅自然。",
    "靠墙站立，右腿微曲交叉在左腿前，一只手自然垂放。注意肩宽约为头宽2.5倍，腰线偏高。",
    "正面走向镜头，右手自然摆动，步伐轻盈自信。注意头部偏小，锁骨清晰，比例修长。",
  ];

  const results = [];
  for (let i = 0; i < seriesPoses.length; i++) {
    const seriesPrompt = buildPrompt({
      notes: normalizedNotes,
      pose: normalizedPose,
      garmentAnalysis: normalizedAnalysis,
      seriesPose: seriesPoses[i],
    });

    try {
      const response = await fetchWithTimeout(ARK_BASE, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${imageKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: process.env.IMAGE_MODEL || DEFAULT_IMAGE_MODEL,
          prompt: seriesPrompt,
          image: mainImage,
          size: "4K",
          response_format: "b64_json",
          watermark: false,
        }),
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const msg = data?.error?.message || data?.message || "生成失败";
        results.push({ error: msg });
        continue;
      }

      const img = data.data?.[0]?.b64_json;
      if (img) {
        const imageBytes = decodeBase64Image(img, MAX_GENERATED_IMAGE_BYTES);
        const imageMime = detectImageMime(imageBytes);
        if (!imageMime) throw new Error("生图服务返回的内容不是支持的图片格式。");
        const extension = imageMime === "image/jpeg" ? "jpg" : imageMime.split("/")[1];
        const fileName = `model_series_${i + 1}_${fileTimestamp()}_${randomUUID().slice(0, 8)}.${extension}`;
        const savedPath = path.join(__dirname, "agent_outputs", fileName);
        await writeFile(savedPath, imageBytes);
        results.push({
          image: `data:${imageMime};base64,${img}`,
          savedFile: `agent_outputs/${fileName}`,
        });
      } else {
        results.push({ error: "未返回图片" });
      }
    } catch (err) {
      results.push({ error: safeError(err) });
    }
  }

  sendJson(res, { series: results });
}

// ── Feedback ──
const FEEDBACK_DIR = path.join(__dirname, "feedback");
const FEEDBACK_FILE = path.join(FEEDBACK_DIR, "feedback.json");
let feedbackWriteQueue = Promise.resolve();

async function handleFeedback(req, res) {
  let payload;
  try {
    payload = await readJsonBody(req, 16 * 1024);
  } catch (error) {
    return sendJson(res, { error: requestErrorMessage(error, "数据格式错误。") }, error?.status || 400);
  }

  const score = Number(payload?.score);
  if (!Number.isInteger(score) || score < 1 || score > 5) {
    return sendJson(res, { error: "请给出 1-5 星的评分。" }, 400);
  }

  const comment = String(payload.comment || "").trim().slice(0, 200);
  const record = {
    time: new Date().toISOString(),
    score,
    comment,
    pose: VALID_POSES.has(payload.pose) ? payload.pose : "",
    imageFile: String(payload.imageFile || "").slice(0, 200),
  };

  let total;
  feedbackWriteQueue = feedbackWriteQueue.catch(() => {}).then(async () => {
    await mkdir(FEEDBACK_DIR, { recursive: true });
    const records = readFeedbackRecords({ throwOnInvalid: true });
    records.push(record);
    await atomicWriteFile(FEEDBACK_FILE, JSON.stringify(records, null, 2));
    total = records.length;
  });
  await feedbackWriteQueue;

  sendJson(res, { ok: true, total });
}

async function sendFeedbackStats(res) {
  const records = readFeedbackRecords();

  const total = records.length;
  const avgScore = total > 0
    ? (records.reduce((s, r) => s + r.score, 0) / total).toFixed(1)
    : "0";

  const byPose = Object.create(null);
  for (const r of records) {
    const p = r.pose || "unknown";
    if (!byPose[p]) byPose[p] = { total: 0, count: 0 };
    byPose[p].total += r.score;
    byPose[p].count += 1;
  }
  const poseStats = Object.fromEntries(
    Object.entries(byPose).map(([k, v]) => [k, { avg: (v.total / v.count).toFixed(1), count: v.count }])
  );

  const recent = records.slice(-10).reverse();

  sendJson(res, { total, avgScore, poseStats, recent });
}

async function analyzeGarmentImage({ imageDataUrls, notes }) {
  const apiKey = process.env.SILICONFLOW_API_KEY;
  if (!apiKey) {
    throw new Error("缺少硅基流动 API Key，请在下方填入密钥。");
  }

  const imageCount = imageDataUrls.length;
  const userContent = [];

  // Add all images first
  for (const url of imageDataUrls) {
    userContent.push({ type: "image_url", image_url: { url } });
  }

  // Build analysis prompt with multi-image note
  const analysisPrompt = buildAnalysisPrompt(notes, imageCount);
  userContent.push({ type: "text", text: analysisPrompt });

  const response = await fetchWithTimeout(`${SILICONFLOW_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.ANALYSIS_MODEL || DEFAULT_VISION_MODEL,
      messages: [
        {
          role: "user",
          content: userContent,
        },
      ],
      max_tokens: 1200,
      temperature: 0.3,
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const msg = data?.error?.message || data?.message || "分析失败，请检查密钥或图片。";
    console.error("分析 API 错误：", JSON.stringify(data).slice(0, 500));
    throw new Error(`自动分析失败：${msg}`);
  }

  const text = data.choices?.[0]?.message?.content || "";
  if (!text) {
    console.error("分析 API 返回完整内容：", JSON.stringify(data).slice(0, 1000));
    throw new Error("自动分析没有返回文字，请查看终端日志。");
  }
  return normalizeGarmentAnalysis(parseJsonObject(text));
}

async function handleSaveKey(req, res) {
  let payload = {};
  try {
    payload = await readJsonBody(req, 16 * 1024);
  } catch (error) {
    return sendJson(res, { error: requestErrorMessage(error, "密钥格式没有保存成功。") }, error?.status || 400);
  }

  const siliconflowKey = String(payload.siliconflowKey || "").trim();
  const arkKey = String(payload.arkKey || "").trim();
  if (!siliconflowKey && !arkKey) {
    return sendJson(res, { error: "请至少填入一个 API Key。" }, 400);
  }
  if (![siliconflowKey, arkKey].every(isValidEnvValue)) {
    return sendJson(res, { error: "API Key 不能包含换行符，且长度不能超过 4096 个字符。" }, 400);
  }

  const target = path.join(__dirname, ".env.local");
  let lines = [];
  try {
    lines = readFileSync(target, "utf8").split(/\r?\n/);
  } catch {
    lines = [];
  }

  const replacements = new Map();
  if (siliconflowKey) replacements.set("SILICONFLOW_API_KEY", siliconflowKey);
  if (arkKey) replacements.set("ARK_API_KEY", arkKey);
  const nextContent = updateEnvContent(lines, replacements);
  await atomicWriteFile(target, nextContent, { mode: 0o600 });
  await chmod(target, 0o600);

  if (siliconflowKey) process.env.SILICONFLOW_API_KEY = siliconflowKey;
  if (arkKey) process.env.ARK_API_KEY = arkKey;

  sendJson(res, { ok: true, savedTo: ".env.local" });
}

function buildAnalysisPrompt(notes, imageCount = 1) {
  const multiImageNote = imageCount > 1
    ? `注意：这是同一件衣服的 ${imageCount} 张不同角度/部位图片（正面、背面、细节等），请综合分析所有图片来识别这件衣服的完整特征。`
    : "只有一张图片，请只根据这张图片分析。";

  const extra = notes
    ? `用户补充备注：${notes}`
    : "用户没有补充备注。";

  return [
    "你是资深电商服装造型师和模特图提示词助手。",
    "请分析上传图片里的主商品服装，不要把背景、衣架、人体姿势或搭配道具当成商品细节。",
    "重点识别：颜色、材质、毛感/面料肌理、衣长、廓形、肩线、领型/帽子、袖型、袖长、袖口、口袋、门襟/扣子/拉链、下摆、拼接线、特殊装饰。",
    "如果某个部位看不清楚，写[未明显可见]，不要编造。",
    multiImageNote,
    extra,
    "",
    "只输出一个 JSON 对象，不要输出 Markdown，不要解释。JSON 字段如下：",
    "{",
    '  "productName": "一句话商品名",',
    '  "productParagraph": "仿照：上身是一件短款白色水貂外套，廓形偏宽松，落肩、袖子蓬松，视觉重点在毛感和厚度。根据图片真实替换颜色、材质、衣长、领型、袖型、口袋等，不要保留示例里没有出现在图片中的内容。",',
    '  "color": "主颜色和辅色",',
    '  "material": "材质/毛感/面料肌理",',
    '  "silhouette": "廓形和松量",',
    '  "length": "衣长",',
    '  "shoulder": "肩线/落肩/正肩",',
    '  "collar": "领型/帽子/翻领/立领/V领等",',
    '  "sleeves": "袖型和袖长",',
    '  "cuffs": "袖口形状和开口",',
    '  "pockets": "口袋位置、角度、类型；没有或看不清就说明",',
    '  "closure": "门襟、扣子、拉链、钩扣等",',
    '  "hem": "下摆形状、厚度、长短",',
    '  "detailsToPreserve": ["必须保留的细节1", "必须保留的细节2"]',
    "}",
  ].join("\n");
}

function buildPrompt({ notes, pose, garmentAnalysis, seriesPose }) {
  const sceneMap = {
    "quiet-luxury": "a minimalist white gallery space with floor-to-ceiling windows, warm marble floors, soft side lighting streaming through the glass creating gentle gradients on the wall",
    "walking": "a tree-lined street in an affluent neighborhood, dappled afternoon sunlight filtering through plane tree leaves, blurred luxury boutiques in the background",
    "studio-clean": "a professional photography studio with a seamless white cyclorama wall, multiple softbox lights creating even, shadowless illumination, clean commercial aesthetic",
    "detail-forward": "a curated designer boutique interior with warm oak shelving and natural light slanting through a side window, shallow depth of field blurring the background",
  };

  const poseDesc = seriesPose
    ? `a full-body vertical shot, ${seriesPose} The outfit, setting, lighting, and model appearance must be identical to the first image.`
    : {
    "quiet-luxury":
      `a relaxed full-body shot of the model standing with her weight shifted to the back leg, one hand resting naturally at her side, head-to-toe framing with generous negative space above and to the right. The setting is ${sceneMap["quiet-luxury"]}`,
    "walking":
      `a candid full-body shot of the model walking naturally down the street, one hand tucked casually in her pocket, mid-stride with a relaxed expression, head-to-toe framing. The setting is ${sceneMap["walking"]}`,
    "studio-clean":
      `a clean full-body shot of the model standing centered and facing the camera, both hands relaxed at her sides, showcasing the complete silhouette, head-to-toe framing. The setting is ${sceneMap["studio-clean"]}`,
    "detail-forward":
      `a three-quarter body shot focusing on the collar, cuffs, pockets, and button placket of the garment, the model's hands naturally positioned away from key details. The setting is ${sceneMap["detail-forward"]}`,
  }[pose] || "a full-body vertical editorial fashion shot with premium e-commerce quality.";

  const userNotes = notes
    ? `Additional user notes: ${notes}`
    : "";

  const preserveList = Array.isArray(garmentAnalysis.detailsToPreserve)
    ? garmentAnalysis.detailsToPreserve.map((item) => `- ${item}`).join("\n")
    : "- Preserve all visible details from the reference image";

  return [
    "A high-end fashion editorial photograph for a luxury designer brand's 2026 fall-winter lookbook, shot on a Hasselblad H6D medium format camera with an 85mm f/1.4 portrait lens at wide aperture. The extremely shallow depth of field creates a creamy, painterly bokeh that melts the background away while keeping the garment in razor-sharp focus. Natural side lighting at approximately 45 degrees casts soft sculptural shadows across the fabric, revealing every nuance of surface texture. The color grading follows a warm neutral Kodak Portra 400 film profile — muted earth tones, delicate highlight rolloff, open shadows with visible detail, and a subtle golden undertone throughout. No harsh contrast, no crushed blacks, no overexposed whites.",
    "",
    "The model is a 25-year-old Chinese woman, 170cm tall, with luminous fair skin that shows natural texture — fine pores, subtle highlights on the cheekbones. Her makeup is minimal: feathered natural brows, a nude lip, and a whisper of warm blush. Her dark brown hair falls in soft, lived-in waves just past the shoulders, with visible shine and healthy flyaways catching the light. She has an elegant, slightly aloof expression — relaxed, not smiling, completely at ease. Her build is lean with visible collarbones. Body proportions are critical: 1:7.5 head-to-body ratio with a small, well-defined head, shoulders approximately 2.5x head width with a clean horizontal line, high waist at the 0.618 golden ratio point, legs measuring more than 0.6 of total height.",
    "",
    "The uploaded garment is the only style reference and must be reproduced with absolute fidelity. Every construction detail — collar shape, shoulder line, sleeve type and length, cuff opening, pocket placement and angle, button placket or zipper configuration, hem length and curvature — must match the reference image exactly. Do not add pockets, belts, drawstrings, buttons, logos, or any trim that is not present in the uploaded image. If a detail is not clearly visible, keep it simple and understated.",
    "",
    "The outfit formula follows Old Money quiet luxury principles:",
    `Upper body: The main garment from the uploaded image — ${garmentAnalysis.productParagraph}. Color: ${garmentAnalysis.color}. Material: ${garmentAnalysis.material}. Silhouette: ${garmentAnalysis.silhouette}. Length: ${garmentAnalysis.length}. Shoulder: ${garmentAnalysis.shoulder}. Collar: ${garmentAnalysis.collar}. Sleeves: ${garmentAnalysis.sleeves}. Cuffs: ${garmentAnalysis.cuffs}. Pockets: ${garmentAnalysis.pockets}. Closure: ${garmentAnalysis.closure}. Hem: ${garmentAnalysis.hem}.`,
    "Inner layer (if the main garment is a jacket or coat): A fine-gauge cashmere turtleneck or a heavyweight silk charmeuse blouse in a contrasting neutral tone. Dark inner for light outer garments, cream or ivory inner for dark outer garments. The fabric should show subtle natural luster — not shiny, but visibly rich.",
    "Lower body: Black high-waisted wide-leg tailored trousers in a wool-blend fabric with exceptional drape and a sharp center crease. The hem breaks softly over the shoe without pooling. The silhouette is elongated and statuesque.",
    "Footwear: Black pointed-toe ankle boots or black pointed-toe pumps in fine matte leather. No patent shine.",
    "Accessories: Black sunglasses — worn either on the eyes, pushed up into the hair as a headband, or hooked onto the neckline as a styling detail. A whisper-thin gold bangle or silver watch at the wrist. Maximum three accessories total.",
    "Fabrics throughout must be natural and luxurious: cashmere, merino wool, silk, high-count cotton poplin, matte suede. Different textures should layer against each other — soft fuzz against smooth weave, matte against subtle sheen — to create visual depth without pattern or print.",
    "",
    "The overall palette is restrained and tonal: cream, oatmeal, camel, charcoal, navy, chocolate brown. No more than three colors in the entire frame. Black is used only as an anchor in shoes, trousers, or accessories — never head-to-toe.",
    "",
    "Composition: " + poseDesc + " The model must be shown from head to toe with her feet and shoes fully visible, not cropped. The proportions should read tall and elegant with the legs occupying the lower 0.6 of the frame. Leave breathing room above the head and to the sides for text overlay in e-commerce use.",
    "",
    "Details that must be preserved in this generation:",
    preserveList,
    "",
    "Technical requirements: ultra-high resolution, fabric texture rendered with tactile clarity and visible weave/knit structure where applicable, natural skin texture without plastic smoothing, realistic garment drape and fold behavior, no watermarks, no brand logos, no text, no distorted hands or fingers.",
    "",
    userNotes,
  ].filter(Boolean).join("\n");
}
function parseJsonObject(text) {
  if (!text) throw new Error("自动分析没有返回文字。");
  const cleaned = text.replace(/```json|```/g, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("自动分析结果格式不正确。");
  return JSON.parse(match[0]);
}


function normalizeGarmentAnalysis(raw) {
  const text = (key, fallback = "未明显可见") => {
    const value = raw?.[key];
    return typeof value === "string" && value.trim() ? value.trim().slice(0, 2000) : fallback;
  };

  const details = Array.isArray(raw?.detailsToPreserve)
    ? raw.detailsToPreserve
      .filter((item) => typeof item === "string" && item.trim())
      .map((item) => item.trim().slice(0, 500))
      .slice(0, 10)
    : [];

  return {
    productName: text("productName", "上传图片中的主商品服装"),
    productParagraph: text("productParagraph", "上身主商品以上传图片为准，保持真实颜色、材质、廓形和细节。"),
    color: text("color"),
    material: text("material"),
    silhouette: text("silhouette"),
    length: text("length"),
    shoulder: text("shoulder"),
    collar: text("collar"),
    sleeves: text("sleeves"),
    cuffs: text("cuffs"),
    pockets: text("pockets"),
    closure: text("closure"),
    hem: text("hem"),
    detailsToPreserve: details.length ? details : ["领子、袖口、口袋、门襟和下摆按上传图保持"],
  };
}

function updateEnvContent(lines, replacements) {
  const pending = new Map(replacements);
  const out = [];
  for (const line of lines) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    const key = match?.[1];
    if (!key || !replacements.has(key)) {
      out.push(line);
      continue;
    }
    if (pending.has(key)) {
      out.push(`${key}=${pending.get(key)}`);
      pending.delete(key);
    }
  }
  for (const [key, value] of pending) out.push(`${key}=${value}`);
  while (out.length && out.at(-1) === "") out.pop();
  return `${out.join("\n")}\n`;
}

function isValidEnvValue(value) {
  return value.length <= 4096 && !/[\r\n]/.test(value);
}

function loadLocalEnv() {
  const envPath = path.join(__dirname, ".env.local");
  try {
    const content = readFileSyncSafe(envPath);
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index === -1) continue;
      const key = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // A missing .env.local is fine; the page will show a friendly status.
  }
}

function readFileSyncSafe(filePath) {
  return readFileSync(filePath, "utf8");
}


function safePublicPath(filePath) {
  const normalized = path.normalize(filePath).replace(/^(\.\.[/\\])+/, "");
  return normalized.replace(/^[/\\]/, "");
}

async function sendFile(res, filePath) {
  const resolved = path.resolve(filePath);
  const publicPath = path.resolve(__dirname, "public");
  if (resolved !== publicPath && !resolved.startsWith(`${publicPath}${path.sep}`)) return notFound(res);
  const publicRoot = await realpath(publicPath);

  let realFile;
  try {
    realFile = await realpath(resolved);
    if (realFile !== publicRoot && !realFile.startsWith(`${publicRoot}${path.sep}`)) return notFound(res);
    const fileStat = await stat(realFile);
    if (!fileStat.isFile()) return notFound(res);
  } catch {
    return notFound(res);
  }

  const ext = path.extname(realFile).toLowerCase();
  res.writeHead(200, {
    "Content-Type": mimeTypes.get(ext) || "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
  });
  const stream = createReadStream(realFile);
  stream.on("error", (error) => {
    console.error(error);
    if (!res.writableEnded) res.destroy(error);
  });
  stream.pipe(res);
}

function sendJson(res, payload, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(payload));
}

function notFound(res) {
  sendJson(res, { error: "没有找到这个文件。" }, 404);
}

function safeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function readFeedbackRecords({ throwOnInvalid = false } = {}) {
  try {
    const parsed = JSON.parse(readFileSync(FEEDBACK_FILE, "utf8"));
    if (!Array.isArray(parsed)) throw new Error("评分数据不是数组。");
    return parsed
      .filter((record) => record && Number.isInteger(record.score) && record.score >= 1 && record.score <= 5)
      .map((record) => ({
        time: typeof record.time === "string" ? record.time.slice(0, 100) : "",
        score: record.score,
        comment: typeof record.comment === "string" ? record.comment.slice(0, 200) : "",
        pose: VALID_POSES.has(record.pose) ? record.pose : "",
        imageFile: typeof record.imageFile === "string" ? record.imageFile.slice(0, 200) : "",
      }));
  } catch (error) {
    if (error?.code !== "ENOENT" && throwOnInvalid) {
      throw new Error("评分文件损坏，已停止写入以避免覆盖原数据。", { cause: error });
    }
    return [];
  }
}

async function readRequestBody(req, maxBytes) {
  const declaredLength = Number(req.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw httpError(413, "请求内容过大。");
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw httpError(413, "请求内容过大。");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

async function readJsonBody(req, maxBytes) {
  const contentType = String(req.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") throw httpError(415, "请使用 JSON 格式提交数据。");
  const bytes = await readRequestBody(req, maxBytes);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw httpError(400, "JSON 数据格式错误。");
  }
}

async function parseFormData(req, maxBytes) {
  const contentType = String(req.headers["content-type"] || "");
  if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
    throw httpError(400, "请使用表单上传图片。");
  }
  const bytes = await readRequestBody(req, maxBytes);
  const incoming = new Request(`http://localhost:${PORT}/`, {
    method: "POST",
    headers: { "content-type": contentType },
    body: bytes,
  });
  return incoming.formData();
}

function isSupportedDataImage(value) {
  return typeof value === "string" && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value);
}

function validateDataImage(value, maxBytes) {
  if (!isSupportedDataImage(value)) throw new Error("图片 Data URL 格式无效。");
  const comma = value.indexOf(",");
  const declaredMime = value.slice(5, value.indexOf(";", 5));
  const bytes = decodeBase64Image(value.slice(comma + 1), maxBytes);
  const detectedMime = detectImageMime(bytes);
  if (!detectedMime || detectedMime !== declaredMime) throw new Error("图片内容与格式不匹配。");
  return { bytes, mime: detectedMime };
}

function decodeBase64Image(value, maxBytes) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 === 1) {
    throw new Error("图片编码无效。");
  }
  const estimatedBytes = Math.floor(value.length * 3 / 4);
  if (estimatedBytes > maxBytes) throw new Error("返回图片过大。");
  const bytes = Buffer.from(value, "base64");
  if (!bytes.length || bytes.length > maxBytes) throw new Error("返回图片无效或过大。");
  return bytes;
}

async function fetchWithTimeout(url, options) {
  try {
    return await fetch(url, { ...options, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  } catch (error) {
    if (error?.name === "TimeoutError") throw new Error("外部服务响应超时，请稍后重试。");
    throw new Error("无法连接外部服务，请检查网络后重试。", { cause: error });
  }
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function requestErrorMessage(error, fallback) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function fileTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function isSameOriginRequest(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.host === req.headers.host;
  } catch {
    return false;
  }
}

async function atomicWriteFile(target, content, options = {}) {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, options);
    await rename(temporary, target);
  } catch (error) {
    try {
      await unlink(temporary);
    } catch {}
    throw error;
  }
}

export {
  buildAnalysisPrompt,
  buildPrompt,
  decodeBase64Image,
  detectImageMime,
  isSupportedDataImage,
  isSameOriginRequest,
  normalizeGarmentAnalysis,
  parseJsonObject,
  requestHandler,
  safePublicPath,
  server,
  updateEnvContent,
  validateDataImage,
};
