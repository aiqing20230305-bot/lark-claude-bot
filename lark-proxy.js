/**
 * lark-proxy.js — 本地代理服务器
 * 接收 Railway bot 的请求，在本地执行 lark-cli 命令并返回结果
 * 用 cloudflared 暴露为公网 URL
 */
import express from "express";
import { execSync } from "child_process";

const app = express();
app.use(express.json());

const SECRET = process.env.PROXY_SECRET || "lark-proxy-secret-2026";
const LARK_CLI = process.env.LARK_CLI_PATH || "lark-cli";

// 鉴权中间件
app.use((req, res, next) => {
  if (req.path === "/health") return next();
  if (req.headers["x-proxy-secret"] !== SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

app.get("/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// 执行任意 lark-cli 命令
// POST /exec  { "args": ["api", "GET", "/open-apis/im/v1/chats"] }
app.post("/exec", (req, res) => {
  const { args } = req.body;
  if (!Array.isArray(args) || args.length === 0) {
    return res.status(400).json({ error: "args must be non-empty array" });
  }

  // 安全检查：只允许 lark-cli 子命令
  const allowed = ["api", "calendar", "contact", "im", "task", "docs", "drive", "bitable", "sheets", "wiki", "approval", "schema"];
  if (!allowed.includes(args[0])) {
    return res.status(400).json({ error: `不允许的命令: ${args[0]}` });
  }

  const cmd = [LARK_CLI, ...args.map((a) => JSON.stringify(a))].join(" ");
  console.log(`[exec] ${cmd}`);

  try {
    const output = execSync(cmd, {
      encoding: "utf8",
      timeout: 30000,
      env: { ...process.env, PATH: process.env.PATH },
    });
    try {
      res.json({ output: JSON.parse(output) });
    } catch {
      res.json({ output });
    }
  } catch (err) {
    const stderr = err.stderr?.toString() || "";
    const stdout = err.stdout?.toString() || "";
    console.error(`[error] ${stderr}`);
    res.json({ error: stderr || err.message, output: stdout });
  }
});

const PORT = process.env.PORT || 7788;
app.listen(PORT, () => {
  console.log(`✅ lark-proxy 启动：http://localhost:${PORT}`);
  console.log(`   Secret: ${SECRET}`);
});
