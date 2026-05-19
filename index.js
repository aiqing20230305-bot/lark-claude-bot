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
  const data = await userApiCall(`/open-apis/bitable/v1/apps/${appToken}/tables?page_size=20`);
  if (data.data?.items) {
    return data.data.items.map((t) => ({ name: t.name, table_id: t.table_id }));
  }
  return data;
}

async function getBitableRecords(appToken, tableId, pageSize = 20) {
  const data = await userApiCall(
    `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records?page_size=${pageSize}`
  );
  if (data.data?.items) {
    return data.data.items.map((r) => ({ record_id: r.record_id, fields: r.fields }));
  }
  return data;
}

async function createBitableRecord(appToken, tableId, fields) {
  const data = await userApiCall(
    `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`,
    "POST",
    { fields }
  );
  if (data.data?.record) return { success: true, record_id: data.data.record.record_id };
  return data;
}

async function updateBitableRecord(appToken, tableId, recordId, fields) {
  const data = await userApiCall(
    `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`,
    "PUT",
    { fields }
  );
  return data.code === 0 ? "记录更新成功" : `更新失败: ${data.msg}`;
}

async function deleteBitableRecord(appToken, tableId, recordId) {
  const data = await userApiCall(
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
  })();
});
