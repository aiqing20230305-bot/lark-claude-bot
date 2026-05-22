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

  // Step 2: try v1 endpoint first, then v2
  const endpoints = [
    {
      url: "https://open.feishu.cn/open-apis/authen/v1/refresh_access_token",
      body: { app_access_token: aat, grant_type: "refresh_token", refresh_token: userRefreshToken },
      headers: { "Content-Type": "application/json" },
    },
    {
      url: "https://open.feishu.cn/open-apis/authen/v2/oidc/refresh_access_token",
      body: { grant_type: "refresh_token", refresh_token: userRefreshToken },
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${aat}` },
    },
  ];

  for (const ep of endpoints) {
    const res = await fetch(ep.url, { method: "POST", headers: ep.headers, body: JSON.stringify(ep.body) });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      console.error(`[Token] ${ep.url} 返回非 JSON:`, text.slice(0, 100));
      continue;
    }
    const token = data.data || data;
    if (token.access_token) {
      userAccessToken = token.access_token;
      if (token.refresh_token) userRefreshToken = token.refresh_token;
      tokenExpiresAt = Date.now() + (token.expires_in || 7200) * 1000 - 60000;
      console.log("[Token] 刷新成功，有效期至:", new Date(tokenExpiresAt).toLocaleString("zh-CN"));
      return;
    }
    console.error(`[Token] ${ep.url} 刷新失败:`, text.slice(0, 200));
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
async function botApiCall(path, method = "GET", body = null) {
  const args = ["api", method, path, "--as", "bot"];
  if (body) args.push("--data", JSON.stringify(body));
  return larkProxyExec(args);
}

async function userApiCall(path, method = "GET", body = null) {
  // Prefer proxy (lark-cli handles token internally, never expires on Railway)
  const proxyUrl = process.env.LARK_PROXY_URL;
  if (proxyUrl) {
    const args = ["api", method, path, "--as", "user"];
    if (body) args.push("--data", JSON.stringify(body));
    return larkProxyExec(args);
  }

  // Fallback: direct call with stored token
  const token = await getUserToken();
  if (!token) return { error: "用户未授权，且本地代理不可用" };

  const options = {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  };
  if (body) options.body = JSON.stringify(body);

  try {
    const res = await fetch(`https://open.feishu.cn${path}`, options);
    return await res.json();
  } catch (err) {
    return { error: err.message };
  }
}

// ── App access token (for downloading resources & ASR) ───────────────────────
let _appToken = "";
let _appTokenExpiry = 0;

async function getAppToken() {
  if (_appToken && Date.now() < _appTokenExpiry) return _appToken;
  const res = await fetch("https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: process.env.LARK_APP_ID, app_secret: process.env.LARK_APP_SECRET }),
  });
  const data = await res.json();
  _appToken = data.app_access_token;
  _appTokenExpiry = Date.now() + ((data.expire || 7200) - 60) * 1000;
  return _appToken;
}

// Download a message resource (image / file) as Buffer
async function downloadResource(messageId, fileKey, type) {
  const token = await getAppToken();
  const res = await fetch(
    `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${fileKey}?type=${type}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

// Feishu file speech-to-text (ogg_opus / pcm / wav)
async function feishuASR(audioBuffer, format = "ogg_opus") {
  const token = await getAppToken();
  const res = await fetch("https://open.feishu.cn/open-apis/speech_to_text/v1/speech/file_recognize", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      speech: { speech: audioBuffer.toString("base64") },
      config: { file_id: `asr_${Date.now()}`, format, engine_type: "16k_0" },
    }),
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`ASR error ${data.code}: ${data.msg}`);
  return data.data?.recognition_text || "";
}

// Transcribe audio buffer — prefers local Whisper via proxy, falls back to Feishu ASR
async function transcribeAudio(audioBuffer, feishuFormat = "ogg_opus") {
  const proxyUrl = process.env.LARK_PROXY_URL;
  if (proxyUrl) {
    const res = await fetch(`${proxyUrl}/transcribe`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-proxy-secret": process.env.PROXY_SECRET || "lark-proxy-secret-2026",
      },
      body: JSON.stringify({ audio_base64: audioBuffer.toString("base64") }),
      signal: AbortSignal.timeout(120000),
    });
    const data = await res.json();
    if (data.transcript !== undefined) return data.transcript;
    throw new Error(data.error || "proxy transcribe failed");
  }
  // Fallback: Feishu official ASR
  return feishuASR(audioBuffer, feishuFormat);
}

// Build Claude content blocks for image message
async function processImageMessage(message) {
  const { image_key } = JSON.parse(message.content);
  const buf = await downloadResource(message.message_id, image_key, "image");
  return [
    { type: "text", text: "用户发送了一张图片：" },
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: buf.toString("base64") } },
  ];
}

// Build text content for audio message
async function processAudioMessage(message) {
  const { file_key, duration } = JSON.parse(message.content);
  const buf = await downloadResource(message.message_id, file_key, "file");
  const sec = Math.round((duration || 0) / 1000);
  try {
    const transcript = await transcribeAudio(buf, "ogg_opus");
    return `[语音消息，时长 ${sec} 秒]\n转写内容：${transcript}`;
  } catch (e) {
    return `[语音消息，时长 ${sec} 秒，转写失败：${e.message}]`;
  }
}

// Build Claude content blocks for video message (thumbnail + audio transcript)
async function processVideoMessage(message) {
  const { file_key, image_key, duration, file_name } = JSON.parse(message.content);
  const sec = Math.round((duration || 0) / 1000);
  const blocks = [];

  // Thumbnail → Claude vision
  try {
    const thumbBuf = await downloadResource(message.message_id, image_key, "image");
    blocks.push({ type: "text", text: `用户发送了一个视频（${file_name || "video"}，时长 ${sec} 秒），封面如下：` });
    blocks.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: thumbBuf.toString("base64") } });
  } catch (e) {
    blocks.push({ type: "text", text: `用户发送了一个视频（${file_name || "video"}，时长 ${sec} 秒）` });
    console.error("[视频封面下载失败]", e.message);
  }

  // Audio extraction via local proxy → Feishu ASR
  const proxyUrl = process.env.LARK_PROXY_URL;
  if (proxyUrl) {
    try {
      const videoBuf = await downloadResource(message.message_id, file_key, "file");
      const proxyRes = await fetch(`${proxyUrl}/extract-audio`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-proxy-secret": process.env.PROXY_SECRET || "lark-proxy-secret-2026",
        },
        body: JSON.stringify({ video_base64: videoBuf.toString("base64") }),
        signal: AbortSignal.timeout(90000),
      });
      const { audio_base64, format, error } = await proxyRes.json();
      if (error) throw new Error(error);
      if (audio_base64) {
        const transcript = await transcribeAudio(Buffer.from(audio_base64, "base64"), format || "ogg_opus");
        if (transcript) blocks.push({ type: "text", text: `视频音频转写：${transcript}` });
      }
    } catch (e) {
      console.error("[视频音频提取失败]", e.message);
      blocks.push({ type: "text", text: "（视频音频转写失败）" });
    }
  } else {
    blocks.push({ type: "text", text: "（本地代理未连接，跳过音频转写）" });
  }

  return blocks;
}

// dreamina proxy call
async function dreaminaExec(args) {
  const proxyUrl = process.env.LARK_PROXY_URL;
  if (!proxyUrl) return { error: "未配置 LARK_PROXY_URL" };
  try {
    const res = await fetch(`${proxyUrl}/dreamina`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-proxy-secret": process.env.LARK_PROXY_SECRET || "lark-proxy-secret-2026",
      },
      body: JSON.stringify({ args }),
    });
    return await res.json();
  } catch (err) {
    return { error: `代理连接失败: ${err.message}` };
  }
}

// lark-proxy call (local Mac tunnel)
async function larkProxyExec(args) {
  const proxyUrl = process.env.LARK_PROXY_URL;
  if (!proxyUrl) return { error: "未配置 LARK_PROXY_URL，请先启动本地代理并设置环境变量" };

  try {
    const res = await fetch(`${proxyUrl}/exec`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-proxy-secret": process.env.LARK_PROXY_SECRET || "lark-proxy-secret-2026",
      },
      body: JSON.stringify({ args }),
    });
    return await res.json();
  } catch (err) {
    return { error: `代理连接失败: ${err.message}` };
  }
}

// Atypica hot trend proxy call
async function atypicaExec(args) {
  const proxyUrl = process.env.LARK_PROXY_URL;
  if (!proxyUrl) return { error: "未配置 LARK_PROXY_URL，请先启动本地代理" };

  try {
    const res = await fetch(`${proxyUrl}/atypica`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-proxy-secret": process.env.LARK_PROXY_SECRET || "lark-proxy-secret-2026",
      },
      body: JSON.stringify({ args }),
    });
    return await res.json();
  } catch (err) {
    return { error: `Atypica 代理连接失败: ${err.message}` };
  }
}

// Chinese hot topics via local proxy
async function hotTopicsExec(platform = "all", limit = 20) {
  const proxyUrl = process.env.LARK_PROXY_URL;
  if (!proxyUrl) return { error: "未配置 LARK_PROXY_URL，请先启动本地代理" };

  try {
    const res = await fetch(`${proxyUrl}/hot-topics`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-proxy-secret": process.env.LARK_PROXY_SECRET || "lark-proxy-secret-2026",
      },
      body: JSON.stringify({ platform, limit }),
    });
    return await res.json();
  } catch (err) {
    return { error: `热榜代理连接失败: ${err.message}` };
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

async function getMessages(chatId, pageSize = 20) {
  const data = await userApiCall(
    `/open-apis/im/v1/messages?container_id_type=chat&container_id=${chatId}&page_size=${pageSize}&sort_type=ByCreateTimeDesc`
  );
  if (data.data?.items) {
    return data.data.items.map((m) => {
      let content = m.body?.content || "";
      try { content = JSON.parse(content).text || content; } catch {}
      return {
        sender: m.sender?.id,
        time: new Date(Number(m.create_time)).toLocaleString("zh-CN"),
        content: content.slice(0, 300),
        type: m.msg_type,
      };
    });
  }
  return data;
}

async function sendDirectMessage(openId, text) {
  const data = await userApiCall("/open-apis/im/v1/messages?receive_id_type=open_id", "POST", {
    receive_id: openId,
    msg_type: "text",
    content: JSON.stringify({ text }),
  });
  return data.code === 0 ? "消息发送成功" : `发送失败: ${data.msg}`;
}

async function getPrimaryCalendarId() {
  const cals = await userApiCall("/open-apis/calendar/v4/calendars?page_size=10");
  if (cals.data?.calendar_list) {
    const primary = cals.data.calendar_list.find((c) => c.role === "owner" && c.type === "primary");
    if (primary) return primary.calendar_id;
  }
  return "primary";
}

async function createCalendarEvent(summary, startTimestamp, endTimestamp, description, location) {
  const calId = await getPrimaryCalendarId();
  const body = {
    summary,
    start_time: { timestamp: startTimestamp },
    end_time: { timestamp: endTimestamp },
  };
  if (description) body.description = description;
  if (location) body.location = { name: location };
  const data = await userApiCall(`/open-apis/calendar/v4/calendars/${calId}/events`, "POST", body);
  if (data.data?.event) {
    return { success: true, event_id: data.data.event.event_id, summary: data.data.event.summary };
  }
  return data;
}

async function updateCalendarEvent(eventId, summary, startTimestamp, endTimestamp, description) {
  const calId = await getPrimaryCalendarId();
  const body = {};
  if (summary) body.summary = summary;
  if (startTimestamp) body.start_time = { timestamp: startTimestamp };
  if (endTimestamp) body.end_time = { timestamp: endTimestamp };
  if (description) body.description = description;
  const data = await userApiCall(`/open-apis/calendar/v4/calendars/${calId}/events/${eventId}`, "PATCH", body);
  return data.code === 0 ? "日程更新成功" : `更新失败: ${data.msg}（${JSON.stringify(data).slice(0, 100)}）`;
}

async function createTask(title, dueTimestamp, description) {
  const body = { summary: title };
  if (dueTimestamp) body.due = { timestamp: dueTimestamp };
  if (description) body.description = { mode: 1, text: description };
  const data = await userApiCall("/open-apis/task/v2/tasks", "POST", body);
  if (data.data?.task) {
    return { success: true, task_id: data.data.task.guid, title: data.data.task.summary };
  }
  return data;
}

async function updateTask(taskId, completed, title) {
  const body = {};
  if (title) body.summary = title;
  if (completed) body.completed_at = Date.now().toString();
  const data = await userApiCall(`/open-apis/task/v2/tasks/${taskId}`, "PATCH", body);
  return data.code === 0 ? "任务更新成功" : `更新失败: ${data.msg}`;
}

async function getDocContent(docToken) {
  const data = await userApiCall(`/open-apis/docx/v1/documents/${docToken}/raw_content`);
  if (data.data?.content) return data.data.content.slice(0, 4000);
  return JSON.stringify(data);
}

async function createDoc(title, folderToken) {
  const body = { title };
  if (folderToken) body.folder_token = folderToken;
  const data = await userApiCall("/open-apis/docx/v1/documents", "POST", body);
  if (data.data?.document) {
    return { success: true, doc_token: data.data.document.document_id, url: data.data.document.url };
  }
  return data;
}

async function getPrivateMessages(nameOrOpenId, pageSize = 20) {
  // List all p2p chats
  const data = await userApiCall("/open-apis/im/v1/chats?chat_type=p2p&page_size=50");
  if (!data.data?.items) return data;

  // Find the matching chat by name
  const chat = data.data.items.find(
    (c) => c.name?.includes(nameOrOpenId) || c.chat_id?.includes(nameOrOpenId)
  );
  if (!chat) return `未找到与「${nameOrOpenId}」的私聊，可用 get_chats 查看所有会话`;

  return await getMessages(chat.chat_id, pageSize);
}

async function searchMessages(query, pageSize = 20) {
  const data = await userApiCall(
    `/open-apis/im/v1/messages/search?query=${encodeURIComponent(query)}&page_size=${pageSize}`
  );
  if (data.data?.items) {
    return data.data.items.map((m) => {
      let content = m.body?.content || "";
      try { content = JSON.parse(content).text || content; } catch {}
      return {
        chat_id: m.chat_id,
        sender: m.sender?.id,
        time: new Date(Number(m.create_time)).toLocaleString("zh-CN"),
        content: content.slice(0, 300),
      };
    });
  }
  return data;
}

async function getDepartmentMembers(departmentId) {
  const data = await userApiCall(
    `/open-apis/contact/v3/users?department_id=${departmentId}&page_size=20&user_id_type=open_id`
  );
  if (data.data?.items) {
    return data.data.items.map((u) => ({
      name: u.name,
      email: u.email,
      open_id: u.open_id,
      title: u.job_title,
    }));
  }
  return data;
}

// ── Message management ──────────────────────────────────────────────────────

async function deleteMessage(messageId) {
  const data = await userApiCall(`/open-apis/im/v1/messages/${messageId}`, "DELETE");
  return data.code === 0 ? "消息已删除" : `删除失败: ${data.msg}`;
}

async function getChatMembers(chatId) {
  const data = await userApiCall(`/open-apis/im/v1/chats/${chatId}/members?page_size=50`);
  if (data.data?.items) {
    return data.data.items.map((m) => ({ name: m.name, open_id: m.member_id }));
  }
  return data;
}

async function pinMessage(chatId, messageId) {
  const data = await userApiCall("/open-apis/im/v1/pins", "POST", { message_id: messageId });
  return data.code === 0 ? "消息已置顶" : `置顶失败: ${data.msg}`;
}

async function addReaction(messageId, reactionType) {
  const data = await userApiCall(`/open-apis/im/v1/messages/${messageId}/reactions`, "POST", {
    reaction_type: { emoji_type: reactionType },
  });
  return data.code === 0 ? "表情回应已添加" : `失败: ${data.msg}`;
}

async function forwardMessage(messageId, chatId) {
  const data = await userApiCall(`/open-apis/im/v1/messages/${messageId}/forward`, "POST", {
    receive_id: chatId,
    receive_id_type: "chat_id",
  });
  return data.code === 0 ? "消息已转发" : `转发失败: ${data.msg}`;
}

// ── Group management ─────────────────────────────────────────────────────────

async function createGroup(name, openIds = []) {
  const body = { name, chat_type: "group" };
  if (openIds.length) body.user_id_list = openIds;
  const data = await userApiCall("/open-apis/im/v1/chats", "POST", body);
  if (data.data?.chat_id) return { success: true, chat_id: data.data.chat_id, name: data.data.name };
  return data;
}

async function addGroupMember(chatId, openIds) {
  const data = await userApiCall(`/open-apis/im/v1/chats/${chatId}/members`, "POST", {
    id_list: openIds,
    member_id_type: "open_id",
  });
  return data.code === 0 ? "成员添加成功" : `添加失败: ${data.msg}`;
}

async function updateGroupInfo(chatId, name, description) {
  const body = {};
  if (name) body.name = name;
  if (description) body.description = description;
  const data = await userApiCall(`/open-apis/im/v1/chats/${chatId}`, "PUT", body);
  return data.code === 0 ? "群信息已更新" : `更新失败: ${data.msg}`;
}

// ── Calendar ─────────────────────────────────────────────────────────────────

async function deleteCalendarEvent(eventId) {
  const calId = await getPrimaryCalendarId();
  const data = await userApiCall(`/open-apis/calendar/v4/calendars/${calId}/events/${eventId}`, "DELETE");
  return data.code === 0 ? "日程已删除" : `删除失败: ${data.msg}`;
}

// ── Tasks ─────────────────────────────────────────────────────────────────────

async function deleteTask(taskId) {
  const data = await userApiCall(`/open-apis/task/v2/tasks/${taskId}`, "DELETE");
  return data.code === 0 ? "任务已删除" : `删除失败: ${data.msg}`;
}

// ── Documents & Wiki ─────────────────────────────────────────────────────────

async function appendDocContent(docToken, content) {
  const data = await userApiCall(`/open-apis/docx/v1/documents/${docToken}/blocks/batch_update`, "PATCH", {
    requests: [{
      block_id: docToken,
      update_block: {
        block_type: 2,
        text: { elements: [{ text_run: { content } }] },
      },
    }],
  });
  return data.code === 0 ? "内容已追加" : `追加失败: ${data.msg}`;
}

async function searchWiki(query) {
  const data = await userApiCall(
    `/open-apis/wiki/v1/nodes/search?query=${encodeURIComponent(query)}&page_size=10`
  );
  if (data.data?.items) {
    return data.data.items.map((n) => ({ title: n.title, url: n.url, node_token: n.node_token }));
  }
  return data;
}

async function getWikiContent(spaceId, nodeToken) {
  const data = await userApiCall(`/open-apis/wiki/v2/spaces/${spaceId}/nodes/${nodeToken}`);
  if (data.data?.node) {
    const node = data.data.node;
    // Read actual doc content if it's a docx node
    if (node.obj_type === "docx" && node.obj_token) {
      return await getDocContent(node.obj_token);
    }
    return { title: node.title, type: node.obj_type, token: node.obj_token };
  }
  return data;
}

// ── Bitable (多维表格) ───────────────────────────────────────────────────────

async function getBitableTables(appToken) {
  const data = await botApiCall(`/open-apis/bitable/v1/apps/${appToken}/tables?page_size=20`);
  if (data.data?.items) {
    return data.data.items.map((t) => ({ name: t.name, table_id: t.table_id }));
  }
  return data;
}

async function getBitableRecords(appToken, tableId, pageSize = 20) {
  const data = await botApiCall(
    `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records?page_size=${pageSize}`
  );
  if (data.data?.items) {
    return data.data.items.map((r) => ({ record_id: r.record_id, fields: r.fields }));
  }
  return data;
}

async function createBitableRecord(appToken, tableId, fields) {
  const data = await botApiCall(
    `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`,
    "POST",
    { fields }
  );
  if (data.data?.record) return { success: true, record_id: data.data.record.record_id };
  return data;
}

async function updateBitableRecord(appToken, tableId, recordId, fields) {
  const data = await botApiCall(
    `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`,
    "PUT",
    { fields }
  );
  return data.code === 0 ? "记录更新成功" : `更新失败: ${data.msg}`;
}

async function deleteBitableRecord(appToken, tableId, recordId) {
  const data = await botApiCall(
    `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`,
    "DELETE"
  );
  return data.code === 0 ? "记录已删除" : `删除失败: ${data.msg}`;
}

// ── Spreadsheets ─────────────────────────────────────────────────────────────

async function getSheetValues(spreadsheetToken, range) {
  const data = await userApiCall(
    `/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values/${encodeURIComponent(range)}`
  );
  if (data.data?.valueRange) return data.data.valueRange;
  return data;
}

async function updateSheetValues(spreadsheetToken, range, values) {
  const data = await userApiCall(
    `/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values`,
    "PUT",
    { valueRange: { range, values } }
  );
  return data.code === 0 ? "表格已更新" : `更新失败: ${data.msg}`;
}

// ── Drive / Files ─────────────────────────────────────────────────────────────

async function listFiles(folderToken) {
  const url = folderToken
    ? `/open-apis/drive/v1/files?folder_token=${folderToken}&page_size=20`
    : `/open-apis/drive/v1/files?page_size=20`;
  const data = await userApiCall(url);
  if (data.data?.files) {
    return data.data.files.map((f) => ({
      name: f.name,
      type: f.type,
      token: f.token,
      url: f.url,
      created: new Date(Number(f.created_time) * 1000).toLocaleString("zh-CN"),
    }));
  }
  return data;
}

async function moveFile(fileToken, folderToken) {
  const data = await userApiCall(`/open-apis/drive/v1/files/${fileToken}/move`, "POST", {
    type: "file",
    folder_token: folderToken,
  });
  return data.code === 0 ? "文件已移动" : `移动失败: ${data.msg}`;
}

// ── Contacts ──────────────────────────────────────────────────────────────────

async function getUserDetail(openId) {
  const data = await userApiCall(`/open-apis/contact/v3/users/${openId}?user_id_type=open_id`);
  if (data.data?.user) {
    const u = data.data.user;
    return { name: u.name, email: u.email, mobile: u.mobile, open_id: u.open_id, job_title: u.job_title, department_ids: u.department_ids };
  }
  return data;
}

async function getDepartments(parentDepartmentId) {
  const url = parentDepartmentId
    ? `/open-apis/contact/v3/departments?parent_department_id=${parentDepartmentId}&page_size=20`
    : `/open-apis/contact/v3/departments?fetch_child=true&page_size=20`;
  const data = await userApiCall(url);
  if (data.data?.items) {
    return data.data.items.map((d) => ({ name: d.name, department_id: d.department_id, leader_user_id: d.leader_user_id }));
  }
  return data;
}

// ── Approval ──────────────────────────────────────────────────────────────────

async function getApprovalInstances(approvalCode, pageSize = 20) {
  const data = await userApiCall(
    `/open-apis/approval/v4/instances?approval_code=${approvalCode}&page_size=${pageSize}`
  );
  if (data.data?.instance_code_list) return data.data.instance_code_list;
  return data;
}

async function getApprovalInstanceDetail(instanceCode) {
  const data = await userApiCall(`/open-apis/approval/v4/instances/${instanceCode}`);
  if (data.data) {
    const d = data.data;
    return { status: d.status, start_time: new Date(Number(d.start_time)).toLocaleString("zh-CN"), form: d.form, task_list: d.task_list };
  }
  return data;
}

// Tool definitions for Claude
const tools = [
  {
    name: "run_dreamina",
    description: `调用本地即梦(Dreamina) CLI 生成图片或视频，以及查询任务状态。
支持的命令：
- 文生图: args=["text2image","--prompt","一只猫","--ratio","1:1","--resolution_type","2k"]
- 文生视频: args=["text2video","--prompt","海浪翻滚"]
- 图生视频: args=["image2video","--image_url","https://...","--prompt","描述"]
- 查询任务: args=["query_result","--submit_id","任务ID"]
- 任务列表: args=["list_task","--gen_status","success"]
- 账户余额: args=["user_credit"]
注意：生成任务是异步的，先提交得到 submit_id，再用 query_result 查询结果。`,
    input_schema: {
      type: "object",
      properties: {
        args: {
          type: "array",
          items: { type: "string" },
          description: "dreamina 命令参数，不含 'dreamina' 本身",
        },
      },
      required: ["args"],
    },
  },
  {
    name: "run_lark_cli",
    description: `通过本地 lark-cli 执行任意飞书操作，权限最完整、token 自动管理。
用法示例：
- 读聊天记录: args=["api","GET","/open-apis/im/v1/messages","--params","{\"container_id_type\":\"chat\",\"container_id\":\"oc_xxx\"}"]
- 搜索用户: args=["contact","+search-user","--query","张三"]
- 查日历: args=["calendar","+agenda"]
- 任意API: args=["api","POST","/open-apis/xxx","--data","{...}"]
优先使用此工具，仅在代理不可用时降级到其他工具。`,
    input_schema: {
      type: "object",
      properties: {
        args: {
          type: "array",
          items: { type: "string" },
          description: "lark-cli 命令参数列表，不含 'lark-cli' 本身，如 [\"api\",\"GET\",\"/open-apis/im/v1/chats\"]",
        },
      },
      required: ["args"],
    },
  },
  {
    name: "run_atypica",
    description: `查询 Atypica 全球热点趋势数据。
支持的命令：
- 热点列表: args=["pulse","list","--limit","10","--order-by","heatScore"]
- 按分类筛选: args=["pulse","list","--category","AI Tech","--limit","10"]
- 英文热点（当前仅支持 en-US）: args=["pulse","list","--locale","en-US","--limit","10"]
- 热点详情: args=["pulse","get","<id>"]
- 获取分类: args=["pulse","categories"]
注意：locale 目前仅支持 en-US，zh-CN 暂不可用。
返回 JSON 数据，包含 title、content（趋势分析）、heatScore、category、locale 等字段。`,
    input_schema: {
      type: "object",
      properties: {
        args: {
          type: "array",
          items: { type: "string" },
          description: "atypica 命令参数，如 [\"pulse\",\"list\",\"--limit\",\"5\"]",
        },
      },
      required: ["args"],
    },
  },
  {
    name: "get_hot_topics",
    description: `获取国内各大平台的实时热榜。支持平台：
- weibo: 微博热搜
- bilibili: B站热门
- toutiao: 今日头条热榜
- baidu: 百度热搜
- douyin: 抖音热点
- all: 所有平台同时获取
返回各平台 top N 热门话题，包含标题、热度值和链接。`,
    input_schema: {
      type: "object",
      properties: {
        platform: {
          type: "string",
          description: "平台名称：weibo / bilibili / toutiao / baidu / douyin / all",
          enum: ["weibo", "bilibili", "toutiao", "baidu", "douyin", "all"],
        },
        limit: {
          type: "number",
          description: "每平台返回条数，默认 20，最多 50",
        },
      },
    },
  },
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
  {
    name: "get_messages",
    description: "获取指定飞书群聊的历史消息记录。",
    input_schema: {
      type: "object",
      properties: {
        chat_id: { type: "string", description: "群聊 ID（从 get_chats 获取）" },
        page_size: { type: "number", description: "获取条数，默认 20" },
      },
      required: ["chat_id"],
    },
  },
  {
    name: "send_direct_message",
    description: "给飞书用户发送私信（需要 open_id，可从 search_users 获取）。",
    input_schema: {
      type: "object",
      properties: {
        open_id: { type: "string", description: "用户 open_id" },
        text: { type: "string", description: "消息内容" },
      },
      required: ["open_id", "text"],
    },
  },
  {
    name: "create_calendar_event",
    description: "在飞书日历中创建新的日程/会议。",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "日程标题" },
        start_timestamp: { type: "string", description: "开始时间 Unix 时间戳（秒）" },
        end_timestamp: { type: "string", description: "结束时间 Unix 时间戳（秒）" },
        description: { type: "string", description: "日程描述（可选）" },
        location: { type: "string", description: "地点（可选）" },
      },
      required: ["summary", "start_timestamp", "end_timestamp"],
    },
  },
  {
    name: "update_calendar_event",
    description: "修改飞书日历中已有的日程。",
    input_schema: {
      type: "object",
      properties: {
        event_id: { type: "string", description: "日程 ID" },
        summary: { type: "string", description: "新标题（可选）" },
        start_timestamp: { type: "string", description: "新开始时间（可选）" },
        end_timestamp: { type: "string", description: "新结束时间（可选）" },
        description: { type: "string", description: "新描述（可选）" },
      },
      required: ["event_id"],
    },
  },
  {
    name: "create_task",
    description: "在飞书任务中创建新的待办任务。",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "任务标题" },
        due_timestamp: { type: "string", description: "截止时间 Unix 时间戳（毫秒，可选）" },
        description: { type: "string", description: "任务描述（可选）" },
      },
      required: ["title"],
    },
  },
  {
    name: "update_task",
    description: "更新飞书任务状态（完成/修改标题）。",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "任务 ID（从 get_tasks 获取）" },
        completed: { type: "boolean", description: "是否标记为完成" },
        title: { type: "string", description: "新标题（可选）" },
      },
      required: ["task_id"],
    },
  },
  {
    name: "get_doc_content",
    description: "读取飞书云文档的文本内容。",
    input_schema: {
      type: "object",
      properties: {
        doc_token: { type: "string", description: "文档 token（URL 中的 docx/xxxxx 部分）" },
      },
      required: ["doc_token"],
    },
  },
  {
    name: "create_doc",
    description: "在飞书云空间创建新文档。",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "文档标题" },
        folder_token: { type: "string", description: "存放的文件夹 token（可选，不填放根目录）" },
      },
      required: ["title"],
    },
  },
  {
    name: "delete_message",
    description: "删除飞书中的一条消息。",
    input_schema: {
      type: "object",
      properties: { message_id: { type: "string", description: "消息 ID" } },
      required: ["message_id"],
    },
  },
  {
    name: "get_chat_members",
    description: "获取飞书群聊的成员列表。",
    input_schema: {
      type: "object",
      properties: { chat_id: { type: "string", description: "群聊 ID" } },
      required: ["chat_id"],
    },
  },
  {
    name: "pin_message",
    description: "置顶飞书群聊中的一条消息。",
    input_schema: {
      type: "object",
      properties: {
        chat_id: { type: "string", description: "群聊 ID" },
        message_id: { type: "string", description: "消息 ID" },
      },
      required: ["chat_id", "message_id"],
    },
  },
  {
    name: "add_reaction",
    description: "对飞书消息添加 emoji 表情回应。",
    input_schema: {
      type: "object",
      properties: {
        message_id: { type: "string", description: "消息 ID" },
        reaction_type: { type: "string", description: "emoji 类型，如 THUMBSUP、OK、SMILE 等" },
      },
      required: ["message_id", "reaction_type"],
    },
  },
  {
    name: "forward_message",
    description: "将一条消息转发到指定群聊。",
    input_schema: {
      type: "object",
      properties: {
        message_id: { type: "string", description: "要转发的消息 ID" },
        chat_id: { type: "string", description: "目标群聊 ID" },
      },
      required: ["message_id", "chat_id"],
    },
  },
  {
    name: "create_group",
    description: "创建一个新的飞书群聊。",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "群名称" },
        open_ids: { type: "array", items: { type: "string" }, description: "初始成员的 open_id 列表" },
      },
      required: ["name"],
    },
  },
  {
    name: "add_group_member",
    description: "向飞书群聊添加成员。",
    input_schema: {
      type: "object",
      properties: {
        chat_id: { type: "string", description: "群聊 ID" },
        open_ids: { type: "array", items: { type: "string" }, description: "要添加的成员 open_id 列表" },
      },
      required: ["chat_id", "open_ids"],
    },
  },
  {
    name: "update_group_info",
    description: "修改飞书群聊的名称或描述。",
    input_schema: {
      type: "object",
      properties: {
        chat_id: { type: "string", description: "群聊 ID" },
        name: { type: "string", description: "新群名（可选）" },
        description: { type: "string", description: "新描述（可选）" },
      },
      required: ["chat_id"],
    },
  },
  {
    name: "delete_calendar_event",
    description: "删除飞书日历中的日程。",
    input_schema: {
      type: "object",
      properties: { event_id: { type: "string", description: "日程 ID" } },
      required: ["event_id"],
    },
  },
  {
    name: "delete_task",
    description: "删除飞书中的任务。",
    input_schema: {
      type: "object",
      properties: { task_id: { type: "string", description: "任务 ID" } },
      required: ["task_id"],
    },
  },
  {
    name: "append_doc_content",
    description: "向飞书文档末尾追加文字内容。",
    input_schema: {
      type: "object",
      properties: {
        doc_token: { type: "string", description: "文档 token" },
        content: { type: "string", description: "要追加的文字内容" },
      },
      required: ["doc_token", "content"],
    },
  },
  {
    name: "search_wiki",
    description: "在飞书知识库中搜索页面。",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "搜索关键词" } },
      required: ["query"],
    },
  },
  {
    name: "get_wiki_content",
    description: "读取飞书知识库页面内容。",
    input_schema: {
      type: "object",
      properties: {
        space_id: { type: "string", description: "知识库 space ID" },
        node_token: { type: "string", description: "节点 token" },
      },
      required: ["space_id", "node_token"],
    },
  },
  {
    name: "get_bitable_tables",
    description: "获取飞书多维表格（Bitable）中的所有数据表列表。",
    input_schema: {
      type: "object",
      properties: { app_token: { type: "string", description: "多维表格 app token（URL 中的 base/xxxxx 部分）" } },
      required: ["app_token"],
    },
  },
  {
    name: "get_bitable_records",
    description: "读取飞书多维表格中的记录。",
    input_schema: {
      type: "object",
      properties: {
        app_token: { type: "string", description: "多维表格 app token" },
        table_id: { type: "string", description: "数据表 ID（从 get_bitable_tables 获取）" },
        page_size: { type: "number", description: "获取条数，默认 20" },
      },
      required: ["app_token", "table_id"],
    },
  },
  {
    name: "create_bitable_record",
    description: "在飞书多维表格中创建新记录。",
    input_schema: {
      type: "object",
      properties: {
        app_token: { type: "string", description: "多维表格 app token" },
        table_id: { type: "string", description: "数据表 ID" },
        fields: { type: "object", description: "字段键值对，如 {\"姓名\": \"张三\", \"状态\": \"进行中\"}" },
      },
      required: ["app_token", "table_id", "fields"],
    },
  },
  {
    name: "update_bitable_record",
    description: "更新飞书多维表格中的记录。",
    input_schema: {
      type: "object",
      properties: {
        app_token: { type: "string", description: "多维表格 app token" },
        table_id: { type: "string", description: "数据表 ID" },
        record_id: { type: "string", description: "记录 ID" },
        fields: { type: "object", description: "要更新的字段键值对" },
      },
      required: ["app_token", "table_id", "record_id", "fields"],
    },
  },
  {
    name: "delete_bitable_record",
    description: "删除飞书多维表格中的记录。",
    input_schema: {
      type: "object",
      properties: {
        app_token: { type: "string", description: "多维表格 app token" },
        table_id: { type: "string", description: "数据表 ID" },
        record_id: { type: "string", description: "记录 ID" },
      },
      required: ["app_token", "table_id", "record_id"],
    },
  },
  {
    name: "get_sheet_values",
    description: "读取飞书电子表格中指定范围的数据。",
    input_schema: {
      type: "object",
      properties: {
        spreadsheet_token: { type: "string", description: "表格 token（URL 中的 sheets/xxxxx 部分）" },
        range: { type: "string", description: "单元格范围，如 Sheet1!A1:C10" },
      },
      required: ["spreadsheet_token", "range"],
    },
  },
  {
    name: "update_sheet_values",
    description: "向飞书电子表格写入数据。",
    input_schema: {
      type: "object",
      properties: {
        spreadsheet_token: { type: "string", description: "表格 token" },
        range: { type: "string", description: "写入范围，如 Sheet1!A1" },
        values: { type: "array", description: "二维数组，如 [[\"A\",\"B\"],[1,2]]" },
      },
      required: ["spreadsheet_token", "range", "values"],
    },
  },
  {
    name: "list_files",
    description: "列出飞书云空间中的文件和文件夹。",
    input_schema: {
      type: "object",
      properties: {
        folder_token: { type: "string", description: "文件夹 token（不填则列出根目录）" },
      },
    },
  },
  {
    name: "move_file",
    description: "将飞书云空间中的文件移动到指定文件夹。",
    input_schema: {
      type: "object",
      properties: {
        file_token: { type: "string", description: "文件 token" },
        folder_token: { type: "string", description: "目标文件夹 token" },
      },
      required: ["file_token", "folder_token"],
    },
  },
  {
    name: "get_user_detail",
    description: "根据 open_id 获取飞书用户的详细信息，包括手机、邮箱、职位、部门等。",
    input_schema: {
      type: "object",
      properties: { open_id: { type: "string", description: "用户 open_id" } },
      required: ["open_id"],
    },
  },
  {
    name: "get_departments",
    description: "获取飞书组织架构中的部门列表。",
    input_schema: {
      type: "object",
      properties: {
        parent_department_id: { type: "string", description: "父部门 ID（不填则获取顶层部门）" },
      },
    },
  },
  {
    name: "get_approval_instances",
    description: "获取指定审批类型的审批实例列表。",
    input_schema: {
      type: "object",
      properties: {
        approval_code: { type: "string", description: "审批定义 code" },
        page_size: { type: "number", description: "获取条数，默认 20" },
      },
      required: ["approval_code"],
    },
  },
  {
    name: "get_approval_instance_detail",
    description: "获取某个审批实例的详细信息，包括状态、表单内容、审批流程。",
    input_schema: {
      type: "object",
      properties: { instance_code: { type: "string", description: "审批实例 code" } },
      required: ["instance_code"],
    },
  },
  {
    name: "get_private_messages",
    description: "读取与某个用户的私聊消息记录，用姓名或关键词匹配。",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "对方的姓名或部分名称" },
        page_size: { type: "number", description: "获取条数，默认 20" },
      },
      required: ["name"],
    },
  },
  {
    name: "search_messages",
    description: "在飞书中全局搜索包含关键词的消息。",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索关键词" },
        page_size: { type: "number", description: "结果数量，默认 20" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_department_members",
    description: "获取指定部门的成员列表。",
    input_schema: {
      type: "object",
      properties: {
        department_id: { type: "string", description: "部门 ID" },
      },
      required: ["department_id"],
    },
  },
  {
    name: "generate_creative_content",
    description: `生成图片或视频创意内容。
⚠️ 调用前必须已向用户收集完整的「创意需求简报」，绝不允许在未追问的情况下直接生成。

引擎选择规则：
- 写实/精细/照片感图片 → engine: "gpt-image-1"
- 艺术感/动漫/插画/水墨/概念艺术图片 → engine: "dreamina"
- 任何视频需求 → engine: "dreamina"（自动选 text2video 或 image2video）
- 不确定 → engine: "auto"`,
    input_schema: {
      type: "object",
      properties: {
        media_type: {
          type: "string",
          enum: ["image", "video", "image_sequence"],
          description: "image（单张图片）/ video（视频）/ image_sequence（多张系列图）",
        },
        prompt_en: {
          type: "string",
          description: "英文生成提示词，详细描述画面内容、风格、光线、构图等，用于实际生成",
        },
        style: {
          type: "string",
          enum: ["realistic", "illustration", "3d", "anime", "minimalist", "painting", "cinematic", "other"],
          description: "风格：realistic写实 / illustration插画 / 3d三维 / anime动漫 / minimalist极简 / painting油画水彩 / cinematic电影感",
        },
        aspect_ratio: {
          type: "string",
          enum: ["1:1", "16:9", "9:16", "4:3", "3:4"],
          description: "宽高比：1:1方图 / 16:9横版 / 9:16竖版海报 / 4:3 / 3:4",
        },
        engine: {
          type: "string",
          enum: ["auto", "gpt-image-1", "dreamina"],
          description: "生成引擎：auto自动选择 / gpt-image-1写实细节强 / dreamina艺术风格强",
        },
        count: {
          type: "number",
          description: "生成数量，默认1，image_sequence 时可设置2-4",
        },
        reference_image_url: {
          type: "string",
          description: "参考图 URL，图生视频或风格参考时使用",
        },
        video_duration: {
          type: "number",
          enum: [5, 10],
          description: "视频时长（秒），仅 video 类型有效，默认5",
        },
      },
      required: ["media_type", "prompt_en", "style", "aspect_ratio", "engine"],
    },
  },
];

// Execute a tool call
async function executeTool(name, input, ctx = {}) {
  switch (name) {
    case "run_dreamina":
      return JSON.stringify(await dreaminaExec(input.args));
    case "run_lark_cli":
      return JSON.stringify(await larkProxyExec(input.args));
    case "run_atypica":
      return JSON.stringify(await atypicaExec(input.args));
    case "get_hot_topics":
      return JSON.stringify(await hotTopicsExec(input.platform || "all", input.limit || 20));
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
    case "get_messages":
      return JSON.stringify(await getMessages(input.chat_id, input.page_size));
    case "send_direct_message":
      return await sendDirectMessage(input.open_id, input.text);
    case "create_calendar_event":
      return JSON.stringify(await createCalendarEvent(input.summary, input.start_timestamp, input.end_timestamp, input.description, input.location));
    case "update_calendar_event":
      return await updateCalendarEvent(input.event_id, input.summary, input.start_timestamp, input.end_timestamp, input.description);
    case "create_task":
      return JSON.stringify(await createTask(input.title, input.due_timestamp, input.description));
    case "update_task":
      return await updateTask(input.task_id, input.completed, input.title);
    case "get_doc_content":
      return await getDocContent(input.doc_token);
    case "create_doc":
      return JSON.stringify(await createDoc(input.title, input.folder_token));
    case "get_private_messages":
      return JSON.stringify(await getPrivateMessages(input.name, input.page_size));
    case "search_messages":
      return JSON.stringify(await searchMessages(input.query, input.page_size));
    case "get_department_members":
      return JSON.stringify(await getDepartmentMembers(input.department_id));
    case "delete_message":
      return await deleteMessage(input.message_id);
    case "get_chat_members":
      return JSON.stringify(await getChatMembers(input.chat_id));
    case "pin_message":
      return await pinMessage(input.chat_id, input.message_id);
    case "add_reaction":
      return await addReaction(input.message_id, input.reaction_type);
    case "forward_message":
      return await forwardMessage(input.message_id, input.chat_id);
    case "create_group":
      return JSON.stringify(await createGroup(input.name, input.open_ids || []));
    case "add_group_member":
      return await addGroupMember(input.chat_id, input.open_ids);
    case "update_group_info":
      return await updateGroupInfo(input.chat_id, input.name, input.description);
    case "delete_calendar_event":
      return await deleteCalendarEvent(input.event_id);
    case "delete_task":
      return await deleteTask(input.task_id);
    case "append_doc_content":
      return await appendDocContent(input.doc_token, input.content);
    case "search_wiki":
      return JSON.stringify(await searchWiki(input.query));
    case "get_wiki_content":
      return JSON.stringify(await getWikiContent(input.space_id, input.node_token));
    case "get_bitable_tables":
      return JSON.stringify(await getBitableTables(input.app_token));
    case "get_bitable_records":
      return JSON.stringify(await getBitableRecords(input.app_token, input.table_id, input.page_size));
    case "create_bitable_record":
      return JSON.stringify(await createBitableRecord(input.app_token, input.table_id, input.fields));
    case "update_bitable_record":
      return await updateBitableRecord(input.app_token, input.table_id, input.record_id, input.fields);
    case "delete_bitable_record":
      return await deleteBitableRecord(input.app_token, input.table_id, input.record_id);
    case "get_sheet_values":
      return JSON.stringify(await getSheetValues(input.spreadsheet_token, input.range));
    case "update_sheet_values":
      return await updateSheetValues(input.spreadsheet_token, input.range, input.values);
    case "list_files":
      return JSON.stringify(await listFiles(input.folder_token));
    case "move_file":
      return await moveFile(input.file_token, input.folder_token);
    case "get_user_detail":
      return JSON.stringify(await getUserDetail(input.open_id));
    case "get_departments":
      return JSON.stringify(await getDepartments(input.parent_department_id));
    case "get_approval_instances":
      return JSON.stringify(await getApprovalInstances(input.approval_code, input.page_size));
    case "get_approval_instance_detail":
      return JSON.stringify(await getApprovalInstanceDetail(input.instance_code));
    case "generate_image":
      return JSON.stringify(await generateImageExec(input.prompt, input.size, ctx.msgId));
    case "generate_creative_content":
      return JSON.stringify(await generateCreativeContent(input, ctx));
    default:
      return `未知工具: ${name}`;
  }
}

// Multi-turn conversation history per chat
const chatHistory = new Map();
const processedMsgIds = new Set();

// ── 启动恢复：处理 Railway 重启期间遗漏的消息 ────────────────────────────────
// 只在代理注册后调用，确保 runAgent 可以正常调用飞书 API
async function recoverMissedMessages() {
  const LOOKBACK_SEC = 8 * 60; // 往回看 8 分钟
  const startTimeSec = Math.floor(Date.now() / 1000) - LOOKBACK_SEC;

  let token;
  try {
    token = await getAppToken();
  } catch (err) {
    console.log("[recovery] 无法获取 app token，跳过:", err.message);
    return;
  }

  // 获取 bot 所在的聊天列表
  let chats = [];
  try {
    const r = await fetch(
      "https://open.feishu.cn/open-apis/im/v1/chats?page_size=50",
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const d = await r.json();
    chats = d?.data?.items || [];
  } catch (err) {
    console.log("[recovery] 获取聊天列表失败，跳过:", err.message);
    return;
  }

  if (chats.length === 0) return;
  console.log(`[recovery] 检查 ${chats.length} 个聊天（最近 ${LOOKBACK_SEC / 60} 分钟）...`);
  let recovered = 0;

  for (const chat of chats) {
    const chatId = chat.chat_id;
    try {
      const r = await fetch(
        `https://open.feishu.cn/open-apis/im/v1/messages?container_id_type=chat&container_id=${chatId}&start_time=${startTimeSec}&sort_type=ByCreateTimeDesc&page_size=20`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const d = await r.json();
      const messages = d?.data?.items || [];
      if (messages.length === 0) continue;

      // bot 已回复的时间点集合（秒）
      const botReplyTimes = messages
        .filter(m => m.sender?.sender_type === "app")
        .map(m => parseInt(m.create_time, 10));

      for (const msg of messages) {
        if (msg.sender?.sender_type === "app") continue;
        if (!["text", "post"].includes(msg.msg_type)) continue;

        // 群聊只恢复 @bot 的消息
        if (chat.chat_type === "group") {
          const mentions = msg.mentions || [];
          const mentioned = botOpenId
            ? mentions.some(m => m.id?.open_id === botOpenId)
            : mentions.length > 0;
          if (!mentioned) continue;
        }

        const msgTime = parseInt(msg.create_time, 10);
        // bot 在此消息之后有过回复 → 视为已处理
        if (botReplyTimes.some(t => t > msgTime)) continue;
        // 本次进程已处理过 → 跳过
        if (processedMsgIds.has(msg.message_id)) continue;

        // 解析用户文本内容
        let userContent = "";
        try {
          const content = JSON.parse(msg.body?.content || "{}");
          if (msg.msg_type === "text") {
            userContent = (content.text || "").replace(/@[^\s]+\s*/g, "").trim();
          } else if (msg.msg_type === "post") {
            const lang = content.zh_cn || content.en_us || Object.values(content)[0];
            userContent = (lang?.content?.flat() || [])
              .filter(e => e.tag === "text")
              .map(e => e.text)
              .join("").trim();
          }
        } catch { continue; }

        if (!userContent) continue;

        console.log(`[recovery] 恢复遗漏消息 ${msg.message_id?.slice(-8)} chat=${chatId}`);
        processedMsgIds.add(msg.message_id);
        recovered++;

        try {
          const reply = await Promise.race([
            runAgent(chatId, userContent, null, msg.message_id),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("处理超时（120秒）")), 120_000)
            ),
          ]);
          await replyToLark(msg.message_id, reply);
        } catch (err) {
          console.error("[recovery] 处理消息失败:", err.message);
          await replyToLark(msg.message_id, `⚠️ 出错了（启动恢复）：${err.message.slice(0, 150)}`).catch(() => {});
        }
      }
    } catch (err) {
      console.error(`[recovery] 检查聊天 ${chatId} 失败:`, err.message);
    }
  }

  console.log(`[recovery] 完成，恢复了 ${recovered} 条遗漏消息`);
}

let _recoveryDone = false;

// 根据工具调用生成进度提示文字
function toolProgressMsg(name, input) {
  if (name === "run_lark_cli") {
    const args = input.args || [];
    const path = args[2] || "";
    const method = (args[1] || "").toUpperCase();
    if (path.includes("/wiki/") || args[0] === "wiki")       return "📚 正在搜索知识库...";
    if (path.includes("/docx/") || path.includes("/docs/"))  return "📄 正在读取文档内容...";
    if (path.includes("/bitable/"))                           return "📊 正在读取多维表格...";
    if (path.includes("/drive/"))                             return "📁 正在操作云空间文件...";
    if (path.includes("/calendar/"))                          return "📅 正在查询日程...";
    if (path.includes("/contact/") || args[0] === "contact") return "👤 正在查询通讯录...";
    if (path.includes("/sheets/"))                            return "📊 正在操作电子表格...";
    if (path.includes("/im/v1/messages") && method === "POST") return "💬 正在发送消息...";
    if (path.includes("/im/v1/chats/search"))                 return "🔍 正在搜索群组...";
    if (path.includes("/im/"))                                return "💬 正在查询消息...";
    return "⚙️ 正在调用飞书 API...";
  }
  if (name === "get_hot_topics") return "🔥 正在获取国内热榜...";
  if (name === "run_atypica")    return "📡 正在查询全球趋势...";
  if (name === "run_dreamina")             return "🎨 正在生成图像/视频...";
  if (name === "generate_creative_content") {
    const type = input?.media_type === "video" ? "视频" : "图片";
    const engine = input?.engine === "dreamina" ? "Dreamina" : "GPT-Image";
    return `🎨 正在用 ${engine} 生成${type}...`;
  }
  return null;
}

// ── Creative Content Generation — brief-driven router ────────────────────────
const DREAMINA_RATIO_MAP = { "1:1": "1:1", "16:9": "16:9", "9:16": "9:16", "4:3": "4:3", "3:4": "3:4" };
const GPT_SIZE_MAP       = { "1:1": "1024x1024", "16:9": "1536x1024", "9:16": "1024x1536", "4:3": "1536x1024", "3:4": "1024x1536" };

async function generateCreativeContent(brief, ctx = {}) {
  const {
    media_type, prompt_en, style,
    aspect_ratio = "1:1",
    engine = "auto",
    count = 1,
    reference_image_url,
    video_duration = 5,
  } = brief;

  // Auto-select engine
  let actualEngine = engine;
  if (engine === "auto") {
    if (media_type === "video") {
      actualEngine = "dreamina";
    } else if (["anime", "illustration", "painting"].includes(style)) {
      actualEngine = "dreamina";
    } else {
      actualEngine = "gpt-image-1";
    }
  }

  // ── VIDEO ──────────────────────────────────────────────────────────────────
  if (media_type === "video") {
    const ratio = DREAMINA_RATIO_MAP[aspect_ratio] || "16:9";
    const args = reference_image_url
      ? ["image2video", "--image_url", reference_image_url, "--prompt", prompt_en, "--duration", String(video_duration)]
      : ["text2video", "--prompt", prompt_en, "--duration", String(video_duration)];

    const submitResult = await dreaminaExec(args);
    const sd = typeof submitResult.output === "object" ? submitResult.output : {};
    const submitId = sd?.data?.submit_id;
    if (!submitId) return { error: "视频任务提交失败", detail: sd };

    // Poll up to 3 min (18 × 10s)
    for (let i = 0; i < 18; i++) {
      await new Promise((r) => setTimeout(r, 10000));
      const qr = await dreaminaExec(["query_result", "--submit_id", submitId]);
      const qd = typeof qr.output === "object" ? qr.output : {};
      if (qd?.data?.status === "success") {
        return { success: true, type: "video", submit_id: submitId, result: qd.data };
      }
      if (qd?.data?.status === "failed") {
        return { error: "视频生成失败", detail: qd.data };
      }
    }
    return { error: "视频生成超时，可稍后用 query_result 查询 submit_id=" + submitId };
  }

  // ── IMAGE via Dreamina ─────────────────────────────────────────────────────
  if (actualEngine === "dreamina") {
    const ratio = DREAMINA_RATIO_MAP[aspect_ratio] || "1:1";
    const results = [];
    const n = Math.min(Math.max(count || 1, 1), 4);
    for (let i = 0; i < n; i++) {
      const r = await dreaminaExec(["text2image", "--prompt", prompt_en, "--ratio", ratio, "--resolution_type", "2k"]);
      results.push(r);
    }
    return { success: true, engine: "dreamina", count: n, results };
  }

  // ── IMAGE via gpt-image-1 (Codex) ─────────────────────────────────────────
  const size = GPT_SIZE_MAP[aspect_ratio] || "1024x1024";
  const n = Math.min(Math.max(count || 1, 1), 4);
  const results = [];
  for (let i = 0; i < n; i++) {
    const r = await generateImageExec(prompt_en, size, ctx.msgId);
    results.push(r);
  }
  return { success: true, engine: "gpt-image-1", count: n, results };
}

// Claude Agent loop
// userContent: string (text) or array of Claude content blocks (multi-modal)
// onProgress: optional async (msg: string) => void，每步工具调用前回调
async function runAgent(chatId, userContent, onProgress, msgId = null) {
  if (!chatHistory.has(chatId)) chatHistory.set(chatId, []);
  const history = chatHistory.get(chatId);

  // History stores text only — images/audio stored as placeholder to keep context small
  const historyContent = Array.isArray(userContent)
    ? (userContent.find(b => b.type === "text")?.text || "[媒体消息]")
    : userContent;
  history.push({ role: "user", content: historyContent });

  // Keep last 20 turns; always start with a user message after trimming
  if (history.length > 20) history.splice(0, history.length - 20);
  while (history.length > 0 && history[0].role !== "user") history.shift();

  // messages uses full content for current turn (e.g. actual image blocks)
  const messages = [
    ...history.slice(0, -1),
    { role: "user", content: userContent },
  ];

  const systemPrompt = `你是「经纬」，一个智能飞书助手，可以操作飞书的所有功能。

## 工具使用规则（严格遵守）

**第一优先级：run_lark_cli**
- 任何飞书操作，**必须首先尝试 run_lark_cli**
- 它通过本地 lark-cli 执行，权限完整、token 自动管理
- 常用示例：
  - 查聊天列表: args=["api","GET","/open-apis/im/v1/chats","--params","{\\"page_size\\":20}","--as","user"]
  - 读群消息: args=["api","GET","/open-apis/im/v1/messages","--params","{\\"container_id_type\\":\\"chat\\",\\"container_id\\":\\"CHAT_ID\\",\\"page_size\\":20}","--as","user"]
  - 查日程: args=["calendar","+agenda","--as","user"]
  - 搜索用户: args=["contact","+search-user","--query","姓名","--as","user"]
  - 任意API: args=["api","GET或POST","/open-apis/路径","--as","user"]

**第二优先级：get_hot_topics（国内热榜）**
- 用户问微博/B站/头条/百度/抖音热搜、国内热点时使用
- 示例：platform="all" 获取所有平台；platform="weibo" 只看微博热搜
- 支持平台：weibo / bilibili / toutiao / baidu / douyin / all

**第三优先级：run_atypica（全球趋势）**
- 用户问全球热点、英文趋势、海外话题时使用（locale 仅支持 en-US）
- 示例：args=["pulse","list","--limit","10","--order-by","heatScore"]

**第四优先级：generate_creative_content（AI 创意生成）**

⚠️ 铁律：检测到创意生成需求后，**先追问，后生成**，禁止直接调工具。

【触发词】：画一张、帮我做个图、生成图片、设计一张、做个视频、生成视频、帮我拍个、做张海报……

【第一步 — 追问简报（2-3个最关键的问题）】

  图片需求追问：
  - 用途/平台：社交媒体配图 / 广告素材 / 个人收藏 / 品牌物料
  - 风格：写实照片感 / 插画漫画 / 3D渲染 / 极简设计 / 动漫 / 油画水彩
  - 比例方向：方图(1:1) / 横版(16:9) / 竖版海报(9:16)
  - 可选追问：氛围色调、参考品牌/艺术家风格

  视频需求追问：
  - 时长：5秒 / 10秒
  - 素材来源：从零文字生成 / 让某张已有图片动起来
  - 风格节奏：轻快广告感 / 舒缓写意 / 震撼动感

【第二步 — 收齐后生成】
  整合用户回答，把中文需求翻译成详细的英文 prompt，再调用 generate_creative_content。

  引擎选择：
  - 写实/照片感/精细细节 → engine: "gpt-image-1"
  - 插画/动漫/水墨/艺术概念 → engine: "dreamina"
  - 视频 → engine: "dreamina"（自动选 text2video 或 image2video）

  图片生成成功后直接告知用户；视频生成需轮询，完成后告知下载链接或结果。

**第五优先级：其他工具**
- 只在 run_lark_cli 返回错误或代理不可用时，才使用其他工具

## 其他规则
1. 使用工具获取实时数据，不要凭记忆回答
2. 工具结果用中文简洁总结给用户
3. 如果所有工具都失败，告知用户具体错误
4. 今天的日期是 ${new Date().toLocaleDateString("zh-CN")}`;

  let finalReply = "";
  let toolCallCount = 0;

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
          toolCallCount++;
          // 从第 2 步开始发进度（第 1 步已有「⏳ 正在处理」）
          if (onProgress && toolCallCount >= 2) {
            const msg = toolProgressMsg(block.name, block.input);
            if (msg) onProgress(`第 ${toolCallCount} 步：${msg}`).catch(() => {});
          }
          console.log(`[工具] ${block.name}(${JSON.stringify(block.input)})`);
          const result = await executeTool(block.name, block.input, { msgId, chatId });
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

// Upload base64 image to Feishu and return image_key
async function uploadImageToFeishu(base64Data) {
  const token = await getAppToken();
  const imgBuffer = Buffer.from(base64Data, "base64");
  const formData = new FormData();
  formData.append("image_type", "message");
  formData.append("image", new Blob([imgBuffer], { type: "image/png" }), "image.png");
  const res = await fetch("https://open.feishu.cn/open-apis/im/v1/images", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`飞书上传失败: ${data.msg} (code ${data.code})`);
  return data.data.image_key;
}

// Reply to a Feishu message with an image
async function replyImageToLark(messageId, imageKey) {
  await larkClient.im.message.reply({
    path: { message_id: messageId },
    data: {
      msg_type: "image",
      content: JSON.stringify({ image_key: imageKey }),
    },
  });
}

// Generate image via local proxy (OpenAI gpt-image-1) and send to Feishu
async function generateImageExec(prompt, size = "1024x1024", replyMsgId = null) {
  const proxyUrl = process.env.LARK_PROXY_URL;
  if (!proxyUrl) return { error: "本地代理未连接，无法生成图片" };
  try {
    const res = await fetch(`${proxyUrl}/generate-image`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-proxy-secret": process.env.PROXY_SECRET || "lark-proxy-secret-2026",
      },
      body: JSON.stringify({ prompt, size }),
      signal: AbortSignal.timeout(120000),
    });
    const data = await res.json();
    if (data.error) return { error: data.error };

    const imageKey = await uploadImageToFeishu(data.image_base64);
    if (replyMsgId) {
      await replyImageToLark(replyMsgId, imageKey).catch((e) =>
        console.error("[图片回复失败]", e.message)
      );
    }
    return { success: true, image_key: imageKey, status: "图片已发送到飞书" };
  } catch (err) {
    return { error: err.message };
  }
}

// Bot's own open_id — used to detect @mentions in group chats
let botOpenId = "";

async function fetchBotInfo() {
  try {
    const token = await getAppToken();
    const res = await fetch("https://open.feishu.cn/open-apis/bot/v3/info", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    botOpenId = data.bot?.open_id || "";
    if (botOpenId) console.log(`✅ Bot open_id: ...${botOpenId.slice(-8)}`);
    else console.warn("[bot-info] 未能获取 bot open_id，群聊将按 mentions 非空判断");
  } catch (err) {
    console.error("[bot-info] 获取失败:", err.message);
  }
}

// Recent event log (in-memory, last 20)
const recentEvents = [];
const recentErrors = [];
// Last 5 post message raw payloads (for debugging content structure)
const recentPostPayloads = [];

// Webhook handler
app.post("/webhook", async (req, res) => {
  const body = req.body;

  if (body.type === "url_verification") {
    return res.json({ challenge: body.challenge });
  }

  res.json({ code: 0 });

  // Log every incoming webhook for diagnostics
  const logEntry = {
    ts: new Date().toISOString(),
    type: body.header?.event_type,
    sender_type: body.event?.sender?.sender_type,
    msg_type: body.event?.message?.message_type,
    chat_type: body.event?.message?.chat_type,
    msg_id: body.event?.message?.message_id?.slice(-8),
  };
  recentEvents.push(logEntry);
  if (recentEvents.length > 20) recentEvents.shift();
  console.log("[webhook]", JSON.stringify(logEntry));

  // Capture post message payloads for content structure debugging
  if (body.event?.message?.message_type === "post") {
    const snap = {
      ts: logEntry.ts,
      msg_id: logEntry.msg_id,
      content_raw: body.event.message.content?.slice(0, 500),
    };
    recentPostPayloads.push(snap);
    if (recentPostPayloads.length > 5) recentPostPayloads.shift();
  }

  // Declare msgId outside try so catch block can reference it
  let msgId;

  try {
    const event = body.event;
    const eventType = body.header?.event_type;

    // ── 表情回复互动 ────────────────────────────────────────────────────────────
    if (eventType === "im.message.reaction.created_v1") {
      const emoji = event.reaction_type?.emoji_type || "";
      const reactionMsgId = event.message_id;
      // 只响应用户（非 bot 自己）的表情
      if (!reactionMsgId || event.operator_type !== "user") return;

      const REACTION_REPLIES = {
        THUMBSUP:   "嗯！",
        OK:         "收到~",
        CLAP:       "谢谢鼓励！",
        LOVE:       "❤️",
        HAHA:       "😄",
        FIRE:       "🔥 燃起来了",
        JINGKONG:   "怎么了，吓到你了？",
        CRY:        "怎么了…",
        THINK:      "让我想想…",
        ANGER:      "不满意？告诉我哪里需要改",
        WOW:        "哈，没想到吧",
        FACEPALM:   "…是不是搞错了什么",
        ZZZ:        "在呢在呢，没睡着",
        STRONG:     "💪",
        PRAY:       "好的，尽力！",
      };

      const replyText = REACTION_REPLIES[emoji];
      if (replyText) {
        await replyToLark(reactionMsgId, replyText);
      }
      return;
    }

    if (!event || eventType !== "im.message.receive_v1") return;

    // Ignore messages sent by the bot itself to avoid infinite loops
    if (event.sender?.sender_type === "app") return;

    const message = event.message;
    msgId = message.message_id;

    if (processedMsgIds.has(msgId)) {
      console.log(`[dedup] 已处理过: ${msgId?.slice(-8)}`);
      return;
    }
    processedMsgIds.add(msgId);
    if (processedMsgIds.size > 1000) {
      processedMsgIds.delete(processedMsgIds.values().next().value);
    }

    const SUPPORTED = ["text", "post", "image", "audio", "media"];
    if (!SUPPORTED.includes(message.message_type)) return;

    const content = JSON.parse(message.content);
    const chatId = message.chat_id;

    // 群聊只响应 @提及，p2p 直聊全部响应
    if (message.chat_type === "group") {
      const mentions = message.mentions || [];
      const mentioned = botOpenId
        ? mentions.some(m => m.id?.open_id === botOpenId)
        : mentions.length > 0;
      if (!mentioned) return;
    }

    // userContent: string or Claude content blocks array
    let userContent;

    if (message.message_type === "text") {
      userContent = content.text.replace(/@[^\s]+\s*/g, "").trim();
      if (!userContent) return;
    } else if (message.message_type === "post") {
      const lang = content.zh_cn || content.en_us || Object.values(content)[0];
      const blocks = (lang?.content || []).flat();
      const textContent = blocks.filter(e => e.tag === "text").map(e => e.text).join("").trim();
      const imgKeys = blocks.filter(e => e.tag === "img" && e.image_key).map(e => e.image_key);

      console.log(`[post] textLen=${textContent.length} imgKeys=${imgKeys.length}`);
      if (imgKeys.length === 0) {
        // 纯文字 post
        userContent = textContent;
        if (!userContent) { console.log("[post] 纯文字内容为空，跳过"); return; }
      } else {
        // 包含图片的 post — 构建多模态内容
        const parts = [];
        if (textContent) parts.push({ type: "text", text: textContent });
        for (const key of imgKeys) {
          try {
            const buf = await downloadResource(message.message_id, key, "image");
            parts.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: buf.toString("base64") } });
          } catch (err) {
            console.error("[post-img] 嵌套图片下载失败:", err.message);
          }
        }
        if (parts.length === 0) { console.log("[post] parts 为空，跳过"); return; }
        userContent = parts;
      }
    } else if (message.message_type === "image") {
      userContent = await processImageMessage(message);
    } else if (message.message_type === "audio") {
      userContent = await processAudioMessage(message);
    } else if (message.message_type === "media") {
      userContent = await processVideoMessage(message);
    }

    console.log(`[收到:${message.message_type}] ${chatId}`);

    // 立即发「正在处理」提示，让用户知道 bot 已收到
    replyToLark(msgId, "⏳ 收到，正在处理中...").catch((e) => {
      const errEntry = { ts: new Date().toISOString(), stage: "ack", msg_id: msgId?.slice(-8), error: e.message, code: e.code };
      recentErrors.push(errEntry);
      if (recentErrors.length > 20) recentErrors.shift();
      console.error("[ack失败]", JSON.stringify(errEntry));
    });

    // 多步任务时实时推送进度
    const onProgress = (msg) => replyToLark(msgId, msg);

    const AGENT_TIMEOUT_MS = 120_000;
    const reply = await Promise.race([
      runAgent(chatId, userContent, onProgress, msgId),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("处理超时（120秒），请稍后重试")), AGENT_TIMEOUT_MS)
      ),
    ]);
    console.log(`[回复] ${reply.slice(0, 100)}`);

    await replyToLark(msgId, reply);
  } catch (err) {
    const errEntry = { ts: new Date().toISOString(), stage: "agent", msg_id: msgId?.slice(-8), error: err.message, code: err.code };
    recentErrors.push(errEntry);
    if (recentErrors.length > 20) recentErrors.shift();
    console.error("[错误]", err.message, err.stack?.slice(0, 300));
    if (msgId) {
      try {
        await replyToLark(msgId, `⚠️ 出错了：${err.message.slice(0, 200)}`);
      } catch (replyErr) {
        const re = { ts: new Date().toISOString(), stage: "reply", msg_id: msgId?.slice(-8), error: replyErr.message, code: replyErr.code };
        recentErrors.push(re);
        if (recentErrors.length > 20) recentErrors.shift();
        console.error("[回复失败]", replyErr.message);
      }
    }
  }
});

app.get("/", (req, res) => res.send("Lark Claude Bot is running."));

// 配置诊断（不暴露值，只显示是否已设置）
app.get("/config", (req, res) => {
  res.json({
    LARK_APP_ID: !!process.env.LARK_APP_ID,
    LARK_APP_SECRET: !!process.env.LARK_APP_SECRET,
    ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL || "(not set)",
    LARK_PROXY_URL: process.env.LARK_PROXY_URL || "(not set)",
    USER_TOKEN: !!process.env.LARK_USER_ACCESS_TOKEN,
    NODE_ENV: process.env.NODE_ENV || "development",
  });
});

// Recent webhook events — diagnose whether Feishu is sending events
app.get("/events", (req, res) => res.json({ count: recentEvents.length, events: recentEvents }));

// Recent errors — diagnose reply failures
app.get("/errors", (req, res) => res.json({ count: recentErrors.length, errors: recentErrors }));

// Post message content debugger — shows raw content structure of last 5 post messages
app.get("/post-debug", (req, res) => res.json(recentPostPayloads));

// Test Anthropic API reachability from Railway
app.get("/test-api", async (req, res) => {
  try {
    const start = Date.now();
    const resp = await anthropic.messages.create({
      model: "pa/claude-sonnet-4-6",
      max_tokens: 10,
      messages: [{ role: "user", content: "hi" }],
    });
    res.json({ ok: true, ms: Date.now() - start, text: resp.content?.[0]?.text });
  } catch (err) {
    res.json({ ok: false, error: err.message, status: err.status });
  }
});

// Local proxy self-registration — called by start-proxy.sh when tunnel URL changes
let dynamicProxyUrl = "";
app.post("/register-proxy", (req, res) => {
  const secret = req.headers["x-proxy-secret"];
  if (secret !== (process.env.PROXY_SECRET || "lark-proxy-secret-2026")) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const { url } = req.body;
  if (!url || !url.startsWith("https://")) {
    return res.status(400).json({ error: "invalid url" });
  }
  dynamicProxyUrl = url;
  process.env.LARK_PROXY_URL = url;
  console.log(`[proxy] 注册新 URL: ${url}`);
  res.json({ ok: true, url });

  // 首次代理注册后触发启动恢复（代理就绪才能调用飞书 API）
  if (!_recoveryDone) {
    _recoveryDone = true;
    recoverMissedMessages().catch(err => console.error("[recovery] 启动恢复失败:", err.message));
  }
});

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
      if (userAccessToken) {
        tokenExpiresAt = Date.now() + 3600 * 1000;
        console.log("✅ 用户 access token 已加载");
        if (userRefreshToken) {
          await refreshUserToken();
        }
      } else if (userRefreshToken) {
        await refreshUserToken();
      } else {
        console.log("⚠️  未配置用户 token，用户级功能不可用");
      }
    } catch (err) {
      console.error("[启动 Token 刷新失败]", err.message);
    }
    // 获取 bot open_id 用于群聊 @判断
    await fetchBotInfo().catch(err => console.error("[fetchBotInfo 失败]", err.message));
  })();
});
