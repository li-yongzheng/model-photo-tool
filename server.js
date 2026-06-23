import { createReadStream, readFileSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 5178);
const HOST = process.env.HOST || "127.0.0.1";
const DEFAULT_IMAGE_MODEL = "doubao-seedream-5-0-260128";
const DEFAULT_VISION_MODEL = "Qwen/Qwen3-VL-32B-Instruct";
const SILICONFLOW_BASE = "https://api.siliconflow.cn/v1";
const ARK_BASE = "https://ark.cn-beijing.volces.com/api/v3/images/generations";

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".svg", "image/svg+xml; charset=utf-8"],
]);


loadLocalEnv();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

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
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.log(`模特图工具已经在运行：http://${HOST}:${PORT}`);
    return;
  }

  console.error(error);
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
  console.log(`模特图工具已启动：http://${HOST}:${PORT}`);
});

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

  const incoming = new Request(`http://localhost:${PORT}/api/generate`, {
    method: "POST",
    headers: req.headers,
    body: req,
    duplex: "half",
  });

  const form = await incoming.formData();

  // Collect up to 3 garment images
  const imageFields = ["garment", "garment2", "garment3"];
  const imageDataUrls = [];
  for (const field of imageFields) {
    const img = form.get(field);
    if (!img || typeof img === "string") continue;
    const bytes = Buffer.from(await img.arrayBuffer());
    const mime = img.type || "image/png";
    imageDataUrls.push(`data:${mime};base64,${bytes.toString("base64")}`);
  }
  if (!imageDataUrls.length) {
    return sendJson(res, { error: "请至少选择一张衣服图片。" }, 400);
  }

  const mainImage = imageDataUrls[0];
  const notes = String(form.get("notes") || "").trim();
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

  const response = await fetch(ARK_BASE, {
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

  await mkdir(path.join(__dirname, "agent_outputs"), { recursive: true });
  const fileName = `model_photo_${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
  const savedPath = path.join(__dirname, "agent_outputs", fileName);
  await writeFile(savedPath, Buffer.from(firstImage, "base64"));

  sendJson(res, {
    image: `data:image/png;base64,${firstImage}`,
    savedFile: `agent_outputs/${fileName}`,
    analysis: garmentAnalysis,
  });
}

async function handleGenerateSeries(req, res) {
  const imageKey = process.env.ARK_API_KEY;
  if (!imageKey) {
    return sendJson(res, { error: "缺少火山引擎 API Key。" }, 400);
  }

  const incoming = new Request(`http://localhost:${PORT}/api/generate-series`, {
    method: "POST",
    headers: req.headers,
    body: req,
    duplex: "half",
  });

  let payload;
  try {
    payload = await incoming.json();
  } catch {
    return sendJson(res, { error: "请传入生成参数。" }, 400);
  }

  const { mainImage, garmentAnalysis, notes, pose } = payload;
  if (!mainImage || !garmentAnalysis) {
    return sendJson(res, { error: "缺少主图或分析结果。" }, 400);
  }

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
      notes: notes || "",
      pose: pose || "quiet-luxury",
      garmentAnalysis,
      seriesPose: seriesPoses[i],
    });

    try {
      const response = await fetch(ARK_BASE, {
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
        const fileName = `model_series_${i + 1}_${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
        const savedPath = path.join(__dirname, "agent_outputs", fileName);
        await writeFile(savedPath, Buffer.from(img, "base64"));
        results.push({
          image: `data:image/png;base64,${img}`,
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

  const response = await fetch(`${SILICONFLOW_BASE}/chat/completions`, {
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
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);

  let payload = {};
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return sendJson(res, { error: "密钥格式没有保存成功。" }, 400);
  }

  const siliconflowKey = String(payload.siliconflowKey || "").trim();
  const arkKey = String(payload.arkKey || "").trim();
  if (!siliconflowKey && !arkKey) {
    return sendJson(res, { error: "请至少填入一个 API Key。" }, 400);
  }

  const target = path.join(__dirname, ".env.local");
  let lines = [];
  try {
    lines = readFileSync(target, "utf8").split(/\r?\n/);
  } catch {
    lines = [];
  }

  // Only rewrite key-related lines, leave everything else untouched
  const out = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith("SILICONFLOW_API_KEY=") || t.startsWith("ARK_API_KEY=")) continue;
    out.push(t);
  }

  if (siliconflowKey) {
    process.env.SILICONFLOW_API_KEY = siliconflowKey;
    out.push(`SILICONFLOW_API_KEY=${siliconflowKey}`);
  }
  if (arkKey) {
    process.env.ARK_API_KEY = arkKey;
    out.push(`ARK_API_KEY=${arkKey}`);
  }
  out.push("");

  const nextContent = out.join("\n");
  await writeFile(target, nextContent, { mode: 0o600 });

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
    "quiet-luxury": "极简白色画廊空间，大面积留白，暖色大理石地面，柔和侧逆光从落地窗洒入",
    "walking": "上海武康路法租界街景，梧桐树影斑驳，午后阳光温暖柔和，背景虚化",
    "studio-clean": "专业摄影棚纯白无影墙，多角度柔光灯箱，干净利落的商业广告片质感",
    "detail-forward": "设计师买手店室内，暖木色家具，自然光从窗户斜射，景深很浅",
  };

  const poseLine = seriesPose
    ? `竖版全身，${seriesPose}服装、场景、光影、人物与首张完全一致。`
    : {
    "quiet-luxury":
      `竖版全身，模特姿态松弛自信，重心放在后腿，一只手自然垂放。画面必须包含从头到脚完整全身，头身比1:7.5。场景：${sceneMap["quiet-luxury"]}。`,
    "walking":
      `竖版全身，模特在街上自然行走，步伐轻盈放松，一只手插口袋，抓拍感。画面必须包含从头到脚完整全身，腿长明显。场景：${sceneMap["walking"]}。`,
    "studio-clean":
      `竖版全身，模特正对镜头站立，双手自然垂放，展示服装完整廓形。画面必须包含从头到脚完整全身，肩宽头小。场景：${sceneMap["studio-clean"]}。`,
    "detail-forward":
      `竖版大半身，重点展示领口、袖口、口袋和门襟的做工细节。注意肩宽比例，不要大头窄肩。场景：${sceneMap["detail-forward"]}。`,
  }[pose] || "竖版全身，高级电商模特感。";

  const userNotes = notes
    ? `用户额外备注：${notes}`
    : "用户无额外备注；以上传图片自动解析结果为准。";

  const preserveList = Array.isArray(garmentAnalysis.detailsToPreserve)
    ? garmentAnalysis.detailsToPreserve.map((item) => "`- ${item}`").join("\n")
    : "- 按上传图保留真实款式细节";

  return [
    "你是一位顶级时尚摄影师，正在为高端设计师品牌拍摄2026秋冬系列画册。上传图片中的主商品服装是唯一款式依据，请精确还原所有细节。",
    "",
    "摄影风格：",
    "Hasselblad中画幅，85mm f/1.4大光圈，浅景深奶油般虚化背景，画面通透有呼吸感。色调偏暖中性，低饱和莫兰迪色系，暗部有细节不压死黑，高光柔和不过曝。",
    "",
    "模特形象：",
    "中国女孩，25岁，身高170cm，皮肤白皙细腻有光泽。自然韩式裸妆，野生眉，裸色唇。深棕色中长发蓬松微卷，发质健康有光泽。气质清冷高级，身材匀称偏瘦，锁骨明显。",
    "",
    "人体比例（极其重要，必须严格遵守）：",
    "头身比1:7.5，头围偏小，脸小且轮廓清晰。肩膀宽度约为头宽的2.5倍，肩线平直宽阔。腰线偏高，肚脐位于身高的0.618黄金分割点。腿长从髋骨到脚底占身高的0.6以上，大腿和小腿比例均衡。脚踝纤细。整体呈标准的8头身时尚插画比例。",
    "",
    "搭配方案（老钱风核心公式，必须严格遵守）：",
    "上装：上传图片中的主商品服装，精确还原版型和细节。",
    "色彩法则：全身不超过3种颜色。优先同色系深浅叠穿——奶油白+燕麦米+驼色，或藏青+浅灰+炭灰。只在对比较弱时用黑或白做内搭打破沉闷。",
    "内搭款式（如果主商品是外套）：极细羊绒半高领打底衫、重磅真丝衬衫、或牛津纺白衬衫。领口干净利落，面料有高级哑光光泽。",
    "下装：黑色高腰阔腿长裤，垂坠感极强，裤腿很长覆盖到鞋面。面料为羊毛混纺，裤线锋利。",
    "鞋子：黑色尖头细跟短靴或黑色尖头高跟鞋，皮质细腻。",
    "配饰：黑色墨镜（可佩戴、推上头顶、或别在胸前衣襟上）、腕间极细金镯或银色手表。不超过3件配饰。",
    "面料要求：天然材质为主——羊绒、羊毛、真丝、高支棉、哑光麂皮。不同肌理叠穿创造层次。",
    "",
    "服装细节（根据上传图片自动解析）：",
    garmentAnalysis.productParagraph,
    `颜色：${garmentAnalysis.color}`,
    `材质：${garmentAnalysis.material}`,
    `廓形：${garmentAnalysis.silhouette}`,
    `衣长：${garmentAnalysis.length}`,
    `肩线：${garmentAnalysis.shoulder}`,
    `领子/帽子：${garmentAnalysis.collar}`,
    `袖子：${garmentAnalysis.sleeves}`,
    `袖口：${garmentAnalysis.cuffs}`,
    `口袋：${garmentAnalysis.pockets}`,
    `门襟：${garmentAnalysis.closure}`,
    `下摆：${garmentAnalysis.hem}`,
    "",
    "画面构成：",
    poseLine,
    "",
    "款式锁定规则：",
    "- 领型、袖型、肩线、袖口、口袋、门襟、下摆必须与上传图完全一致，不得自行修改或重新设计。",
    "- 不要凭空添加口袋、腰带、抽绳、纽扣、拉链、logo或任何装饰。",
    "- 看不清的细节保持简洁，不要脑补。",
    "",
    "本次必须保留的细节：",
    preserveList,
    "",
    "硬性要求：",
    "超高分辨率、面料肌理清晰可见、真实穿着比例、无文字水印品牌标志、无畸形手指。",
    "",
    userNotes,
  ].join("\n");
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
    return typeof value === "string" && value.trim() ? value.trim() : fallback;
  };

  const details = Array.isArray(raw?.detailsToPreserve)
    ? raw.detailsToPreserve.filter((item) => typeof item === "string" && item.trim()).slice(0, 10)
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
  const publicRoot = path.resolve(__dirname, "public");
  const sampleRoot = path.resolve(__dirname);
  if (!resolved.startsWith(publicRoot) && !resolved.startsWith(sampleRoot)) return notFound(res);

  try {
    const fileStat = await stat(resolved);
    if (!fileStat.isFile()) return notFound(res);
  } catch {
    return notFound(res);
  }

  const ext = path.extname(resolved).toLowerCase();
  res.writeHead(200, { "Content-Type": mimeTypes.get(ext) || "application/octet-stream" });
  createReadStream(resolved).pipe(res);
}

function sendJson(res, payload, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function notFound(res) {
  sendJson(res, { error: "没有找到这个文件。" }, 404);
}

function safeError(error) {
  return error instanceof Error ? error.message : String(error);
}



