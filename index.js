import "dotenv/config";
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import * as lark from "@larksuiteoapi/node-sdk";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);
const app = express();
app.use(express.json());

const larkClient = new lark.Client({
  appId: process.env.LARK_APP_ID,
  appSecret: process.env.LARK_APP_SECRET,
  appType: lark.AppType.SelfBuild,
  domain: lark.Domain.Feishu,
});

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY ?? "sk-placeholder",
  baseURL: process.env.ANTHROPIC_BASE_URL,
  defaultHeaders: {
    "Authorization": `Bearer ${process.env.ANTHROPIC_API_KEY}`,
  },
});

// 多轮对话历史
const chatHistory = new Map();
// 防重发
const processedMsgIds = new Set();

// lark-cli 工具定义
const tools = [
  {
    name: "execute_lark_cli",
    description:
      "执行 lark-cli 命令来操作飞书，包括查询日历、发送消息、管理任务、搜索用户、操作文档等。",
    input_schema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            "完整的 lark-cli 命令，例如：lark-cli calendar +agenda 或 lark-cli contact +search-user --query '张三'",
        },
      },
      required: ["command"],
    },
  },
];

// 执行 lark-cli 命令
async function runLarkCli(command) {
  // 安全检查：只允许 lark-cli 命令
  if (!command.trim().startsWith("lark-cli")) {
    return "错误：只允许执行 lark-cli 命令";
  }
  try {
    const { stdout, stderr } = await execAsync(command, { timeout: 15000 });
    return stdout || stderr || "命令执行完成，无输出";
  } catch (err) {
    return `执行失败：${err.message}`;
  }
}

// Claude Agent 主逻辑（支持多轮工具调用）
async function runAgent(chatId, userMessage) {
  if (!chatHistory.has(chatId)) chatHistory.set(chatId, []);
  const history = chatHistory.get(chatId);

  history.push({ role: "user", content: userMessage });
  if (history.length > 20) history.splice(0, history.length - 20);

  const systemPrompt = `你是「经纬」，一个智能飞书助手。你可以通过 execute_lark_cli 工具操作飞书，帮用户完成以下任务：

- 查看日程/会议：lark-cli calendar +agenda
- 搜索用户：lark-cli contact +search-user --query "姓名"
- 查看消息：lark-cli im +list-chats
- 管理任务：lark-cli task +list
- 查看审批：lark-cli approval +list
- 搜索文档：lark-cli docs +search --query "关键词"

规则：
1. 优先使用工具获取实时数据，不要凭记忆回答
2. 命令结果用中文简洁总结给用户
3. 如果命令失败，告知用户并给出建议
4. 今天的日期是 ${new Date().toLocaleDateString("zh-CN")}`;

  let messages = [...history];
  let finalReply = "";

  // Agent 循环：支持多次工具调用
  while (true) {
    const response = await anthropic.messages.create({
      model: "pa/claude-sonnet-4-6",
      max_tokens: 2048,
      system: systemPrompt,
      tools,
      messages,
    });

    // 处理工具调用
    if (response.stop_reason === "tool_use") {
      const assistantMsg = { role: "assistant", content: response.content };
      messages.push(assistantMsg);

      const toolResults = [];
      for (const block of response.content) {
        if (block.type === "tool_use") {
          console.log(`[工具调用] ${block.input.command}`);
          const result = await runLarkCli(block.input.command);
          console.log(`[工具结果] ${result.slice(0, 200)}`);
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: result,
          });
        }
      }

      messages.push({ role: "user", content: toolResults });
      continue;
    }

    // 获取最终文本回复
    for (const block of response.content) {
      if (block.type === "text") finalReply += block.text;
    }
    break;
  }

  // 保存最终回复到历史
  history.push({ role: "assistant", content: finalReply });

  return finalReply;
}

// 回复飞书消息
async function replyToLark(messageId, text) {
  await larkClient.im.message.reply({
    path: { message_id: messageId },
    data: {
      msg_type: "text",
      content: JSON.stringify({ text }),
    },
  });
}

// Webhook 入口
app.post("/webhook", async (req, res) => {
  const body = req.body;

  if (body.type === "url_verification") {
    return res.json({ challenge: body.challenge });
  }

  res.json({ code: 0 });

  try {
    const event = body.event;
    if (!event || body.header?.event_type !== "im.message.receive_v1") return;

    const message = event.message;
    const msgId = message.message_id;

    if (processedMsgIds.has(msgId)) return;
    processedMsgIds.add(msgId);
    if (processedMsgIds.size > 1000) {
      processedMsgIds.delete(processedMsgIds.values().next().value);
    }

    if (message.message_type !== "text") return;

    const content = JSON.parse(message.content);
    const userText = content.text.replace(/@[^\s]+\s*/g, "").trim();
    if (!userText) return;

    const chatId = message.chat_id;
    console.log(`[收到] ${chatId}: ${userText}`);

    const reply = await runAgent(chatId, userText);
    console.log(`[回复] ${reply.slice(0, 100)}`);

    await replyToLark(msgId, reply);
  } catch (err) {
    console.error("[错误]", err.message);
  }
});

app.get("/", (req, res) => res.send("Lark Claude Bot is running."));

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`✅ 服务启动：http://localhost:${PORT}`);
  console.log(`📌 Webhook 地址：http://localhost:${PORT}/webhook`);
});
