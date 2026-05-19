import "dotenv/config";
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import * as lark from "@larksuiteoapi/node-sdk";

const app = express();
app.use(express.json());

// Bot-level client (for sending messages)
const larkClient = new lark.Client({
  appId: process.env.LARK_APP_ID,
  appSecret: process.env.LARK_APP_SECRET,
  appType: lark.AppType.SelfBuild,
  domain: lark.Domain.Feishu,
});

const anthropic = new Anthropic({
  authToken: process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL,
});

// User token state (refreshed in-memory)
let userAccessToken = process.env.LARK_USER_ACCESS_TOKEN || "";
let userRefreshToken = process.env.LARK_USER_REFRESH_TOKEN || "";
let tokenExpiresAt = 0; // ms

// Refresh user access token using refresh token
async function refreshUserToken() {
  // Step 1: get app_access_token
  const appRes = await fetch("https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      app_id: process.env.LARK_APP_ID,
      app_secret: process.env.LARK_APP_SECRET,
    }),
  });
  const appText = await appRes.text();
  let aat;
  try {
    aat = JSON.parse(appText).app_access_token;
  } catch {
    console.error("[Token] 获取 app_access_token 失败:", appText.slice(0, 200));
    return;
  }

  // Step 2: refresh user token using app_access_token as Bearer
  const res = await fetch("https://open.feishu.cn/open-apis/authen/v2/oidc/refresh_access_token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${aat}`,
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: userRefreshToken,
    }),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    console.error("[Token] 刷新接口返回非 JSON:", text.slice(0, 200));
    return;
  }
  const token = data.data || data;
  if (token.access_token) {
    userAccessToken = token.access_token;
    if (token.refresh_token) userRefreshToken = token.refresh_token;
    tokenExpiresAt = Date.now() + (token.expires_in || 7200) * 1000 - 60000;
    console.log("[Token] 刷新成功，有效期至:", new Date(tokenExpiresAt).toLocaleString("zh-CN"));
  } else {
    console.error("[Token] 刷新失败:", text.slice(0, 300));
  }
}

// Get a valid user access token (auto-refresh if needed)
async function getUserToken() {
  if (!userAccessToken) return null;
  if (Date.now() > tokenExpiresAt) {
    await refreshUserToken();
  }
  return userAccessToken;
}

// User-level Feishu API call
async function userApiCall(path, method = "GET", body = null) {
  const token = await getUserToken();
  if (!token) return { error: "用户未授权，缺少 LARK_USER_ACCESS_TOKEN" };

  const options = {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
  };
  if (body) options.body = JSON.stringify(body);

  try {
    const res = await fetch(`https://open.feishu.cn${path}`, options);
    return await res.json();
  } catch (err) {
    return { error: err.message };
  }
}

// Tool implementations
async function getCalendarEvents(startTime, endTime) {
  // Get primary calendar ID first
  const cals = await userApiCall("/open-apis/calendar/v4/calendars?page_size=10");
  let calendarId = "primary";
  if (cals.data?.calendar_list) {
    const primary = cals.data.calendar_list.find((c) => c.role === "owner" && c.type === "primary");
    if (primary) calendarId = primary.calendar_id;
  }

  const now = new Date();
  const start = startTime || Math.floor(now.setHours(0, 0, 0, 0) / 1000).toString();
  const end = endTime || Math.floor((Date.now() + 7 * 24 * 3600 * 1000) / 1000).toString();

  const data = await userApiCall(
    `/open-apis/calendar/v4/calendars/${calendarId}/events?start_time=${start}&end_time=${end}&page_size=20`
  );
  if (data.data?.items) {
    return data.data.items.map((e) => ({
      summary: e.summary,
      start: e.start_time?.timestamp
        ? new Date(Number(e.start_time.timestamp) * 1000).toLocaleString("zh-CN")
        : e.start_time?.date,
      end: e.end_time?.timestamp
        ? new Date(Number(e.end_time.timestamp) * 1000).toLocaleString("zh-CN")
        : e.end_time?.date,
      attendees: e.attendee_count,
      location: e.location?.name,
    }));
  }
  return data;
}

async function getTasks() {
  const data = await userApiCall("/open-apis/task/v2/tasks?page_size=20&completed=false");
  if (data.data?.items) {
    return data.data.items.map((t) => ({
      title: t.summary,
      due: t.due?.timestamp ? new Date(Number(t.due.timestamp) * 1000).toLocaleDateString("zh-CN") : "无截止日期",
      completed: t.completed_at ? "已完成" : "进行中",
    }));
  }
  return data;
}

async function searchUsers(query) {
  const data = await userApiCall(`/open-apis/search/v1/user?query=${encodeURIComponent(query)}&page_size=10`);
  if (data.data?.users) {
    return data.data.users.map((u) => ({
      name: u.name,
      email: u.email,
      department: u.department_name,
    }));
  }
  return data;
}

async function searchDocs(query) {
  const data = await userApiCall(
    `/open-apis/suite/docs-api/search/object?query=${encodeURIComponent(query)}&page_size=10&search_type=doc`
  );
  if (data.data?.docs_entities) {
    return data.data.docs_entities.map((d) => ({
      title: d.title,
      type: d.obj_type,
      url: d.url,
    }));
  }
  return data;
}

async function getChats() {
  const data = await userApiCall("/open-apis/im/v1/chats?page_size=20");
  if (data.data?.items) {
    return data.data.items.map((c) => ({
      name: c.name,
      type: c.chat_type,
      id: c.chat_id,
    }));
  }
  return data;
}

async function sendMessage(chatId, text) {
  const data = await userApiCall("/open-apis/im/v1/messages?receive_id_type=chat_id", "POST", {
    receive_id: chatId,
    msg_type: "text",
    content: JSON.stringify({ text }),
  });
  return data.code === 0 ? "消息发送成功" : `发送失败: ${data.msg}`;
}

// Tool definitions for Claude
const tools = [
  {
    name: "get_calendar_events",
    description: "获取用户的日历事件/日程安排。可以查看今天、本周或指定时间范围的会议和日程。",
    input_schema: {
      type: "object",
      properties: {
        start_timestamp: { type: "string", description: "开始时间的 Unix 时间戳（秒），不填默认今天0点" },
        end_timestamp: { type: "string", description: "结束时间的 Unix 时间戳（秒），不填默认7天后" },
      },
    },
  },
  {
    name: "get_tasks",
    description: "获取用户的飞书任务列表，包括未完成的任务和截止日期。",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "search_users",
    description: "在飞书通讯录中搜索用户/同事信息，包括姓名、邮箱、部门。",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索关键词，可以是姓名、邮箱等" },
      },
      required: ["query"],
    },
  },
  {
    name: "search_docs",
    description: "在飞书云文档中搜索文档内容。",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索关键词" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_chats",
    description: "获取用户加入的飞书群聊列表。",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "send_message",
    description: "向指定飞书群聊发送消息。",
    input_schema: {
      type: "object",
      properties: {
        chat_id: { type: "string", description: "群聊 ID（从 get_chats 获取）" },
        text: { type: "string", description: "消息内容" },
      },
      required: ["chat_id", "text"],
    },
  },
];

// Execute a tool call
async function executeTool(name, input) {
  switch (name) {
    case "get_calendar_events":
      return JSON.stringify(await getCalendarEvents(input.start_timestamp, input.end_timestamp));
    case "get_tasks":
      return JSON.stringify(await getTasks());
    case "search_users":
      return JSON.stringify(await searchUsers(input.query));
    case "search_docs":
      return JSON.stringify(await searchDocs(input.query));
    case "get_chats":
      return JSON.stringify(await getChats());
    case "send_message":
      return await sendMessage(input.chat_id, input.text);
    default:
      return `未知工具: ${name}`;
  }
}

// Multi-turn conversation history per chat
const chatHistory = new Map();
const processedMsgIds = new Set();

// Claude Agent loop
async function runAgent(chatId, userMessage) {
  if (!chatHistory.has(chatId)) chatHistory.set(chatId, []);
  const history = chatHistory.get(chatId);

  history.push({ role: "user", content: userMessage });
  if (history.length > 20) history.splice(0, history.length - 20);

  const systemPrompt = `你是「经纬」，一个智能飞书助手。你可以通过工具操作飞书，帮用户完成任务：

- 查看日程/会议：get_calendar_events
- 查看待办任务：get_tasks
- 搜索用户：search_users
- 搜索文档：search_docs
- 查看群聊：get_chats
- 发送消息：send_message

规则：
1. 优先使用工具获取实时数据，不要凭记忆回答
2. 工具结果用中文简洁总结给用户
3. 如果工具失败，告知用户并给出建议
4. 今天的日期是 ${new Date().toLocaleDateString("zh-CN")}`;

  let messages = [...history];
  let finalReply = "";

  while (true) {
    const response = await anthropic.messages.create({
      model: "pa/claude-sonnet-4-6",
      max_tokens: 2048,
      system: systemPrompt,
      tools,
      messages,
    });

    if (response.stop_reason === "tool_use") {
      const assistantMsg = { role: "assistant", content: response.content };
      messages.push(assistantMsg);

      const toolResults = [];
      for (const block of response.content) {
        if (block.type === "tool_use") {
          console.log(`[工具] ${block.name}(${JSON.stringify(block.input)})`);
          const result = await executeTool(block.name, block.input);
          console.log(`[结果] ${result.slice(0, 200)}`);
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

    for (const block of response.content) {
      if (block.type === "text") finalReply += block.text;
    }
    break;
  }

  history.push({ role: "assistant", content: finalReply });
  return finalReply;
}

// Reply to a Feishu message
async function replyToLark(messageId, text) {
  await larkClient.im.message.reply({
    path: { message_id: messageId },
    data: {
      msg_type: "text",
      content: JSON.stringify({ text }),
    },
  });
}

// Webhook handler
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

process.on("unhandledRejection", (reason) => {
  console.error("[UnhandledRejection]", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[UncaughtException]", err.message);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ 服务启动：http://localhost:${PORT}`);
  // Async startup without blocking the server
  (async () => {
    try {
      if (userRefreshToken) {
        await refreshUserToken();
      } else if (userAccessToken) {
        console.log("✅ 用户 access token 已加载（无 refresh token，不会自动续期）");
        tokenExpiresAt = Date.now() + 3600 * 1000;
      } else {
        console.log("⚠️  未配置用户 token，用户级功能不可用");
      }
    } catch (err) {
      console.error("[启动 Token 刷新失败]", err.message);
    }
  })();
});
