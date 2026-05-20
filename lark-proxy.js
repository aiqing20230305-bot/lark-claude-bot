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
  services: ["lark-cli", "dreamina", "extract-audio"],
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

const PORT = process.env.PORT || 7788;
app.listen(PORT, () => {
  console.log(`✅ 代理服务启动：http://localhost:${PORT}`);
  console.log(`   支持：lark-cli (POST /exec)  dreamina (POST /dreamina)`);
  console.log(`   Secret: ${SECRET}`);
});
