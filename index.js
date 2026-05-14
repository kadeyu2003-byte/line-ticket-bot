'use strict';

// ====== 套件載入 ======
const line = require('@line/bot-sdk');
const express = require('express');
const Database = require('better-sqlite3');
const cron = require('node-cron');
require('dotenv').config();

// ====== LINE Bot 設定 ======
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.Client(config);
const app = express();
const db = new Database('ticketbot.db');

// ====== 資料庫初始化 ======
function initDB() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS shows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      show_date TEXT NOT NULL,
      ticket_sale_date TEXT NOT NULL,
      venue TEXT,
      price_tiers TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      show_id INTEGER NOT NULL,
      member_id TEXT NOT NULL,
      member_name TEXT NOT NULL,
      price_tier TEXT NOT NULL,
      ticket_price INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id TEXT NOT NULL,
      member_name TEXT,
      last_five TEXT NOT NULL,
      note TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS blacklist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account TEXT NOT NULL,
      reason TEXT,
      reported_by TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS whitelist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account TEXT NOT NULL,
      reason TEXT,
      reported_by TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS admins (
      user_id TEXT PRIMARY KEY,
      name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 預設第一位管理員（從環境變數）
  if (process.env.ADMIN_USER_ID) {
    db.prepare('INSERT OR IGNORE INTO admins (user_id, name) VALUES (?, ?)')
      .run(process.env.ADMIN_USER_ID, '主管理員');
  }
}

// ====== 工具函式 ======
function isAdmin(userId) {
  // 如果還沒設定任何管理員，第一個說話的人自動成為管理員
  const count = db.prepare('SELECT COUNT(*) as c FROM admins').get().c;
  if (count === 0) {
    db.prepare('INSERT INTO admins (user_id, name) VALUES (?, ?)').run(userId, '主管理員');
    return true;
  }
  return !!db.prepare('SELECT 1 FROM admins WHERE user_id = ?').get(userId);
}

function parseDate(s) {
  if (!s) return null;
  const cleaned = s.replace(/\//g, '-').trim();
  const d = new Date(cleaned + 'T00:00:00');
  return isNaN(d.getTime()) ? null : d;
}

function fmtDate(s) {
  const d = new Date(s);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
}

function daysBetween(d1, d2) {
  const a = new Date(d1); a.setHours(0, 0, 0, 0);
  const b = new Date(d2); b.setHours(0, 0, 0, 0);
  return Math.floor((b - a) / 86400000);
}

function tierName(rank) {
  return ['最高票價區', '次高票價區', '第三票價區', '第四票價區'][rank - 1] || '其餘票價區';
}

function tierRank(name) {
  const i = ['最高票價區', '次高票價區', '第三票價區', '第四票價區'].indexOf(name);
  return i === -1 ? 5 : i + 1;
}

// 行政費計算（依照公告規則）
function calcAdminFee(rank, totalQty) {
  if (totalQty >= 10) {
    if (rank <= 2) return 2500;
    if (rank <= 4) return 2000;
    return 1500;
  } else {
    if (rank <= 2) return Math.max(Math.round(2500 / 3), 2000); // 保底 2000
    return Math.max(Math.round(2000 / 3), 1000); // 保底 1000
  }
}

async function reply(event, text) {
  return client.replyMessage(event.replyToken, { type: 'text', text });
}

async function getUserName(event) {
  try {
    const uid = event.source.userId;
    let p;
    if (event.source.groupId) p = await client.getGroupMemberProfile(event.source.groupId, uid);
    else if (event.source.roomId) p = await client.getRoomMemberProfile(event.source.roomId, uid);
    else p = await client.getProfile(uid);
    return p.displayName;
  } catch {
    return '成員';
  }
}

// ====== 主訊息處理 ======
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return null;

  const text = event.message.text.trim();
  const userId = event.source.userId;
  const userName = await getUserName(event);

  // 取得我的 User ID（用來設定第一位管理員）
  if (text === '我的ID' || text === '我的id') {
    return reply(event, `👤 你的 User ID：\n${userId}\n\n（請複製這串，部署時可設為管理員）`);
  }

  const parts = text.split(/\s+/);
  const cmd = parts[0];

  try {
    switch (cmd) {
      // 訂單相關
      case '下單': return handleOrder(event, parts.slice(1), userId, userName);
      case '我的訂單':
      case '查訂單': return handleMyOrders(event, userId, userName);
      case '取消訂單': return handleCancel(event, parts.slice(1), userId, userName);
      case '場次統計':
      case '訂單統計':
      case '總覽': return handleStats(event, parts.slice(1));

      // 行政費
      case '行政費':
      case '試算': return handleFee(event, parts.slice(1));
      case '行政費說明':
      case '費用說明': return reply(event, getFeeRules());

      // 黑白名單
      case '查黑名單': return handleCheckList(event, parts.slice(1), 'blacklist');
      case '查白名單': return handleCheckList(event, parts.slice(1), 'whitelist');
      case '加黑名單': return handleAddList(event, parts.slice(1), userId, userName, 'blacklist');
      case '加白名單': return handleAddList(event, parts.slice(1), userId, userName, 'whitelist');
      case '黑名單列表': return handleListAll(event, userId, 'blacklist');
      case '白名單列表': return handleListAll(event, userId, 'whitelist');

      // 匯款
      case '匯款確認':
      case '付款確認': return handlePayment(event, parts.slice(1), userId, userName);
      case '匯款列表': return handlePaymentList(event, userId);

      // 場次管理（管理員）
      case '新增場次': return handleAddShow(event, parts.slice(1), userId);
      case '場次列表': return handleListShows(event);
      case '刪除場次': return handleDeleteShow(event, parts.slice(1), userId);

      // 確認流程（管理員）
      case '發送確認': return handleSendConfirm(event, parts.slice(1), userId);

      // 異議
      case '申請異議': return handleDispute(event, parts.slice(1), userId, userName);

      // 規章
      case '規章':
      case '群組規章': return reply(event, getRules());
      case '流程':
      case '流程說明': return reply(event, getProcess());

      // 管理員
      case '新增管理員': return handleAddAdmin(event, parts.slice(1), userId);
      case '管理員列表': return handleListAdmins(event, userId);

      // 說明
      case '幫助':
      case '說明':
      case '指令':
      case 'help':
      case 'Help': return reply(event, getHelp(isAdmin(userId)));

      default: return null; // 不是指令就不回應
    }
  } catch (err) {
    console.error('處理錯誤：', err);
    return reply(event, '❌ 系統發生錯誤，請聯繫管理員或稍後再試。');
  }
}

// ====== 1. 下單功能 ======
async function handleOrder(event, args, userId, userName) {
  if (args.length < 3) {
    const shows = db.prepare('SELECT * FROM shows ORDER BY show_date').all();
    if (shows.length === 0) return reply(event, '❌ 目前沒有開放下單的場次。請等待管理員建立場次。');

    let msg = '📋 【下單方式】\n指令格式：\n`下單 [場次編號] [票價] [張數]`\n\n📅 目前可下單場次：\n';
    shows.forEach(s => {
      const tiers = JSON.parse(s.price_tiers);
      msg += `\n🎵 編號 ${s.id}：${s.name}\n`;
      msg += `   演出：${fmtDate(s.show_date)}\n`;
      msg += `   搶票日：${fmtDate(s.ticket_sale_date)}\n`;
      msg += `   票價：${tiers.map(t => `$${t}`).join(' / ')}\n`;
    });
    msg += '\n💡 範例：下單 1 7880 2\n（訂第1號場次，票價$7880，2張）';
    return reply(event, msg);
  }

  const showId = parseInt(args[0]);
  const price = parseInt(args[1]);
  const qty = parseInt(args[2]);

  if (isNaN(showId) || isNaN(price) || isNaN(qty)) {
    return reply(event, '❌ 格式錯誤！\n範例：下單 1 7880 2');
  }
  if (qty <= 0 || qty > 20) return reply(event, '❌ 張數需在 1-20 之間。');

  const show = db.prepare('SELECT * FROM shows WHERE id = ?').get(showId);
  if (!show) return reply(event, `❌ 找不到編號 ${showId} 的場次。輸入「場次列表」查詢。`);

  const tiers = JSON.parse(show.price_tiers);
  if (!tiers.includes(price)) {
    return reply(event, `❌ 票價 $${price} 不在此場次選項中。\n可選票價：${tiers.map(t => `$${t}`).join('、')}`);
  }

  // ⛔ 關鍵：搶票日前 3 天內不受理
  const days = daysBetween(new Date(), show.ticket_sale_date);
  if (days < 0) {
    return reply(event, `⛔ 此場次搶票日（${fmtDate(show.ticket_sale_date)}）已過，無法下單。`);
  }
  if (days <= 3) {
    return reply(event,
      `⛔ 【訂單不受理】\n\n` +
      `距離「${show.name}」搶票日（${fmtDate(show.ticket_sale_date)}）僅剩 ${days} 天，` +
      `已進入搶票準備期。\n\n` +
      `❌ 依規定搶票日前 3 天起停止收單，造成不便敬請見諒。\n\n` +
      `如有特殊情況請私訊管理員。`
    );
  }

  const rank = tiers.indexOf(price) + 1;
  const tName = tierName(rank);

  db.prepare('INSERT INTO orders (show_id, member_id, member_name, price_tier, ticket_price, quantity) VALUES (?, ?, ?, ?, ?, ?)')
    .run(showId, userId, userName, tName, price, qty);

  const totalQty = db.prepare('SELECT SUM(quantity) as t FROM orders WHERE show_id = ? AND member_id = ? AND status != "cancelled"')
    .get(showId, userId).t || 0;

  const fee = calcAdminFee(rank, totalQty);
  const faceTotal = price * qty;
  const feeTotal = fee * qty;

  return reply(event,
    `✅ 【訂單已登記】\n\n` +
    `👤 ${userName}\n` +
    `🎵 ${show.name}\n` +
    `📅 演出：${fmtDate(show.show_date)}\n` +
    `💰 票價：$${price}（${tName}）\n` +
    `🎫 張數：${qty} 張\n` +
    `📦 本場次累計：${totalQty} 張\n` +
    `\n💵 費用預估：\n` +
    `   票面：$${faceTotal.toLocaleString()}\n` +
    `   行政費：$${feeTotal.toLocaleString()}（$${fee}/張）\n` +
    `\n⚠️ 行政費依最終訂單量調整。\n` +
    `如需取消請輸入：取消訂單 ${showId}`
  );
}

// ====== 2. 我的訂單 ======
async function handleMyOrders(event, userId, userName) {
  const orders = db.prepare(`
    SELECT o.*, s.name as show_name, s.show_date, s.ticket_sale_date
    FROM orders o JOIN shows s ON o.show_id = s.id
    WHERE o.member_id = ? AND o.status != 'cancelled'
    ORDER BY s.show_date
  `).all(userId);

  if (orders.length === 0) return reply(event, `📭 ${userName}，您目前沒有有效訂單。`);

  const byShow = {};
  orders.forEach(o => {
    if (!byShow[o.show_id]) byShow[o.show_id] = { name: o.show_name, show_date: o.show_date, ticket_sale_date: o.ticket_sale_date, items: [] };
    byShow[o.show_id].items.push(o);
  });

  let msg = `📋 【${userName} 的訂單】\n`;
  for (const [sid, s] of Object.entries(byShow)) {
    const total = s.items.reduce((sum, o) => sum + o.quantity, 0);
    msg += `\n🎵 ${s.name}（編號${sid}）\n`;
    msg += `   📅 演出：${fmtDate(s.show_date)}\n`;
    msg += `   🎫 搶票日：${fmtDate(s.ticket_sale_date)}\n`;
    s.items.forEach(o => msg += `   • $${o.ticket_price} × ${o.quantity}張\n`);
    msg += `   📦 合計 ${total} 張\n`;

    const face = s.items.reduce((sum, o) => sum + o.ticket_price * o.quantity, 0);
    const fee = s.items.reduce((sum, o) => sum + calcAdminFee(tierRank(o.price_tier), total) * o.quantity, 0);
    msg += `   💵 票面 $${face.toLocaleString()} ｜ 行政費約 $${fee.toLocaleString()}\n`;
  }
  return reply(event, msg);
}

// ====== 3. 取消訂單 ======
async function handleCancel(event, args, userId, userName) {
  if (args.length < 1) return reply(event, '格式：取消訂單 [場次編號]');

  const showId = parseInt(args[0]);
  const show = db.prepare('SELECT * FROM shows WHERE id = ?').get(showId);
  if (!show) return reply(event, `❌ 找不到場次 ${showId}。`);

  // 搶票日起不可取消
  if (daysBetween(new Date(), show.ticket_sale_date) <= 0) {
    return reply(event,
      `⛔ 無法取消\n「${show.name}」已進入搶票日，依規章搶票日起不接受取消或退款。\n如有異議請聯繫管理員。`
    );
  }

  const orders = db.prepare('SELECT * FROM orders WHERE show_id = ? AND member_id = ? AND status != "cancelled"').all(showId, userId);
  if (orders.length === 0) return reply(event, `📭 您在「${show.name}」沒有訂單。`);

  const total = orders.reduce((s, o) => s + o.quantity, 0);
  db.prepare('UPDATE orders SET status = "cancelled" WHERE show_id = ? AND member_id = ? AND status != "cancelled"').run(showId, userId);

  return reply(event, `✅ 已取消「${show.name}」的全部訂單（${total}張）。`);
}

// ====== 4. 場次統計 ======
async function handleStats(event, args) {
  let shows;
  if (args.length > 0 && !isNaN(parseInt(args[0]))) {
    shows = db.prepare('SELECT * FROM shows WHERE id = ?').all(parseInt(args[0]));
  } else {
    shows = db.prepare('SELECT * FROM shows ORDER BY show_date').all();
  }

  if (shows.length === 0) return reply(event, '📭 沒有場次資料。');

  let msg = '📊 【訂單統計】\n';
  for (const show of shows) {
    const orders = db.prepare('SELECT * FROM orders WHERE show_id = ? AND status != "cancelled" ORDER BY ticket_price DESC, member_name').all(show.id);
    const total = orders.reduce((s, o) => s + o.quantity, 0);

    msg += `\n━━━━━━━━━━━━━━\n🎵 ${show.name}\n`;
    msg += `📅 演出：${fmtDate(show.show_date)}\n`;
    msg += `🎫 搶票日：${fmtDate(show.ticket_sale_date)}\n`;
    msg += `📦 總訂單：${total} 張\n`;

    if (orders.length === 0) { msg += '（暫無訂單）\n'; continue; }

    // 依票價分組
    const byPrice = {};
    orders.forEach(o => {
      if (!byPrice[o.ticket_price]) byPrice[o.ticket_price] = { tier: o.price_tier, members: {} };
      byPrice[o.ticket_price].members[o.member_name] = (byPrice[o.ticket_price].members[o.member_name] || 0) + o.quantity;
    });

    msg += `\n💰 各票價統計：`;
    Object.keys(byPrice).sort((a, b) => b - a).forEach(p => {
      const d = byPrice[p];
      const sub = Object.values(d.members).reduce((s, q) => s + q, 0);
      msg += `\n\n[$${parseInt(p).toLocaleString()} ${d.tier}] ${sub}張`;
      Object.entries(d.members).forEach(([n, q]) => msg += `\n  👤 ${n}：${q}張`);
    });

    // 各成員總計
    const memTotal = {};
    orders.forEach(o => memTotal[o.member_name] = (memTotal[o.member_name] || 0) + o.quantity);
    msg += `\n\n👥 各成員合計：`;
    Object.entries(memTotal).sort((a, b) => b[1] - a[1]).forEach(([n, q]) => msg += `\n  ${n}：${q}張`);
  }

  return reply(event, msg);
}

// ====== 5. 行政費試算 ======
async function handleFee(event, args) {
  if (args.length < 2) {
    return reply(event, '💰 試算格式：\n行政費 [票價] [張數]\n範例：行政費 7880 8');
  }
  const price = parseInt(args[0]);
  const qty = parseInt(args[1]);
  if (isNaN(price) || isNaN(qty)) return reply(event, '❌ 請輸入數字。');

  // 因為不知道在哪個場次，所以依絕對票價推估
  let rank;
  if (price >= 6000) rank = 1;
  else if (price >= 4000) rank = 3;
  else rank = 5;

  const fee = calcAdminFee(rank, qty);
  const face = price * qty;
  const feeTotal = fee * qty;
  const status = qty >= 10 ? '✅ 已達10張（常態費率）' : '⚠️ 未達10張（優惠費率）';

  return reply(event,
    `💰 【行政費試算】\n\n` +
    `🎫 票價：$${price.toLocaleString()}\n` +
    `📦 張數：${qty} 張\n` +
    `📊 ${status}\n\n` +
    `票面：$${face.toLocaleString()}\n` +
    `行政費：$${fee}/張 × ${qty} = $${feeTotal.toLocaleString()}\n` +
    `━━━━━━━━━━\n` +
    `💵 總額約 $${(face + feeTotal).toLocaleString()}\n\n` +
    `⚠️ 實際費用以該場次最終訂單量為準。`
  );
}

// ====== 6. 黑白名單 ======
async function handleCheckList(event, args, type) {
  if (args.length === 0) return reply(event, `格式：查${type === 'blacklist' ? '黑' : '白'}名單 [帳號]`);

  const account = args.join(' ');
  const results = db.prepare(`SELECT * FROM ${type} WHERE account LIKE ? ORDER BY created_at DESC`).all(`%${account}%`);

  if (results.length === 0) {
    const tip = type === 'blacklist'
      ? `✅ 黑名單查無「${account}」\n建議仍保持謹慎。`
      : `❓ 白名單查無「${account}」\n尚未列為優質客。`;
    return reply(event, tip);
  }

  const icon = type === 'blacklist' ? '🚫' : '🌟';
  const title = type === 'blacklist' ? '黑名單' : '白名單';
  let msg = `${icon} 【${title}查詢：${account}】\n找到 ${results.length} 筆：\n`;
  results.forEach((r, i) => {
    msg += `\n${i + 1}. ${r.account}\n   ${r.reason || '（無備註）'}\n   登錄：${fmtDate(r.created_at)}`;
  });
  if (type === 'blacklist') msg += '\n\n❗ 建議先收全額或婉拒交易！';
  else msg += '\n\n👍 此客評價良好，可考慮優先配票！';
  return reply(event, msg);
}

async function handleAddList(event, args, userId, userName, type) {
  if (!isAdmin(userId)) return reply(event, '❌ 此功能限管理員。如要通報，請私訊管理員。');
  if (args.length < 2) return reply(event, `格式：加${type === 'blacklist' ? '黑' : '白'}名單 [帳號] [原因]`);

  const account = args[0];
  const reason = args.slice(1).join(' ');
  db.prepare(`INSERT INTO ${type} (account, reason, reported_by) VALUES (?, ?, ?)`).run(account, reason, userName);

  const icon = type === 'blacklist' ? '🚫' : '🌟';
  return reply(event, `${icon} 已加入${type === 'blacklist' ? '黑' : '白'}名單\n帳號：${account}\n原因：${reason}\n登錄人：${userName}`);
}

async function handleListAll(event, userId, type) {
  if (!isAdmin(userId)) return reply(event, '❌ 完整名單限管理員查詢。一般成員可使用「查' + (type === 'blacklist' ? '黑' : '白') + '名單 [帳號]」查特定人。');

  const results = db.prepare(`SELECT * FROM ${type} ORDER BY created_at DESC LIMIT 30`).all();
  if (results.length === 0) return reply(event, '名單目前為空。');

  const icon = type === 'blacklist' ? '🚫' : '🌟';
  const title = type === 'blacklist' ? '黑名單' : '白名單';
  let msg = `${icon} 【${title}（最新30筆）】\n`;
  results.forEach((r, i) => msg += `\n${i + 1}. ${r.account} - ${r.reason || '無備註'}`);
  return reply(event, msg);
}

// ====== 7. 匯款確認 ======
async function handlePayment(event, args, userId, userName) {
  if (args.length === 0) return reply(event, '格式：匯款確認 [後五碼] [備註(選填)]\n範例：匯款確認 12345 aespa 2張');

  const lastFive = args[0];
  const note = args.slice(1).join(' ');
  if (!/^\d{5}$/.test(lastFive)) return reply(event, '❌ 後五碼必須是 5 位數字。');

  db.prepare('INSERT INTO payments (member_id, member_name, last_five, note) VALUES (?, ?, ?, ?)').run(userId, userName, lastFive, note);

  return reply(event,
    `✅ 【匯款確認已記錄】\n\n` +
    `👤 ${userName}\n` +
    `💳 後五碼：${lastFive}\n` +
    `📝 備註：${note || '（無）'}\n` +
    `⏰ ${new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}\n\n` +
    `管理員會盡快核對，如逾時未確認請私訊。`
  );
}

async function handlePaymentList(event, userId) {
  if (!isAdmin(userId)) return reply(event, '❌ 此功能限管理員。');
  const list = db.prepare('SELECT * FROM payments ORDER BY created_at DESC LIMIT 30').all();
  if (list.length === 0) return reply(event, '尚無匯款紀錄。');

  let msg = '💳 【最新30筆匯款】\n';
  list.forEach((p, i) => {
    msg += `\n${i + 1}. ${p.member_name} - ${p.last_five}`;
    if (p.note) msg += ` (${p.note})`;
    msg += `\n   ${new Date(p.created_at).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}`;
  });
  return reply(event, msg);
}

// ====== 8. 場次管理 ======
async function handleAddShow(event, args, userId) {
  if (!isAdmin(userId)) return reply(event, '❌ 此功能限管理員。');
  if (args.length < 5) {
    return reply(event,
      '📝 新增場次格式：\n' +
      '新增場次 [名稱] [演出日期] [搶票日] [地點] [票價(逗號分隔)]\n\n' +
      '範例：\n新增場次 aespa演唱會 2024-06-15 2024-05-01 台北小巨蛋 7880,6880,4880,3880,2880\n\n' +
      '⚠️ 日期格式：YYYY-MM-DD\n⚠️ 名稱與地點不能有空格'
    );
  }

  const [name, showStr, saleStr, venue, pricesStr] = args;
  if (!parseDate(showStr)) return reply(event, '❌ 演出日期格式錯誤，應為 YYYY-MM-DD');
  if (!parseDate(saleStr)) return reply(event, '❌ 搶票日格式錯誤，應為 YYYY-MM-DD');

  const prices = pricesStr.split(',').map(p => parseInt(p.trim())).filter(p => !isNaN(p));
  if (prices.length === 0) return reply(event, '❌ 票價格式錯誤，例：7880,6880,4880');
  prices.sort((a, b) => b - a);

  const r = db.prepare('INSERT INTO shows (name, show_date, ticket_sale_date, venue, price_tiers) VALUES (?, ?, ?, ?, ?)')
    .run(name, showStr, saleStr, venue, JSON.stringify(prices));

  return reply(event,
    `✅ 場次新增成功！\n\n` +
    `🎵 編號：${r.lastInsertRowid}\n` +
    `🎵 名稱：${name}\n` +
    `📅 演出：${fmtDate(showStr)}\n` +
    `🎫 搶票日：${fmtDate(saleStr)}\n` +
    `📍 地點：${venue}\n` +
    `💰 票價：${prices.map(p => `$${p}`).join('、')}\n\n` +
    `成員可使用「下單 ${r.lastInsertRowid} [票價] [張數]」下單。`
  );
}

async function handleListShows(event) {
  const shows = db.prepare('SELECT * FROM shows ORDER BY show_date').all();
  if (shows.length === 0) return reply(event, '📭 目前沒有任何場次。');

  let msg = '🎵 【場次列表】\n';
  shows.forEach(s => {
    const tiers = JSON.parse(s.price_tiers);
    const days = daysBetween(new Date(), s.ticket_sale_date);
    let status;
    if (days < 0) status = '🔴 已過搶票日';
    else if (days <= 3) status = '🟡 已停止收單';
    else status = `🟢 收單中（剩 ${days} 天）`;

    const c = db.prepare('SELECT SUM(quantity) as t FROM orders WHERE show_id = ? AND status != "cancelled"').get(s.id).t || 0;

    msg += `\n編號 ${s.id}：${s.name}\n`;
    msg += `📅 演出：${fmtDate(s.show_date)}\n`;
    msg += `🎫 搶票日：${fmtDate(s.ticket_sale_date)}\n`;
    msg += `📍 ${s.venue || '未設定'}\n`;
    msg += `💰 ${tiers.map(t => `$${t}`).join('/')}\n`;
    msg += `📦 已訂 ${c} 張 ｜ ${status}\n`;
  });
  return reply(event, msg);
}

async function handleDeleteShow(event, args, userId) {
  if (!isAdmin(userId)) return reply(event, '❌ 此功能限管理員。');
  if (args.length === 0) return reply(event, '格式：刪除場次 [場次編號]');

  const id = parseInt(args[0]);
  const s = db.prepare('SELECT * FROM shows WHERE id = ?').get(id);
  if (!s) return reply(event, `❌ 找不到場次 ${id}。`);

  db.prepare('UPDATE orders SET status = "cancelled" WHERE show_id = ?').run(id);
  db.prepare('DELETE FROM shows WHERE id = ?').run(id);
  return reply(event, `✅ 已刪除「${s.name}」及其訂單。`);
}

// ====== 9. 搶票前確認 ======
async function handleSendConfirm(event, args, userId) {
  if (!isAdmin(userId)) return reply(event, '❌ 此功能限管理員。');
  if (args.length === 0) return reply(event, '格式：發送確認 [場次編號]');

  const id = parseInt(args[0]);
  const show = db.prepare('SELECT * FROM shows WHERE id = ?').get(id);
  if (!show) return reply(event, `❌ 找不到場次 ${id}。`);

  const orders = db.prepare('SELECT * FROM orders WHERE show_id = ? AND status != "cancelled"').all(id);
  if (orders.length === 0) return reply(event, '📭 此場次沒有待確認訂單。');

  const byMember = {};
  orders.forEach(o => {
    if (!byMember[o.member_id]) byMember[o.member_id] = { name: o.member_name, items: [] };
    byMember[o.member_id].items.push(o);
  });

  let msg = `📢 【搶票日前確認通知】\n\n🎵 ${show.name}\n📅 演出：${fmtDate(show.show_date)}\n🎫 搶票日：${fmtDate(show.ticket_sale_date)}\n\n請以下成員確認您的訂單：\n`;

  for (const m of Object.values(byMember)) {
    const total = m.items.reduce((s, o) => s + o.quantity, 0);
    const face = m.items.reduce((s, o) => s + o.ticket_price * o.quantity, 0);
    msg += `\n👤 ${m.name}：共 ${total} 張，票面 $${face.toLocaleString()}`;
    m.items.forEach(o => msg += `\n   • $${o.ticket_price} × ${o.quantity}張`);
  }
  msg += '\n\n⚠️ 實名制場次請私訊管理員提供身份資料。\n❗ 搶票日起不得取消，請務必確認並完成票面金額匯款！';
  return reply(event, msg);
}

// ====== 10. 異議申請 ======
async function handleDispute(event, args, userId, userName) {
  if (args.length === 0) {
    return reply(event,
      '⚖️ 【申請異議】\n格式：申請異議 [場次編號] [說明]\n範例：申請異議 1 配票數量與訂單不符\n\n' +
      '⚠️ 請於收到票券/結算後 24 小時內提出，逾時恕不受理。'
    );
  }
  const id = parseInt(args[0]);
  const desc = args.slice(1).join(' ');
  if (!desc) return reply(event, '❌ 請說明異議內容。');

  const s = db.prepare('SELECT * FROM shows WHERE id = ?').get(id);
  const sname = s ? s.name : `場次${id}`;

  return reply(event,
    `⚖️ 【異議已記錄】\n\n👤 申請人：${userName}\n🎵 場次：${sname}\n📝 內容：${desc}\n⏰ ${new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}\n\n📌 管理員會於 24 小時內回應，如急請直接私訊。`
  );
}

// ====== 11. 管理員管理 ======
async function handleAddAdmin(event, args, userId) {
  if (!isAdmin(userId)) return reply(event, '❌ 此功能限管理員。');
  if (args.length < 1) return reply(event, '格式：新增管理員 [User ID] [名稱(選填)]\n（成員可輸入「我的ID」取得自己的 User ID）');

  const newId = args[0];
  const name = args[1] || '管理員';
  db.prepare('INSERT OR IGNORE INTO admins (user_id, name) VALUES (?, ?)').run(newId, name);
  return reply(event, `✅ 已將 ${name}（${newId}）設為管理員。`);
}

async function handleListAdmins(event, userId) {
  if (!isAdmin(userId)) return reply(event, '❌ 此功能限管理員。');
  const list = db.prepare('SELECT * FROM admins').all();
  let msg = '👑 【管理員列表】\n';
  list.forEach((a, i) => msg += `\n${i + 1}. ${a.name}`);
  return reply(event, msg);
}

// ====== 文字內容 ======
function getHelp(isAdminUser) {
  let msg = `🤖 【票務 Bot 指令說明】\n
🎟️ 訂單
• 下單 → 查看可下單場次
• 下單 [場次編號] [票價] [張數]
• 我的訂單 / 查訂單
• 取消訂單 [場次編號]
• 場次列表
• 場次統計 / 場次統計 [場次編號]

💰 費用
• 行政費 [票價] [張數]
• 行政費說明

🔍 名單查詢
• 查黑名單 [帳號]
• 查白名單 [帳號]

💳 匯款
• 匯款確認 [後五碼] [備註]

📋 規章
• 規章
• 流程說明

⚖️ 其他
• 申請異議 [場次編號] [說明]
• 我的ID（查詢自己的 User ID）`;

  if (isAdminUser) {
    msg += `\n\n👑 管理員功能
• 新增場次 [名稱] [演出日期] [搶票日] [地點] [票價]
• 刪除場次 [場次編號]
• 加黑名單 [帳號] [原因]
• 加白名單 [帳號] [備註]
• 黑名單列表 / 白名單列表
• 匯款列表
• 發送確認 [場次編號]
• 新增管理員 [User ID] [名稱]
• 管理員列表`;
  }
  return msg;
}

function getFeeRules() {
  return `💰 【行政費收費標準】

🔵 常態費率（總訂單 ≥ 10 張）
• 最高、次高票價區：$2,500/張
• 第三、第四高票價區：$2,000/張
• 其餘票價區：$1,500/張

🟡 優惠費率（單一成員 < 10 張）
最低行政費保護：
• 最高、次高票價區：最低 $2,000/張
• 其餘票價區：最低 $1,000/張

📝 範例（aespa，8張）
• $7,880 / $6,880：$2,500÷3=$833 < 保底 → 收 $2,000
• 其餘票價：→ 收 $1,000

💡 試算：輸入「行政費 [票價] [張數]」`;
}

function getRules() {
  return `📢 【群組規章摘要】

👥 進群規範
• 審核制，不得隨意邀請陌生人
• 需多數人同意才能邀請新成員

🎟️ 預約流程
• 搶票日前 4 天以上方可下單（前 3 天內截止）
• 搶票前一天進行確認
• 實名制場次須提供完整身份資料

💰 費用
• 票面金額：搶票前一天確認時收取
• 行政費：最終分配票券後結清（可月結）

⚠️ 退款政策
• 搶票日起不接受取消或退款
• 場次延期：不退款
• 場次取消：退票面，行政費不退

💳 匯款
• 匯款後必須提供後五碼或截圖私訊管理員

🔒 保密義務
• 群組資訊嚴禁外流

⚖️ 異議
• 收到票券/結算後 24 小時內提出
• 逾時恕不受理`;
}

function getProcess() {
  return `🎟️ 【交易流程】

① 成員下單（搶票日 4 天前截止）
   ↓
② 搶票前一天，管理員發送確認
   ↓
③ 成員確認場次/票價/張數/身份資料
   ↓
④ 繳交票面金額（搶票前完成）
   ↓
⑤ 搶票日當天搶票
   ↓
⑥ 通知配票結果（票源不足則比例配票並退差額）
   ↓
⑦ 24 小時內如有異議須提出
   ↓
⑧ 結清行政費（當月底，或月結）

⚠️ 搶票日後不接受取消，確認再下單！`;
}

// ====== 定時提醒 ======
function setupCron() {
  // 每天早上 9 點檢查（台北時間）
  cron.schedule('0 9 * * *', async () => {
    const shows = db.prepare('SELECT * FROM shows').all();
    const groupId = process.env.LINE_GROUP_ID;
    if (!groupId) return;

    for (const s of shows) {
      const days = daysBetween(new Date(), s.ticket_sale_date);

      if (days === 4) {
        await client.pushMessage(groupId, {
          type: 'text',
          text: `⚠️ 【最後下單通知】\n「${s.name}」搶票日（${fmtDate(s.ticket_sale_date)}）還有 4 天！\n\n🚨 明天起將停止收單，請尚未下單的成員儘速完成！`
        }).catch(e => console.error(e));
      }

      if (days === 1) {
        const orders = db.prepare('SELECT * FROM orders WHERE show_id = ? AND status != "cancelled"').all(s.id);
        const totalQty = orders.reduce((sum, o) => sum + o.quantity, 0);
        await client.pushMessage(groupId, {
          type: 'text',
          text: `🎫 【明日搶票】\n「${s.name}」明天（${fmtDate(s.ticket_sale_date)}）搶票！\n📦 目前共 ${totalQty} 張預訂\n\n📌 請各成員：\n• 確認訂單內容\n• 完成票面匯款\n• 實名制場次提供身份資料\n\n管理員稍後將發送個別確認清單。`
        }).catch(e => console.error(e));
      }
    }
  }, { timezone: 'Asia/Taipei' });

  console.log('✅ 定時提醒已啟動（每天 9:00 台北時間）');
}

// ====== Webhook 端點 ======
app.post('/webhook', line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then(r => res.json(r))
    .catch(e => { console.error(e); res.status(500).end(); });
});

// 健康檢查（用來防止伺服器睡眠）
app.get('/', (req, res) => res.send('🤖 LINE Ticket Bot is running!'));
app.get('/health', (req, res) => res.json({ status: 'OK', time: new Date().toISOString() }));

// ====== 啟動 ======
initDB();
setupCron();
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🤖 LINE Bot 已啟動，Port ${PORT}`));
