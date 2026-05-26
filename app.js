'use strict';

require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const line = require('@line/bot-sdk');

const store = require('./src/store');
const { route } = require('./src/router');
const reminders = require('./src/reminders');
const tix = require('./src/commands/tixcraft');
const { TZ } = require('./src/helpers');

// ---------- 設定 ----------
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
  channelSecret: process.env.LINE_CHANNEL_SECRET || '',
};
const client = new line.Client(lineConfig);

const OWNER_ID = process.env.OWNER_ID || ''; // 你本人（最高權限）
const ADMIN_IDS = new Set(
  (process.env.ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean)
);

function isOwner(userId) {
  return userId && userId === OWNER_ID;
}
function isAdmin(userId) {
  return isOwner(userId) || ADMIN_IDS.has(userId);
}

store.load(); // 先同步載入本機檔（如果有的話）

// ---------- 推播 ----------
async function pushToGroups(text) {
  const targets = store.pushTargets();
  if (targets.length === 0) {
    console.warn('[推播] 尚無群組可推送（請先把機器人拉進群組並發一則訊息）。');
    return;
  }
  for (const to of targets) {
    try {
      await client.pushMessage(to, { type: 'text', text });
    } catch (e) {
      console.error('[推播失敗]', to, e.message);
    }
  }
}

// ---------- Webhook ----------
const app = express();

app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
  try {
    await Promise.all((req.body.events || []).map(handleEvent));
    res.json({ ok: true });
  } catch (e) {
    console.error('[Webhook]', e);
    res.status(500).end();
  }
});

app.get('/', (_req, res) => res.send('🎫 LINE Ticket Bot v2 running'));
app.get('/health', (_req, res) =>
  res.json({
    events: Object.keys(store.data.events).length,
    groups: store.data.groups.length,
    mainGroup: store.data.mainGroupId,
    keywords: store.data.tix.keywords,
  })
);

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const userId = event.source.userId;
  const groupId = event.source.groupId || event.source.roomId || null;
  if (groupId) store.rememberGroup(groupId);

  // 取得顯示名稱
  let userName = '成員';
  try {
    if (event.source.type === 'group') {
      const p = await client.getGroupMemberProfile(event.source.groupId, userId);
      userName = p.displayName;
    } else if (event.source.type === 'room') {
      const p = await client.getRoomMemberProfile(event.source.roomId, userId);
      userName = p.displayName;
    } else {
      const p = await client.getProfile(userId);
      userName = p.displayName;
    }
  } catch (_) {}

  // 把收到的訊息與 userId 印到 log（方便除錯）
  console.log(`[訊息] ${userName} (${userId}) group=${groupId || '無'}: ${event.message.text}`);

  // 查自己的 userId：在聊天室輸入「我的ID」機器人就回你（用來設定 OWNER_ID）
  const t = (event.message.text || '').trim();
  if (/^(我的id|myid|查id|id)$/i.test(t)) {
    await client.replyMessage(event.replyToken, {
      type: 'text',
      text: `🆔 你的 userId：\n${userId}\n\n📌 複製這串，貼到 Render 的環境變數 OWNER_ID，存檔後重新啟動即可成為主管理員。`,
    });
    return;
  }

  // 手動測試拓元偵測（限主管理員）
  if (/^(測試拓元|拓元測試|test拓元)$/i.test(t)) {
    if (!isOwner(userId)) {
      await client.replyMessage(event.replyToken, { type: 'text', text: '⛔ 此指令僅限主管理員。' });
      return;
    }
    await client.replyMessage(event.replyToken, { type: 'text', text: '⏳ 正在測試抓取拓元，請稍候…' });
    const result = await tix.diagnose();
    await pushToGroups(result);
    return;
  }

  // 搜尋拓元場次（限主管理員，async）
  if (/^搜尋拓元/.test(t)) {
    const sArgs = t.replace(/^搜尋拓元\s*/, '').trim().split(/\s+/).filter(Boolean);
    await client.replyMessage(event.replyToken, { type: 'text', text: '🔍 搜尋中…' });
    const result = await tix.searchEvents(isOwner(userId), sArgs);
    await pushToGroups(result);
    return;
  }

  const reply = route({
    text: event.message.text,
    userId,
    userName,
    sourceType: event.source.type,
    groupId,
    isAdmin: isAdmin(userId),
    isOwner: isOwner(userId),
  });

  if (reply) {
    await client.replyMessage(event.replyToken, { type: 'text', text: reply });
  }
}

// ---------- 排程 ----------
// 每天 10:00（台灣）跑提醒
cron.schedule(
  '0 10 * * *',
  () => {
    reminders.runDaily(pushToGroups).catch((e) => console.error('[提醒]', e));
  },
  { timezone: TZ }
);

// 拓元偵測：預設每 2 小時一次（可用 TIX_CRON 環境變數覆蓋）
cron.schedule(
  process.env.TIX_CRON || '0 */2 * * *',
  async () => {
    const msgs = await tix.checkOnce(false);
    for (const m of msgs) await pushToGroups(m);
  },
  { timezone: TZ }
);

// ---------- 啟動 ----------
async function main() {
  // 連接 MongoDB（如果有設定），資料持久化
  await store.init();

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, async () => {
    console.log(`✅ Bot 啟動，Port ${PORT}`);
    console.log(`⭐ OWNER：${OWNER_ID || '(未設定)'}`);
    console.log(`👑 ADMIN：${[...ADMIN_IDS].join(', ') || '(無)'}`);

    if (store.data.tix.seen.length === 0) {
      await tix.checkOnce(true).catch((e) => console.error('[拓元首跑]', e.message));
    }
  });
}
main().catch(e => { console.error('啟動失敗：', e); process.exit(1); });
