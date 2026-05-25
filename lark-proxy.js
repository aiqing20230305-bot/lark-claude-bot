/**
 * lark-proxy.js — 本地代理服务器
 * 同时支持 lark-cli 和 dreamina CLI
 * 用 cloudflared 暴露为公网 URL
 */
import express from "express";
import { execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const app = express();
app.use(express.json());

const SECRET = process.env.PROXY_SECRET || "lark-proxy-secret-2026";
const LARK_CLI = process.env.LARK_CLI_PATH || "lark-cli";
const DREAMINA = process.env.DREAMINA_PATH || "/Users/zhangjingwei/.local/bin/dreamina";
const ATYPICA = process.env.ATYPICA_PATH || "atypica";

// 鉴权中间件
app.use((req, res, next) => {
  if (req.path === "/health") return next();
  if (req.headers["x-proxy-secret"] !== SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

app.get("/health", (req, res) => res.json({
  ok: true,
  time: new Date().toISOString(),
  services: ["lark-cli", "dreamina", "atypica", "extract-audio", "transcribe", "hot-topics", "generate-image", "fetch-url", "search"],
}));

function runCmd(bin, args, timeoutMs = 30000) {
  const cmd = [bin, ...args.map((a) => JSON.stringify(a))].join(" ");
  console.log(`[exec] ${cmd}`);
  try {
    const output = execSync(cmd, {
      encoding: "utf8",
      timeout: timeoutMs,
      env: { ...process.env, PATH: process.env.PATH },
    });
    try {
      return { output: JSON.parse(output) };
    } catch {
      return { output };
    }
  } catch (err) {
    const stderr = err.stderr?.toString() || "";
    const stdout = err.stdout?.toString() || "";
    console.error(`[error] ${stderr}`);
    return { error: stderr || err.message, output: stdout };
  }
}

// ── lark-cli ──────────────────────────────────────────────────────────────────
const LARK_ALLOWED = ["api", "calendar", "contact", "im", "task", "docs", "drive", "bitable", "sheets", "wiki", "approval", "schema"];

app.post("/exec", (req, res) => {
  const { args } = req.body;
  if (!Array.isArray(args) || args.length === 0) {
    return res.status(400).json({ error: "args must be non-empty array" });
  }
  if (!LARK_ALLOWED.includes(args[0])) {
    return res.status(400).json({ error: `不允许的 lark-cli 命令: ${args[0]}` });
  }
  res.json(runCmd(LARK_CLI, args));
});

// ── dreamina ──────────────────────────────────────────────────────────────────
const DREAMINA_ALLOWED = [
  "text2image", "text2video", "image2image", "image2video",
  "multiframe2video", "multimodal2video", "frames2video", "image_upscale",
  "query_result", "list_task", "user_credit",
];

app.post("/dreamina", (req, res) => {
  const { args } = req.body;
  if (!Array.isArray(args) || args.length === 0) {
    return res.status(400).json({ error: "args must be non-empty array" });
  }
  if (!DREAMINA_ALLOWED.includes(args[0])) {
    return res.status(400).json({ error: `不允许的 dreamina 命令: ${args[0]}` });
  }
  // 视频生成任务最长等 120 秒
  const timeout = args[0].includes("video") ? 120000 : 60000;
  res.json(runCmd(DREAMINA, args, timeout));
});

// ── Atypica 热点趋势 ──────────────────────────────────────────────────────────
const ATYPICA_ALLOWED = ["pulse"];

app.post("/atypica", (req, res) => {
  const { args } = req.body;
  if (!Array.isArray(args) || args.length === 0) {
    return res.status(400).json({ error: "args must be non-empty array" });
  }
  if (!ATYPICA_ALLOWED.includes(args[0])) {
    return res.status(400).json({ error: `不允许的 atypica 命令: ${args[0]}` });
  }
  // 注入 --json 和 --no-update-check 保证机器可读输出
  const fullArgs = [...args];
  if (!fullArgs.includes("--json")) fullArgs.push("--json");
  if (!fullArgs.includes("--no-update-check")) fullArgs.push("--no-update-check");

  res.json(runCmd(ATYPICA, fullArgs, 30000));
});

// ── 用 lark-cli 获取当前有效的 user access token ──────────────────────────────
app.get("/token", (req, res) => {
  // 通过 lark-cli 调用 authen API，lark-cli 内部会自动刷新 token
  const result = runCmd(LARK_CLI, [
    "api", "POST",
    "/open-apis/authen/v1/refresh_access_token",
    "--as", "bot",   // 用 bot 身份获取 app_access_token，然后通过它刷新 user token
  ], 15000);

  // 更简单：直接用 lark-cli 内部的 user token 发起一个 userinfo 调用
  // 然后通过截获 Authorization header 来拿 token
  // 由于 lark-cli 不暴露 token，改为让 bot 调用 proxy 的 exec 即可
  // 返回 lark-cli 当前 user auth 状态
  const statusResult = runCmd(LARK_CLI, ["auth", "status"], 10000);
  const status = typeof statusResult.output === "object"
    ? statusResult.output
    : {};
  const user = status?.identities?.user || {};
  res.json({
    ok: user.tokenStatus === "valid",
    tokenStatus: user.tokenStatus,
    expiresAt: user.expiresAt,
    refreshExpiresAt: user.refreshExpiresAt,
    userName: user.userName,
    // token 值 lark-cli 不直接暴露，bot 应优先使用 /exec 而非直接 token
  });
});

// ── 视频音频提取（ffmpeg） ─────────────────────────────────────────────────────
app.post("/extract-audio", (req, res) => {
  const { video_base64 } = req.body;
  if (!video_base64) return res.status(400).json({ error: "video_base64 required" });

  const tmpVideo = path.join(os.tmpdir(), `v_${Date.now()}.mp4`);
  const tmpAudio = path.join(os.tmpdir(), `a_${Date.now()}.ogg`);

  try {
    fs.writeFileSync(tmpVideo, Buffer.from(video_base64, "base64"));
    // 提取音频并转为 ogg_opus（飞书 ASR 支持格式）
    execSync(
      `ffmpeg -i "${tmpVideo}" -vn -acodec libopus -ar 16000 -ac 1 -b:a 32k "${tmpAudio}" -y`,
      { timeout: 60000, stdio: "pipe" }
    );
    const audioData = fs.readFileSync(tmpAudio);
    res.json({ audio_base64: audioData.toString("base64"), format: "ogg_opus" });
  } catch (err) {
    console.error("[extract-audio error]", err.message);
    res.status(500).json({ error: err.message });
  } finally {
    try { fs.unlinkSync(tmpVideo); } catch {}
    try { fs.unlinkSync(tmpAudio); } catch {}
  }
});

// ── 本地 Whisper 语音转写 ─────────────────────────────────────────────────────
app.post("/transcribe", (req, res) => {
  const { audio_base64 } = req.body;
  if (!audio_base64) return res.status(400).json({ error: "audio_base64 required" });

  const ts = Date.now();
  const tmpRaw = path.join(os.tmpdir(), `asr_raw_${ts}`);
  const tmpMp3 = path.join(os.tmpdir(), `asr_${ts}.mp3`);

  try {
    fs.writeFileSync(tmpRaw, Buffer.from(audio_base64, "base64"));

    // 转换为 16kHz 单声道 mp3（Whisper 最佳输入格式）
    execSync(
      `ffmpeg -i "${tmpRaw}" -ar 16000 -ac 1 -q:a 4 "${tmpMp3}" -y`,
      { timeout: 30000, stdio: "pipe" }
    );
    fs.unlinkSync(tmpRaw);

    // 本地 Whisper 转写
    const transcript = execSync(
      `python3 -c "import whisper,sys; m=whisper.load_model('base'); r=m.transcribe(sys.argv[1],fp16=False); print(r['text'].strip())" "${tmpMp3}"`,
      { timeout: 120000, encoding: "utf8", stdio: "pipe" }
    ).trim();

    res.json({ transcript });
  } catch (err) {
    console.error("[transcribe error]", err.message);
    res.status(500).json({ error: err.message });
  } finally {
    try { fs.unlinkSync(tmpRaw); } catch {}
    try { fs.unlinkSync(tmpMp3); } catch {}
  }
});

// ── 网页搜索（Bing China，无需 API key，中国直连可用） ─────────────────────────
const SEARCH_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function parseBingResults(html, limit) {
  const results = [];
  // Each organic result is inside <li class="b_algo">
  const blockRe = /<li[^>]+class="[^"]*b_algo[^"]*"[^>]*>([\s\S]*?)<\/li>/g;
  let m;
  while ((m = blockRe.exec(html)) !== null && results.length < limit) {
    const block = m[1];
    // Title + URL from <h2><a href="...">Title</a></h2>
    const titleM = block.match(/<h2[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!titleM) continue;
    const url = titleM[1];
    const title = titleM[2].replace(/<[^>]+>/g, "").replace(/&[a-z#0-9]+;/gi, " ").trim();
    if (!title || !url.startsWith("http")) continue;

    // Snippet from <p> or <div class="b_caption">
    const snipM = block.match(/<p[^>]*>([\s\S]*?)<\/p>/) ||
                  block.match(/<div[^>]+class="[^"]*b_caption[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    const snippet = snipM
      ? snipM[1].replace(/<[^>]+>/g, "").replace(/&[a-z#0-9]+;/gi, " ").trim().slice(0, 200)
      : "";

    results.push({ title, url, snippet });
  }
  return results;
}

app.post("/search", async (req, res) => {
  const { query, limit = 8 } = req.body;
  if (!query) return res.status(400).json({ error: "query required" });

  const encoded = encodeURIComponent(query);
  const searchUrl = `https://cn.bing.com/search?q=${encoded}&setlang=zh-Hans&count=20`;

  try {
    const r = await fetch(searchUrl, {
      headers: {
        "User-Agent": SEARCH_UA,
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return res.status(502).json({ error: `Bing 返回 HTTP ${r.status}` });

    const html = await r.text();
    const results = parseBingResults(html, Math.min(limit, 15));

    if (results.length === 0) {
      return res.json({ query, results: [], note: "未解析到结果，可能页面结构已变" });
    }
    res.json({ query, results });
  } catch (err) {
    console.error("[search error]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── 网页抓取 ──────────────────────────────────────────────────────────────────
const FETCH_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const MAX_TEXT = 8000; // 返回纯文本最大字符数

function htmlToText(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<head[\s\S]*?<\/head>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|h[1-6]|li|tr|td|th|section|article|header)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

app.post("/fetch-url", async (req, res) => {
  const { url, max_chars = MAX_TEXT } = req.body;
  if (!url) return res.status(400).json({ error: "url required" });

  // 检查是否需要走本地代理（海外域名）
  const proxyUrl = process.env.https_proxy || process.env.http_proxy || "";
  const fetchOptions = {
    headers: {
      "User-Agent": FETCH_UA,
      "Accept": "text/html,application/xhtml+xml,*/*;q=0.9",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
    signal: AbortSignal.timeout(15000),
  };

  try {
    const r = await fetch(url, fetchOptions);
    if (!r.ok) return res.status(502).json({ error: `HTTP ${r.status} ${r.statusText}`, url });

    const contentType = r.headers.get("content-type") || "";
    let text;
    if (contentType.includes("application/json")) {
      text = await r.text();
    } else {
      const html = await r.text();
      text = htmlToText(html);
    }

    const truncated = text.length > max_chars;
    res.json({
      url,
      content: text.slice(0, max_chars),
      truncated,
      total_chars: text.length,
    });
  } catch (err) {
    console.error("[fetch-url error]", url, err.message);
    res.status(500).json({ error: err.message, url });
  }
});

// ── 全网热榜聚合 ──────────────────────────────────────────────────────────────
const HOT_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

async function fetchWeibo(limit = 20) {
  const r = await fetch("https://weibo.com/ajax/side/hotSearch", {
    headers: { "User-Agent": HOT_UA, "Referer": "https://weibo.com/" },
    signal: AbortSignal.timeout(8000),
  });
  const json = await r.json();
  return (json?.data?.realtime || []).slice(0, limit).map((i, idx) => ({
    order: idx + 1,
    title: i.word,
    hot: i.num,
    url: `https://s.weibo.com/weibo?q=${encodeURIComponent("#" + i.word)}`,
  }));
}

async function fetchToutiao(limit = 20) {
  const r = await fetch(
    "https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc",
    {
      headers: { "User-Agent": HOT_UA, "Referer": "https://www.toutiao.com/" },
      signal: AbortSignal.timeout(8000),
    }
  );
  const json = await r.json();
  return (json?.data || []).slice(0, limit).map((i, idx) => ({
    order: idx + 1,
    title: i.Title,
    hot: parseInt(i.HotValue) || 0,
    url: i.Url,
  }));
}

async function fetchBaidu(limit = 20) {
  const r = await fetch(
    "https://top.baidu.com/api/board?platform=wise&tab=realtime",
    {
      headers: { "User-Agent": HOT_UA, "Referer": "https://top.baidu.com/" },
      signal: AbortSignal.timeout(8000),
    }
  );
  const json = await r.json();
  const raw = json?.data?.cards?.[0]?.content?.[0]?.content || [];
  return raw.filter(i => !i.isTop).slice(0, limit).map((i, idx) => ({
    order: idx + 1,
    title: i.word,
    hot: i.hotScore || 0,
    url: i.url,
  }));
}

async function fetchBilibili(limit = 20) {
  const r = await fetch(
    `https://api.bilibili.com/x/web-interface/popular?ps=${Math.min(limit, 20)}&pn=1`,
    {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Referer": "https://www.bilibili.com/",
        "Origin": "https://www.bilibili.com",
      },
      signal: AbortSignal.timeout(8000),
    }
  );
  const json = await r.json();
  return (json?.data?.list || []).slice(0, limit).map((v, idx) => ({
    order: idx + 1,
    title: v.title,
    hot: v.stat?.view || 0,
    url: `https://www.bilibili.com/video/${v.bvid}`,
  }));
}

async function fetchDouyin(limit = 20) {
  const r = await fetch(
    "https://www.iesdouyin.com/web/api/v2/hotsearch/billboard/word/?count=30",
    {
      headers: { "User-Agent": HOT_UA, "Referer": "https://www.douyin.com/" },
      signal: AbortSignal.timeout(8000),
    }
  );
  const json = await r.json();
  return (json?.word_list || []).slice(0, limit).map((i, idx) => ({
    order: idx + 1,
    title: i.word,
    hot: i.hot_value,
    url: `https://www.douyin.com/search/${encodeURIComponent(i.word)}`,
  }));
}

const FETCHERS = { weibo: fetchWeibo, bilibili: fetchBilibili, toutiao: fetchToutiao, baidu: fetchBaidu, douyin: fetchDouyin };

app.post("/hot-topics", async (req, res) => {
  const { platform = "all", limit = 20 } = req.body || {};
  const platforms = platform === "all" ? Object.keys(FETCHERS) : [platform];
  const invalid = platforms.filter(p => !FETCHERS[p]);
  if (invalid.length) {
    return res.status(400).json({ error: `不支持的平台: ${invalid.join(",")}，可选: ${Object.keys(FETCHERS).join(",")}` });
  }

  const results = {};
  await Promise.all(
    platforms.map(async (p) => {
      try {
        results[p] = await FETCHERS[p](limit);
      } catch (err) {
        results[p] = { error: err.message };
      }
    })
  );
  res.json(results);
});

// ── gpt-image-1（Images 2.0）via codex exec ────────────────────────────────────
const CODEX_BIN = process.env.CODEX_PATH || "codex";
const GENERATED_IMAGES_DIR = path.join(os.homedir(), ".codex", "generated_images");

function findNewestImage(since) {
  if (!fs.existsSync(GENERATED_IMAGES_DIR)) return null;
  let newest = null;
  let newestMtime = 0;
  for (const session of fs.readdirSync(GENERATED_IMAGES_DIR)) {
    const sessionDir = path.join(GENERATED_IMAGES_DIR, session);
    try {
      for (const file of fs.readdirSync(sessionDir)) {
        if (!file.endsWith(".png") && !file.endsWith(".jpg") && !file.endsWith(".webp")) continue;
        const full = path.join(sessionDir, file);
        const mtime = fs.statSync(full).mtimeMs;
        if (mtime > since && mtime > newestMtime) {
          newestMtime = mtime;
          newest = full;
        }
      }
    } catch {}
  }
  return newest;
}

app.post("/generate-image", async (req, res) => {
  const { prompt, size = "1024x1024" } = req.body;
  if (!prompt) return res.status(400).json({ error: "prompt required" });

  const sizeHint = size !== "1024x1024" ? ` (size: ${size})` : "";
  const codexPrompt = `Generate an image: ${prompt}${sizeHint}. Only generate the image, do not explain anything.`;

  const startTime = Date.now();
  console.log(`[generate-image] Running codex exec, prompt length=${codexPrompt.length}`);

  try {
    // codex exec runs non-interactively; saves image to ~/.codex/generated_images/
    execSync(`${CODEX_BIN} exec ${JSON.stringify(codexPrompt)}`, {
      encoding: "utf8",
      timeout: 180000,
      env: { ...process.env, PATH: process.env.PATH },
      stdio: "pipe",
    });
  } catch (err) {
    // codex exec may exit non-zero but still generate the image — check for output first
    const output = (err.stdout || "") + (err.stderr || "");
    console.log(`[generate-image] codex exec exited with error (may be OK): ${output.slice(0, 300)}`);
  }

  // Give filesystem a moment to flush
  await new Promise((r) => setTimeout(r, 500));

  const imgPath = findNewestImage(startTime - 2000);
  if (!imgPath) {
    return res.status(500).json({ error: "codex exec 未生成图片文件，请检查 Codex 是否登录并有 ChatGPT Plus" });
  }

  console.log(`[generate-image] Found image: ${imgPath}`);
  const b64 = fs.readFileSync(imgPath).toString("base64");
  res.json({ image_base64: b64, source_path: imgPath });
});

// ── NotebookLM MCP 桥（HTTP 模式，端口 3747）────────────────────────────────
const NLM_PORT = process.env.NOTEBOOKLM_PORT || 3747;
const NLM_URL  = `http://127.0.0.1:${NLM_PORT}/mcp`;
const NLM_HEADERS = {
  "Content-Type": "application/json",
  "Accept": "application/json, text/event-stream",
};

let nlmSessionId = null;

// Parse SSE or plain JSON response
function parseNlmResponse(text) {
  const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
  if (dataLine) {
    try { return JSON.parse(dataLine.slice(6)); } catch {}
  }
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

async function nlmRpc(method, params = {}, id = Date.now()) {
  const headers = { ...NLM_HEADERS };
  if (nlmSessionId) headers["mcp-session-id"] = nlmSessionId;
  const r = await fetch(NLM_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    signal: AbortSignal.timeout(60000),
  });
  const sid = r.headers.get("mcp-session-id");
  if (sid) nlmSessionId = sid;
  return parseNlmResponse(await r.text());
}

async function nlmInit() {
  if (nlmSessionId) return;
  await nlmRpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "lark-proxy", version: "1.0" },
  });
  // fire-and-forget notification
  const headers = { ...NLM_HEADERS };
  if (nlmSessionId) headers["mcp-session-id"] = nlmSessionId;
  fetch(NLM_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => {});
}

async function nlmTool(tool, toolInput) {
  await nlmInit();
  const resp = await nlmRpc("tools/call", { name: tool, arguments: toolInput });
  const raw = resp?.result?.content?.[0]?.text ?? resp?.result ?? resp;
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return raw; }
  }
  return raw;
}

// POST /notebooklm/query — ask a question (optionally with inline sources)
app.post("/notebooklm/query", async (req, res) => {
  const { question, notebook_id, sources = [], session_id } = req.body || {};
  if (!question) return res.status(400).json({ error: "question required" });

  try {
    let notebookId = notebook_id;

    // If no notebook_id, pick first available notebook
    if (!notebookId) {
      const notebooks = await nlmTool("list_notebooks", {});
      const raw = notebooks?.data?.notebooks || notebooks?.notebooks || notebooks;
      const list = Array.isArray(raw) ? raw : [];
      if (list.length === 0) {
        return res.status(400).json({
          error: "NotebookLM 还没有注册笔记本。请先用 notebooklm_add_notebook 工具注册一个 NotebookLM 分享链接，再进行查询。",
          setup_required: true,
        });
      }
      notebookId = list[0].id;
    }

    // Add inline text sources before asking
    for (const src of sources) {
      const addArgs = { source_type: "text", content: String(src) };
      if (notebookId) addArgs.notebook_id = notebookId;
      await nlmTool("add_source", addArgs);
    }

    // Ask the question
    const askArgs = { question };
    if (notebookId) askArgs.notebook_id = notebookId;
    if (session_id)  askArgs.session_id  = session_id;

    const answer = await nlmTool("ask_question", askArgs);
    res.json({ ok: true, answer, notebook_id: notebookId });
  } catch (err) {
    console.error("[notebooklm/query error]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /notebooklm/notebooks — list all notebooks
app.get("/notebooklm/notebooks", async (_req, res) => {
  try {
    const result = await nlmTool("list_notebooks", {});
    res.json({ ok: true, notebooks: Array.isArray(result) ? result : (result?.notebooks || result) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /notebooklm/add_notebook — register a NotebookLM share URL
app.post("/notebooklm/add_notebook", async (req, res) => {
  const { url, name, description } = req.body || {};
  if (!url) return res.status(400).json({ error: "url required (NotebookLM share URL)" });
  try {
    const args = { url };
    if (name)        args.name        = name;
    if (description) args.description = description;
    const result = await nlmTool("add_notebook", args);
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /notebooklm/health — server health + auth status
app.get("/notebooklm/health", async (_req, res) => {
  try {
    const result = await nlmTool("get_health", {});
    res.json({ ok: true, health: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /notebooklm/add_source — add a source to a notebook
app.post("/notebooklm/add_source", async (req, res) => {
  const { notebook_id, source_type = "text", content, url } = req.body || {};
  try {
    const args = { source_type };
    if (notebook_id) args.notebook_id = notebook_id;
    if (content) args.content = content;
    if (url)     args.url     = url;
    const result = await nlmTool("add_source", args);
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 持久记忆存储（为 Railway bot 提供跨部署的对话记忆）────────────────────────
const MEMORY_DIR = path.join(os.homedir(), ".claude", "lark-bot-memory");
fs.mkdirSync(MEMORY_DIR, { recursive: true });

app.get("/memory/:chatId", (req, res) => {
  const file = path.join(MEMORY_DIR, `${req.params.chatId}.json`);
  if (!fs.existsSync(file)) return res.json({ summary: "", keyFacts: [], turnCount: 0 });
  try {
    res.json(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    res.json({ summary: "", keyFacts: [], turnCount: 0 });
  }
});

app.post("/memory/:chatId", (req, res) => {
  const file = path.join(MEMORY_DIR, `${req.params.chatId}.json`);
  try {
    fs.writeFileSync(file, JSON.stringify({ ...req.body, lastUpdated: new Date().toISOString() }, null, 2));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 7788;
app.listen(PORT, () => {
  console.log(`✅ 代理服务启动：http://localhost:${PORT}`);
  console.log(`   支持：lark-cli (POST /exec)  dreamina (POST /dreamina)  热榜 (POST /hot-topics)  notebooklm (POST /notebooklm/query)  记忆 (GET|POST /memory/:chatId)`);
  console.log(`   Secret: ${SECRET}`);
});
