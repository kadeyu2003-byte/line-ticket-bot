'use strict';
const line = require('@line/bot-sdk');
const express = require('express');
const Database = require('better-sqlite3');
const cron = require('node-cron');
require('dotenv').config();

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new line.Client(config);
const app = express();
const db = new Database('ticketbot.db');

const GROUP_ID = () => process.env.LINE_GROUP_ID || null;
const DEFAULT_CAPS = { 1: 30, 2: 36 };
const CAP_OTHER = 50;

const FIELDS = {
  '姓名': 'name', '名字': 'name', '名': 'name',
  '身分證': 'id_no', '身份證': 'id_no', '證號': 'id_no', '證': 'id_no',
  '電話': 'phone', '手機': 'phone', '電': 'phone',
  '生日': 'birthday', '生': 'birthday',
  '地址': 'address', '址': 'address',
  '帳號': 'site_acc', '帳': 'site_acc',
  '密碼': 'site_pwd', '密': 'site_pwd',
  '備註': 'note', '其他': 'note'
};
const FIELD_LABEL = {
  name: '姓名', id_no: '身分證', phone: '電話', birthday: '生日',
  address: '地址', site_acc: '帳號', site_pwd: '密碼', note: '備註'
};

// ====== GitHub 備份初始化 ======
let octokit = null;
try {
  const { Octokit } = require('@octokit/rest');
  if (process.env.GITHUB_TOKEN) {
    octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
    console.log('✅ GitHub 備份模組已載入');
  } else {
    console.log('⚠️ 未設定 GITHUB_TOKEN，備份功能停用');
  }
} catch(e) {
  console.log('⚠️ Octokit 模組載入失敗:', e.message);
}
const GH_OWNER = process.env.GITHUB_OWNER || '';
const GH_REPO = process.env.GITHUB_REPO || 'line-ticket-bot';
const BK_BRANCH = 'data';
const BK_TABLES = ['shows', 'orders', 'realname', 'allocations', 'payments', 'blacklist', 'whitelist', 'admins'];
let backupTimer = null;
let lastBackupTime = null;

function initDB() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS shows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, show_date TEXT, ticket_sale_date TEXT,
      venue TEXT, source_url TEXT,
      price_tiers TEXT, caps TEXT DEFAULT '{}',
      is_real_name INTEGER DEFAULT 0,
      required_fields TEXT DEFAULT '[]',
      tickets_per_account INTEGER DEFAULT 1,
      is_allocated INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      show_id INTEGER, member_id TEXT, member_name TEXT,
      price_tier TEXT, ticket_price INTEGER, quantity INTEGER,
      order_seq INTEGER DEFAULT 0, status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS realname (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      show_id INTEGER, member_id TEXT, member_name TEXT,
      ticket_price INTEGER,
      name TEXT, id_no TEXT, phone TEXT, birthday TEXT,
      address TEXT, site_acc TEXT, site_pwd TEXT, note TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS allocations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      show_id INTEGER, member_id TEXT, member_name TEXT,
      ticket_price INTEGER, ordered INTEGER, received INTEGER,
      shortfall INTEGER DEFAULT 0, refund_amount INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id TEXT, member_name TEXT, last_five TEXT, note TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS blacklist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account TEXT, reason TEXT, reported_by TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS whitelist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account TEXT, reason TEXT, reported_by TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS admins (
      user_id TEXT PRIMARY KEY, name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  if (process.env.ADMIN_USER_ID) {
    db.prepare('INSERT OR IGNORE INTO admins (user_id,name) VALUES (?,?)').run(process.env.ADMIN_USER_ID, '主管理員');
  }
}

// ====== GitHub 備份函式 ======
async function ensureBackupBranch() {
  if (!octokit || !GH_OWNER) return false;
  try {
    await octokit.repos.getBranch({ owner: GH_OWNER, repo: GH_REPO, branch: BK_BRANCH });
    return true;
  } catch(e) {
    if (e.status === 404) {
      try {
        const { data: main } = await octokit.repos.getBranch({ owner: GH_OWNER, repo: GH_REPO, branch: 'main' });
        await octokit.git.createRef({ owner: GH_OWNER, repo: GH_REPO, ref: `refs/heads/${BK_BRANCH}`, sha: main.commit.sha });
        console.log(`✅ 已建立 GitHub 備份分支「${BK_BRANCH}」`);
        return true;
      } catch(e2) { console.error('建立備份分支失敗:', e2.message); return false; }
    }
    console.error('檢查分支失敗:', e.message);
    return false;
  }
}

async function pushFileToGithub(path, content) {
  const contentStr = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  const contentBase64 = Buffer.from(contentStr, 'utf-8').toString('base64');
  let sha;
  try {
    const { data } = await octokit.repos.getContent({ owner: GH_OWNER, repo: GH_REPO, path, ref: BK_BRANCH });
    sha = data.sha;
  } catch(e) {}
  await octokit.repos.createOrUpdateFileContents({
    owner: GH_OWNER, repo: GH_REPO, path,
    message: `Auto backup ${path} (${new Date().toISOString()})`,
    content: contentBase64, branch: BK_BRANCH, sha
  });
}

async function performBackup() {
  if (!octokit || !GH_OWNER) return false;
  try {
    if (!(await ensureBackupBranch())) return false;
    const snapshot = { updated_at: new Date().toISOString(), version: '2.0' };
    for (const table of BK_TABLES) {
      try { snapshot[table] = db.prepare(`SELECT * FROM ${table}`).all(); }
      catch(e) { console.error(`讀取 ${table} 失敗:`, e.message); snapshot[table] = []; }
    }
    await pushFileToGithub('data/snapshot.json', snapshot);
    // 額外為每個資料表存獨立檔（方便閱讀）
    for (const table of BK_TABLES) {
      if (snapshot[table].length > 0) {
        await pushFileToGithub(`data/${table}.json`, snapshot[table]).catch(e=>console.error(`備份 ${table}:`, e.message));
      }
    }
    lastBackupTime = snapshot.updated_at;
    console.log(`✅ 備份完成 ${lastBackupTime}`);
    return true;
  } catch(e) {
    console.error('備份失敗:', e.message);
    return false;
  }
}

function scheduleBackup() {
  if (!octokit || !GH_OWNER) return;
  if (backupTimer) clearTimeout(backupTimer);
  backupTimer = setTimeout(() => performBackup().catch(console.error), 15000);
}

async function restoreFromBackup() {
  if (!octokit || !GH_OWNER) { console.log('ℹ️ 未設定 GitHub，跳過還原'); return; }
  try {
    if (!(await ensureBackupBranch())) return;
    const { data } = await octokit.repos.getContent({
      owner: GH_OWNER, repo: GH_REPO, path: 'data/snapshot.json', ref: BK_BRANCH
    });
    const snapshot = JSON.parse(Buffer.from(data.content, 'base64').toString('utf-8'));
    let total = 0;
    for (const table of BK_TABLES) {
      if (!snapshot[table] || snapshot[table].length === 0) continue;
      const count = db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c;
      if (count > 0) continue; // 本地已有資料，不覆蓋
      const rows = snapshot[table];
      const keys = Object.keys(rows[0]);
      const stmt = db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`);
      for (const row of rows) {
        try { stmt.run(...keys.map(k => row[k] === undefined ? null : row[k])); total++; }
        catch(e) { console.error(`還原 ${table}:`, e.message); }
      }
    }
    if (total > 0) console.log(`✅ 已從 GitHub 還原 ${total} 筆紀錄（備份於 ${snapshot.updated_at}）`);
    else console.log('ℹ️ 無需還原（本地已有資料或備份為空）');
  } catch(e) {
    if (e.status === 404) console.log('ℹ️ GitHub 沒有備份檔（第一次運行）');
    else console.error('還原失敗:', e.message);
  }
}

// ====== Helpers ======
function isAdmin(uid) {
  const c = db.prepare('SELECT COUNT(*) c FROM admins').get().c;
  if (c === 0) { db.prepare('INSERT INTO admins (user_id,name) VALUES (?,?)').run(uid, '主管理員'); return true; }
  return !!db.prepare('SELECT 1 FROM admins WHERE user_id=?').get(uid);
}
const isGroup = e => e.source.type === 'group' || e.source.type === 'room';
const gid = e => e.source.groupId || e.source.roomId || null;
const today = () => new Date().toISOString().split('T')[0];
function fmtD(s) { if (!s) return '?'; const d = new Date(s + 'T00:00:00'); return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`; }
function dDiff(a, b) { const x = new Date(a); x.setHours(0,0,0,0); const y = new Date(b); y.setHours(0,0,0,0); return Math.floor((y-x)/86400000); }
const tName = r => ['最高票價區','次高票價區','第三票價區','第四票價區'][r-1] || '其餘票價區';
const tRank = n => { const i = ['最高票價區','次高票價區','第三票價區','第四票價區'].indexOf(n); return i===-1?5:i+1; };
const defCap = r => DEFAULT_CAPS[r] || CAP_OTHER;
function calcFee(r, t) { if (t>=10) return r<=2?2500:r<=4?2000:1500; return r<=2?2000:1000; }
function ntStr(n) { return '$' + Number(n).toLocaleString(); }

async function dispName(e) {
  try {
    const uid = e.source.userId;
    if (e.source.groupId) return (await client.getGroupMemberProfile(e.source.groupId, uid)).displayName;
    return (await client.getProfile(uid)).displayName;
  } catch { return '成員'; }
}
async function reply(e, t) { if (!t) return; return client.replyMessage(e.replyToken, { type:'text', text:String(t).substring(0,4999) }); }
async function pushG(t, g) { const x = g || GROUP_ID(); if (!x) return; return client.pushMessage(x, { type:'text', text:String(t).substring(0,4999) }).catch(e=>console.error('pushG:',e.message)); }
async function pushU(u, t) { return client.pushMessage(u, { type:'text', text:String(t).substring(0,4999) }).catch(e=>console.error('pushU:',e.message)); }
async function pushGroupMention(intro, members, gOverride) {
  const g = gOverride || GROUP_ID(); if (!g) return;
  let text = intro + '\n';
  const mentions = [];
  for (const m of members) {
    const tag = `@${m.name}`;
    mentions.push({ type:'user', index:text.length, length:tag.length, userId:m.userId });
    text += `${tag} ${m.note}\n`;
  }
  return client.pushMessage(g, { type:'text', text:text.substring(0,4999), mentions }).catch(e=>console.error('mention:',e.message));
}

async function detectPrices(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120' },
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const raw = html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
    const found = new Set();
    const patterns = [
      /NT\$\s*(\d{1,3}(?:,\d{3})+)/g, /NT\$\s*(\d{4,5})\b/g,
      /\$\s*(\d{1,3}(?:,\d{3})+)/g, /票價[：:]\s*(\d{1,3}(?:,\d{3})*)/g,
      /(\d{1,3}(?:,\d{3})+)\s*元/g,
    ];
    for (const p of patterns) {
      let m;
      while ((m = p.exec(raw)) !== null) {
        const v = parseInt(m[1].replace(/,/g, ''));
        if (v >= 500 && v <= 50000) found.add(v);
      }
    }
    return found.size > 0 ? [...found].sort((a,b) => b-a) : null;
  } catch(e) { console.error('detectPrices:', e.message); return null; }
}

function parseFields(lines) {
  const data = {};
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    const m = t.match(/^([^\s:：=]+)[\s:：=]+(.+)$/);
    if (m) { const fkey = FIELDS[m[1].trim()]; if (fkey) data[fkey] = m[2].trim(); }
  }
  return data;
}

// ====== 主路由 ======
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return null;
  const full = event.message.text.trim();
  const lines = full.split('\n');
  const firstLine = lines[0].trim();
  const restLines = lines.slice(1);
  const uid = event.source.userId;
  const inGrp = isGroup(event);
  const groupId = gid(event);
  const userName = await dispName(event);
  const admin = isAdmin(uid);
  const parts = firstLine.split(/\s+/);
  const cmd = parts[0];

  if (cmd === '我的ID' || cmd === '我的id' || cmd === '群組ID' || cmd === '群組id') {
    let msg = `👤 User ID：\n${uid}`;
    if (groupId) msg += `\n\n👥 群組 ID：\n${groupId}`;
    return reply(event, msg);
  }

  try {
    switch(cmd) {
      case '下單': return cmdOrder(event, parts.slice(1), uid, userName);
      case '我的訂單': case '查訂單': return cmdMyOrders(event, uid, userName, inGrp);
      case '取消訂單': return cmdCancel(event, parts.slice(1), uid);
      case '場次列表': return cmdListShows(event);
      case '場次統計': case '訂單統計': return cmdStats(event, parts.slice(1));
      case '實名': return cmdSubmitRN(event, parts.slice(1), restLines, uid, userName, inGrp);
      case '我的實名': return cmdMyRN(event, parts.slice(1), uid, userName, inGrp);
      case '刪除實名': return cmdDelRN(event, parts.slice(1), uid);
      case '行政費': return cmdFee(event, parts.slice(1));
      case '行政費說明': case '費用說明': return reply(event, txtFee());
      case '查黑名單': return cmdCheckList(event, parts.slice(1), 'blacklist');
      case '查白名單': return cmdCheckList(event, parts.slice(1), 'whitelist');
      case '匯款確認': case '付款確認': return cmdPayment(event, parts.slice(1), uid, userName);
      case '我的明細': return cmdMyDetail(event, parts.slice(1), uid, userName, inGrp);
      case '我的配票': return cmdMyAlloc(event, parts.slice(1), uid, userName, inGrp);
      case '規章': return reply(event, txtRules());
      case '流程': return reply(event, txtProcess());
      case '申請異議': return cmdDispute(event, parts.slice(1), uid, userName);
      // 管理員
      case '上場次': return cmdUrlShow(event, parts.slice(1), uid);
      case '新增場次': return cmdAddShow(event, parts.slice(1), uid);
      case '改場次名稱': return cmdRenameShow(event, parts.slice(1), uid);
      case '設定實名': return cmdSetRN(event, parts.slice(1), uid);
      case '取消實名': return cmdUnsetRN(event, parts.slice(1), uid);
      case '設定實名欄位': return cmdSetFields(event, parts.slice(1), uid);
      case '設定每帳號': return cmdSetTPA(event, parts.slice(1), uid);
      case '查實名': return cmdViewRN(event, parts.slice(1), uid);
      case '設定上限': return cmdSetCap(event, parts.slice(1), uid);
      case '刪除場次': return cmdDelShow(event, parts.slice(1), uid);
      case '發送確認': return cmdSendConfirm(event, parts.slice(1), uid);
      case '開始配票': return cmdStartAlloc(event, parts.slice(1), uid);
      case '配票': return cmdRecordAlloc(event, parts.slice(1), uid);
      case '配票完成': return cmdFinishAlloc(event, parts.slice(1), uid);
      case '加黑名單': return cmdAddList(event, parts.slice(1), uid, userName, 'blacklist');
      case '加白名單': return cmdAddList(event, parts.slice(1), uid, userName, 'whitelist');
      case '黑名單列表': return cmdListAll(event, uid, 'blacklist');
      case '白名單列表': return cmdListAll(event, uid, 'whitelist');
      case '匯款列表': return cmdPayList(event, uid);
      case '群組公告': return cmdAnnounce(event, parts.slice(1).join(' ') + (restLines.length?'\n'+restLines.join('\n'):''), uid);
      case '功能更新': return cmdFeatureUpdate(event, parts.slice(1).join(' ') + (restLines.length?'\n'+restLines.join('\n'):''), uid);
      case '新增管理員': return cmdAddAdmin(event, parts.slice(1), uid);
      case '管理員列表': return cmdListAdmins(event, uid);
      case '立即備份': return cmdManualBackup(event, uid);
      case '備份狀態': return cmdBackupStatus(event, uid);
      case '幫助': case '說明': case '指令': case 'help': return reply(event, txtHelp(admin));
      default: return null;
    }
  } catch(e) { console.error('Error:', e); return reply(event, '❌ 系統錯誤，請稍後再試。'); }
}

// ====== 下單 ======
async function cmdOrder(event, args, uid, userName) {
  if (args.length < 3) {
    const shows = db.prepare('SELECT * FROM shows ORDER BY show_date').all();
    if (shows.length === 0) return reply(event, '❌ 目前沒有開放下單的場次。');
    let msg = '📋 下單格式：\n下單 [場次編號] [票價] [張數]\n\n📅 開放中場次：';
    for (const s of shows) {
      const tiers = JSON.parse(s.price_tiers);
      const caps = JSON.parse(s.caps || '{}');
      const days = dDiff(today(), s.ticket_sale_date);
      if (days < 4) continue;
      msg += `\n\n🎵 #${s.id}：${s.name}${s.is_real_name?' ⚠️實名制':''}`;
      msg += `\n📅 ${fmtD(s.show_date)} ｜ 🎫 ${fmtD(s.ticket_sale_date)}（${days}天後）`;
      tiers.forEach((p,i) => {
        const cap = caps[p] || defCap(i+1);
        const sold = db.prepare('SELECT SUM(quantity) t FROM orders WHERE show_id=? AND ticket_price=? AND status!="cancelled"').get(s.id,p).t || 0;
        msg += `\n  ${ntStr(p)}：${sold}/${cap}張`;
      });
    }
    return reply(event, msg + '\n\n範例：下單 1 7880 2');
  }
  const showId = parseInt(args[0]), price = parseInt(args[1]), qty = parseInt(args[2]);
  if (isNaN(showId)||isNaN(price)||isNaN(qty)) return reply(event, '❌ 格式錯誤！\n範例：下單 1 7880 2');
  if (qty<=0 || qty>20) return reply(event, '❌ 張數須在 1-20 之間。');
  const show = db.prepare('SELECT * FROM shows WHERE id=?').get(showId);
  if (!show) return reply(event, `❌ 找不到場次 ${showId}。`);
  const tiers = JSON.parse(show.price_tiers);
  if (!tiers.includes(price)) return reply(event, `❌ ${ntStr(price)} 不在票價中。\n可選：${tiers.map(t=>ntStr(t)).join('、')}`);
  const days = dDiff(today(), show.ticket_sale_date);
  if (days<0) return reply(event, `⛔ 此場次搶票日已過。`);
  if (days<=3) return reply(event, `⛔ 【訂單不受理】\n距「${show.name}」搶票日僅 ${days} 天，已停止收單。\n如有特殊情況請私訊管理員。`);

  if (show.is_real_name) {
    const req = JSON.parse(show.required_fields || '[]');
    const tpa = show.tickets_per_account || 1;
    const accs = db.prepare('SELECT * FROM realname WHERE show_id=? AND member_id=? AND ticket_price=?').all(showId, uid, price);
    const existQty = db.prepare('SELECT SUM(quantity) t FROM orders WHERE show_id=? AND member_id=? AND ticket_price=? AND status!="cancelled"').get(showId,uid,price).t || 0;
    const maxAllowed = accs.length * tpa;
    const needTotal = existQty + qty;
    if (needTotal > maxAllowed) {
      const shortAcc = Math.ceil(needTotal/tpa) - accs.length;
      let m = `⛔ 【實名資料不足，無法下單】\n\n「${show.name}」為實名制\n每帳號限購 ${tpa} 張\n\n${ntStr(price)} 已提供：${accs.length} 個帳號（可購 ${maxAllowed} 張）\n本次想訂 ${qty} 張`;
      if (existQty>0) m += `（含已訂 ${existQty} 張）`;
      m += `\n\n還需提供 ${shortAcc} 個帳號的實名資料\n\n填寫格式（多行訊息）：\n實名 ${showId} ${price}\n姓名 王小明`;
      req.forEach(f => { if (f !== 'name') m += `\n${FIELD_LABEL[f]} （請填）`; });
      return reply(event, m);
    }
  }

  const rank = tiers.indexOf(price) + 1;
  const caps = JSON.parse(show.caps || '{}');
  const cap = caps[price] || defCap(rank);
  const tier = tName(rank);
  const tierTotal = db.prepare('SELECT SUM(quantity) t FROM orders WHERE show_id=? AND ticket_price=? AND status!="cancelled"').get(showId,price).t || 0;
  const newTotal = tierTotal + qty;
  const seqMax = db.prepare('SELECT MAX(order_seq) s FROM orders WHERE show_id=? AND ticket_price=?').get(showId,price).s || 0;
  const seq = seqMax + 1;
  db.prepare('INSERT INTO orders (show_id,member_id,member_name,price_tier,ticket_price,quantity,order_seq) VALUES (?,?,?,?,?,?,?)').run(showId, uid, userName, tier, price, qty, seq);
  let msg = `✅ 訂單登記成功\n\n👤 ${userName}\n🎵 ${show.name}\n💰 ${ntStr(price)}（${tier}）\n🎫 ${qty} 張\n📊 下單序號：第${seq}筆\n📦 此票價區累計：${newTotal}/${cap}張`;
  if (newTotal > cap) {
    msg += `\n\n⚠️ 【注意】此票價區已超過上限 ${newTotal-cap} 張\n目前去票區張數較多，若再下單不一定能完整拿到\n將依下單順序配票\n\n📋 ${ntStr(price)} 下單順序：`;
    const queue = db.prepare('SELECT member_name, SUM(quantity) qty, MIN(order_seq) seq FROM orders WHERE show_id=? AND ticket_price=? AND status!="cancelled" GROUP BY member_id ORDER BY seq').all(showId, price);
    queue.forEach((q,i) => msg += `\n${i+1}. ${q.member_name}：${q.qty}張`);
  } else if (newTotal >= cap * 0.85) msg += `\n⚡ 快滿額了！剩 ${cap - newTotal} 張`;
  msg += `\n\n💵 票面合計 ${ntStr(price*qty)}\n如需取消：取消訂單 ${showId}`;
  return reply(event, msg);
}

async function cmdMyOrders(event, uid, userName, inGrp) {
  const orders = db.prepare(`SELECT o.*, s.name sn, s.show_date sd, s.ticket_sale_date td
    FROM orders o JOIN shows s ON o.show_id=s.id
    WHERE o.member_id=? AND o.status!='cancelled'
    ORDER BY s.show_date, o.ticket_price DESC`).all(uid);
  if (orders.length === 0) return reply(event, `📭 您目前沒有有效訂單。`);
  const byShow = {};
  orders.forEach(o => {
    if (!byShow[o.show_id]) byShow[o.show_id] = { name:o.sn, sd:o.sd, td:o.td, items:[] };
    byShow[o.show_id].items.push(o);
  });
  let msg = `📋 【${userName} 的訂單】`;
  for (const [sid, s] of Object.entries(byShow)) {
    const total = s.items.reduce((a,o)=>a+o.quantity,0);
    const face = s.items.reduce((a,o)=>a+o.ticket_price*o.quantity,0);
    msg += `\n\n🎵 ${s.name}（#${sid}）`;
    msg += `\n📅 演出：${fmtD(s.sd)}`;
    msg += `\n🎫 搶票日：${fmtD(s.td)}`;
    s.items.forEach(o => msg += `\n  • ${ntStr(o.ticket_price)} × ${o.quantity}張（第${o.order_seq}筆）`);
    msg += `\n📦 合計 ${total}張 ｜ 票面 ${ntStr(face)}`;
  }
  msg += '\n\n💡 私訊Bot打「我的明細 [場次編號]」可查含行政費';
  return reply(event, msg);
}

async function cmdCancel(event, args, uid) {
  if (args.length < 1) return reply(event, '格式：取消訂單 [場次編號]');
  const showId = parseInt(args[0]);
  const show = db.prepare('SELECT * FROM shows WHERE id=?').get(showId);
  if (!show) return reply(event, `❌ 找不到場次 ${showId}。`);
  if (dDiff(today(), show.ticket_sale_date) <= 0) return reply(event, `⛔ 搶票日已到，依規定不接受取消。`);
  const orders = db.prepare('SELECT * FROM orders WHERE show_id=? AND member_id=? AND status!="cancelled"').all(showId, uid);
  if (orders.length === 0) return reply(event, `📭 您在「${show.name}」沒有訂單。`);
  const total = orders.reduce((s,o)=>s+o.quantity,0);
  db.prepare('UPDATE orders SET status="cancelled" WHERE show_id=? AND member_id=? AND status!="cancelled"').run(showId, uid);
  return reply(event, `✅ 已取消「${show.name}」共 ${total}張訂單。`);
}

async function cmdStats(event, args) {
  let shows;
  if (args.length>0 && !isNaN(parseInt(args[0]))) shows = db.prepare('SELECT * FROM shows WHERE id=?').all(parseInt(args[0]));
  else shows = db.prepare('SELECT * FROM shows ORDER BY show_date').all();
  if (shows.length === 0) return reply(event, '📭 沒有場次資料。');
  let msg = '📊 【訂單統計】';
  for (const s of shows) {
    const tiers = JSON.parse(s.price_tiers);
    const caps = JSON.parse(s.caps || '{}');
    const orders = db.prepare('SELECT * FROM orders WHERE show_id=? AND status!="cancelled" ORDER BY ticket_price DESC, order_seq').all(s.id);
    const total = orders.reduce((a,o)=>a+o.quantity,0);
    msg += `\n\n━━━━━━━━━━\n🎵 ${s.name}（#${s.id}）${s.is_real_name?' [實名制]':''}`;
    msg += `\n📅 ${fmtD(s.show_date)} ｜ 🎫 ${fmtD(s.ticket_sale_date)}`;
    msg += `\n📦 總訂單：${total}張`;
    if (orders.length === 0) { msg += '\n（暫無訂單）'; continue; }
    const byPrice = {};
    orders.forEach(o => {
      if (!byPrice[o.ticket_price]) byPrice[o.ticket_price] = { mems: {}, total:0 };
      if (!byPrice[o.ticket_price].mems[o.member_id]) byPrice[o.ticket_price].mems[o.member_id] = { name:o.member_name, qty:0, seq:o.order_seq };
      byPrice[o.ticket_price].mems[o.member_id].qty += o.quantity;
      byPrice[o.ticket_price].total += o.quantity;
    });
    msg += '\n\n💰 各票價：';
    tiers.forEach((p,i) => {
      const d = byPrice[p]; if (!d) return;
      const cap = caps[p] || defCap(i+1);
      const over = d.total > cap ? ' ⚠️超額' : '';
      msg += `\n\n[${ntStr(p)}] ${d.total}/${cap}張${over}`;
      Object.values(d.mems).sort((a,b)=>a.seq-b.seq).forEach((m,i)=>msg+=`\n  ${i+1}. ${m.name}：${m.qty}張`);
    });
    const mt = {};
    orders.forEach(o => { mt[o.member_name] = (mt[o.member_name]||0) + o.quantity; });
    msg += '\n\n👥 成員總計：';
    Object.entries(mt).sort((a,b)=>b[1]-a[1]).forEach(([n,q])=>msg+=`\n  ${n}：${q}張`);
  }
  return reply(event, msg);
}

async function cmdListShows(event) {
  const shows = db.prepare('SELECT * FROM shows ORDER BY show_date').all();
  if (shows.length === 0) return reply(event, '📭 目前沒有場次。');
  let msg = '🎵 【場次列表】';
  shows.forEach(s => {
    const tiers = JSON.parse(s.price_tiers);
    const caps = JSON.parse(s.caps || '{}');
    const days = dDiff(today(), s.ticket_sale_date);
    let status = days<0?'🔴已過搶票日':days<=3?'🟡已停止收單':`🟢收單中(剩${days}天)`;
    if (s.is_allocated) status = '✅已配票';
    msg += `\n\n#${s.id}：${s.name}${s.is_real_name?' [實名制]':''}`;
    msg += `\n📅 ${fmtD(s.show_date)} ｜ 🎫 ${fmtD(s.ticket_sale_date)}`;
    msg += `\n📍 ${s.venue || '?'} ｜ ${status}`;
    tiers.forEach((p,i) => {
      const cap = caps[p] || defCap(i+1);
      const sold = db.prepare('SELECT SUM(quantity) t FROM orders WHERE show_id=? AND ticket_price=? AND status!="cancelled"').get(s.id,p).t || 0;
      msg += `\n  ${ntStr(p)}：${sold}/${cap}張`;
    });
  });
  return reply(event, msg);
}

async function cmdFee(event, args) {
  if (args.length<2) return reply(event, '格式：行政費 [票價] [張數]\n範例：行政費 7880 8');
  const p = parseInt(args[0]), q = parseInt(args[1]);
  if (isNaN(p)||isNaN(q)) return reply(event, '❌ 請輸入數字。');
  const rank = p>=6000?1:p>=4000?3:5;
  const fee = calcFee(rank, q);
  const face = p*q, ft = fee*q;
  return reply(event, `💰 【行政費試算】\n票價：${ntStr(p)} × ${q}張\n${q>=10?'✅ 常態費率':'⚠️ 優惠費率'}\n\n票面：${ntStr(face)}\n行政費：${ntStr(fee)}/張 × ${q} = ${ntStr(ft)}\n────\n預估總額 ${ntStr(face+ft)}`);
}

async function cmdMyDetail(event, args, uid, userName, inGrp) {
  if (args.length<1) return reply(event, '格式：我的明細 [場次編號]');
  const showId = parseInt(args[0]);
  const show = db.prepare('SELECT * FROM shows WHERE id=?').get(showId);
  if (!show) return reply(event, `❌ 找不到場次 ${showId}。`);
  const orders = db.prepare('SELECT * FROM orders WHERE show_id=? AND member_id=? AND status!="cancelled" ORDER BY ticket_price DESC').all(showId, uid);
  if (orders.length === 0) return reply(event, `📭 您在「${show.name}」沒有訂單。`);
  const totalQty = orders.reduce((a,o)=>a+o.quantity,0);
  let msg = `🎫 【${userName} 的明細】${show.name}`;
  let face=0, feeT=0;
  orders.forEach(o => {
    const rank = tRank(o.price_tier);
    const fee = calcFee(rank, totalQty);
    const fs = o.ticket_price*o.quantity, fts = fee*o.quantity;
    face += fs; feeT += fts;
    msg += `\n\n${ntStr(o.ticket_price)} × ${o.quantity}張`;
    msg += `\n  票面：${ntStr(fs)}`;
    msg += `\n  行政費：${ntStr(fee)}/張 = ${ntStr(fts)}`;
  });
  msg += `\n\n📦 合計 ${totalQty}張`;
  msg += `\n💵 票面總額：${ntStr(face)}`;
  msg += `\n💵 行政費總額：${ntStr(feeT)}（預估）`;
  msg += `\n💰 應付票面：${ntStr(face)}\n（行政費於配票完成後結清）`;
  if (inGrp) { await pushU(uid, msg); return reply(event, `✅ 已私訊您訂單明細`); }
  return reply(event, msg);
}

async function cmdMyAlloc(event, args, uid, userName, inGrp) {
  if (args.length<1) return reply(event, '格式：我的配票 [場次編號]');
  const showId = parseInt(args[0]);
  const show = db.prepare('SELECT * FROM shows WHERE id=?').get(showId);
  if (!show) return reply(event, `❌ 找不到場次。`);
  if (!show.is_allocated) return reply(event, `⏳ 「${show.name}」尚未完成配票，請稍候。`);
  const allocs = db.prepare('SELECT * FROM allocations WHERE show_id=? AND member_id=? ORDER BY ticket_price DESC').all(showId, uid);
  if (allocs.length === 0) return reply(event, `📭 找不到您在「${show.name}」的配票紀錄。`);
  let msg = `🎫 【${userName} 配票結果】${show.name}`;
  let to=0, tr=0, ts=0, tref=0;
  allocs.forEach(a => {
    msg += `\n\n${ntStr(a.ticket_price)}：訂${a.ordered}張 → 拿${a.received}張`;
    if (a.shortfall>0) msg += `\n  ⚠️ 缺${a.shortfall}張 → 退${ntStr(a.refund_amount)}`;
    to+=a.ordered; tr+=a.received; ts+=a.shortfall; tref+=a.refund_amount;
  });
  msg += `\n\n📦 共訂 ${to}張 → 實得 ${tr}張`;
  if (tref>0) msg += `\n💰 應退票面：${ntStr(tref)}`;
  msg += `\n\n行政費將依實得張數結算。`;
  if (inGrp) { await pushU(uid, msg); return reply(event, `✅ 已私訊您配票結果`); }
  return reply(event, msg);
}

async function cmdSubmitRN(event, args, restLines, uid, userName, inGrp) {
  if (args.length<2) return reply(event, '📝 實名提交格式（多行訊息）：\n實名 [場次ID] [票價]\n姓名 王小明\n身分證 A123456789\n電話 0912345678\n帳號 abc\n密碼 xxx\n\n（依該場次要求欄位填寫）');
  const showId = parseInt(args[0]), price = parseInt(args[1]);
  const show = db.prepare('SELECT * FROM shows WHERE id=?').get(showId);
  if (!show) return reply(event, `❌ 找不到場次 ${showId}。`);
  if (!show.is_real_name) return reply(event, `📌 「${show.name}」非實名制，無需提交。`);
  const tiers = JSON.parse(show.price_tiers);
  if (!tiers.includes(price)) return reply(event, `❌ ${ntStr(price)} 不在票價內。`);
  const required = JSON.parse(show.required_fields || '[]');
  const data = parseFields(restLines);
  const missing = required.filter(f => !data[f] || data[f].trim()==='');
  if (missing.length > 0) {
    let m = `⛔ 缺少必填欄位：${missing.map(f=>FIELD_LABEL[f]).join('、')}\n\n範例：\n實名 ${showId} ${price}`;
    required.forEach(f => m += `\n${FIELD_LABEL[f]} 請填寫`);
    return reply(event, m);
  }
  db.prepare(`INSERT INTO realname (show_id, member_id, member_name, ticket_price, name, id_no, phone, birthday, address, site_acc, site_pwd, note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(showId, uid, userName, price, data.name||null, data.id_no||null, data.phone||null, data.birthday||null, data.address||null, data.site_acc||null, data.site_pwd||null, data.note||null);
  const count = db.prepare('SELECT COUNT(*) c FROM realname WHERE show_id=? AND member_id=? AND ticket_price=?').get(showId, uid, price).c;
  const tpa = show.tickets_per_account || 1;
  let msg = `✅ 實名資料已提交\n\n${userName}｜${show.name}\n${ntStr(price)}｜第 ${count} 個帳號`;
  required.forEach(f => { if (data[f]) msg += `\n${FIELD_LABEL[f]}：${f==='site_pwd'?'****':data[f]}`; });
  msg += `\n\n📊 目前可下單張數：${count * tpa}張（${count}帳號 × ${tpa}張）`;
  msg += `\n刪除：刪除實名 ${showId} [#號]\n查詢：我的實名 ${showId}`;
  if (inGrp) { await pushU(uid, msg); return reply(event, `✅ ${userName} 實名資料已收到（已私訊您詳情）`); }
  return reply(event, msg);
}

async function cmdMyRN(event, args, uid, userName, inGrp) {
  if (args.length<1) return reply(event, '格式：我的實名 [場次編號]');
  const showId = parseInt(args[0]);
  const show = db.prepare('SELECT * FROM shows WHERE id=?').get(showId);
  if (!show) return reply(event, `❌ 找不到場次。`);
  const accs = db.prepare('SELECT * FROM realname WHERE show_id=? AND member_id=? ORDER BY ticket_price DESC, id').all(showId, uid);
  if (accs.length === 0) return reply(event, `📭 您在「${show.name}」沒有提交實名資料。`);
  const required = JSON.parse(show.required_fields || '[]');
  let msg = `📝 【${userName} 的實名】${show.name}`;
  const byPrice = {};
  accs.forEach(a => { if (!byPrice[a.ticket_price]) byPrice[a.ticket_price] = []; byPrice[a.ticket_price].push(a); });
  for (const [price, list] of Object.entries(byPrice)) {
    msg += `\n\n💰 ${ntStr(price)}（${list.length}帳號）：`;
    list.forEach((a,i) => {
      msg += `\n\n#${a.id}（第${i+1}個）`;
      required.forEach(f => { if (a[f]) msg += `\n  ${FIELD_LABEL[f]}：${f==='site_pwd'?'****':a[f]}`; });
    });
  }
  msg += `\n\n💡 刪除：刪除實名 ${showId} [#號]`;
  if (inGrp) { await pushU(uid, msg); return reply(event, `✅ 已私訊您`); }
  return reply(event, msg);
}

async function cmdDelRN(event, args, uid) {
  if (args.length<2) return reply(event, '格式：刪除實名 [場次ID] [實名#號]\n（用「我的實名」可查 #號）');
  const showId = parseInt(args[0]), rnId = parseInt(args[1]);
  const r = db.prepare('SELECT * FROM realname WHERE id=? AND show_id=? AND member_id=?').get(rnId, showId, uid);
  if (!r) return reply(event, `❌ 找不到此實名記錄。`);
  db.prepare('DELETE FROM realname WHERE id=?').run(rnId);
  return reply(event, `✅ 已刪除實名 #${rnId}（${ntStr(r.ticket_price)}）`);
}

async function cmdUrlShow(event, args, uid) {
  if (!isAdmin(uid)) return reply(event, '❌ 此功能限管理員。');
  if (args.length<4) return reply(event, '📝 格式：\n上場次 [售票URL] [演出日期] [搶票日] [地點]\n\n範例：\n上場次 https://kktix.com/xxx 2026-06-15 2026-05-01 台北小巨蛋');
  const [url, sd, td, ...vp] = args;
  const venue = vp.join(' ');
  const prices = await detectPrices(url);
  if (!prices || prices.length === 0) {
    return reply(event, `❌ 無法自動偵測票價\n\n可能原因：\n• 頁面需 JS 載入\n• 票價未公布\n• 防爬機制\n\n請改用：\n新增場次 [名稱] ${sd} ${td} ${venue} [票價1,票價2,...]`);
  }
  const urlName = url.replace(/^https?:\/\//,'').split('/')[1] || '未命名場次';
  const caps = {};
  prices.forEach((p,i) => caps[p] = defCap(i+1));
  const r = db.prepare('INSERT INTO shows (name, show_date, ticket_sale_date, venue, source_url, price_tiers, caps) VALUES (?,?,?,?,?,?,?)')
    .run(urlName, sd, td, venue, url, JSON.stringify(prices), JSON.stringify(caps));
  const showId = r.lastInsertRowid;
  let adminMsg = `✅ 場次已建立 #${showId}\n\n名稱：${urlName}\n（改名：改場次名稱 ${showId} [新名稱]）\n演出：${fmtD(sd)}\n搶票日：${fmtD(td)}\n地點：${venue}\n\n💰 偵測到票價：`;
  prices.forEach((p,i) => adminMsg += `\n  ${ntStr(p)}：上限${caps[p]}張`);
  adminMsg += `\n\n🔧 如需實名制：\n設定實名 ${showId} 1\n設定實名欄位 ${showId} 姓名,身分證,電話,帳號,密碼`;
  await reply(event, adminMsg);
  let g = `🎵 【新場次開放下單】\n\n${urlName}\n📅 演出：${fmtD(sd)}\n🎫 搶票日：${fmtD(td)}\n📍 ${venue}\n\n💰 票價（總額上限）：`;
  prices.forEach(p => g += `\n  ${ntStr(p)}：上限${caps[p]}張`);
  g += `\n\n✏️ 下單：下單 ${showId} [票價] [張數]`;
  await pushG(g);
}

async function cmdAddShow(event, args, uid) {
  if (!isAdmin(uid)) return reply(event, '❌ 此功能限管理員。');
  if (args.length<5) return reply(event, '📝 格式：\n新增場次 [名稱] [演出日期] [搶票日] [地點] [票價(逗號分隔)]\n\n範例：\n新增場次 aespa演唱會 2026-06-15 2026-05-01 台北小巨蛋 7880,6880,4880,3880,2880');
  const [name, sd, td, venue, pstr] = args;
  const prices = pstr.split(',').map(p=>parseInt(p.trim())).filter(p=>!isNaN(p)).sort((a,b)=>b-a);
  if (prices.length===0) return reply(event, '❌ 票價格式錯誤。');
  const caps = {};
  prices.forEach((p,i) => caps[p] = defCap(i+1));
  const r = db.prepare('INSERT INTO shows (name, show_date, ticket_sale_date, venue, price_tiers, caps) VALUES (?,?,?,?,?,?)')
    .run(name, sd, td, venue, JSON.stringify(prices), JSON.stringify(caps));
  const showId = r.lastInsertRowid;
  let adminMsg = `✅ 場次新增成功 #${showId}\n${name}\n演出：${fmtD(sd)}\n搶票日：${fmtD(td)}\n\n💰 票價：`;
  prices.forEach(p => adminMsg += `\n  ${ntStr(p)}：${caps[p]}張`);
  await reply(event, adminMsg);
  let g = `🎵 【新場次開放下單】\n\n${name}\n📅 演出：${fmtD(sd)}\n🎫 搶票日：${fmtD(td)}\n📍 ${venue}\n\n💰 票價：`;
  prices.forEach(p => g += `\n  ${ntStr(p)}：上限${caps[p]}張`);
  g += `\n\n✏️ 下單：下單 ${showId} [票價] [張數]`;
  await pushG(g);
}

async function cmdRenameShow(event, args, uid) {
  if (!isAdmin(uid)) return reply(event, '❌ 此功能限管理員。');
  if (args.length<2) return reply(event, '格式：改場次名稱 [場次ID] [新名稱]');
  const showId = parseInt(args[0]);
  const newName = args.slice(1).join(' ');
  const s = db.prepare('SELECT * FROM shows WHERE id=?').get(showId);
  if (!s) return reply(event, `❌ 找不到場次。`);
  const old = s.name;
  db.prepare('UPDATE shows SET name=? WHERE id=?').run(newName, showId);
  await reply(event, `✅ 已將「${old}」改名為「${newName}」`);
  await pushG(`📌 場次 #${showId} 更名為：「${newName}」`);
}

async function cmdSetRN(event, args, uid) {
  if (!isAdmin(uid)) return reply(event, '❌ 此功能限管理員。');
  if (args.length<1) return reply(event, '格式：設定實名 [場次ID] [每帳號可購張數(預設1)]\n例：設定實名 1 1');
  const showId = parseInt(args[0]), tpa = parseInt(args[1] || '1');
  const s = db.prepare('SELECT * FROM shows WHERE id=?').get(showId);
  if (!s) return reply(event, `❌ 找不到場次。`);
  const defReq = JSON.parse(s.required_fields||'[]');
  const reqs = defReq.length>0 ? defReq : ['name','id_no','phone','site_acc','site_pwd'];
  db.prepare('UPDATE shows SET is_real_name=1, tickets_per_account=?, required_fields=? WHERE id=?').run(tpa, JSON.stringify(reqs), showId);
  await reply(event, `✅ 已設「${s.name}」為實名制\n每帳號可購 ${tpa} 張\n必填欄位：${reqs.map(f=>FIELD_LABEL[f]).join('、')}\n\n調整欄位：設定實名欄位 ${showId} [欄位列表]`);
  await pushG(`📢 【實名制公告】\n\n「${s.name}」設為實名制\n📋 每帳號可購：${tpa} 張\n📝 必填欄位：${reqs.map(f=>FIELD_LABEL[f]).join('、')}\n\n下單前請先提交實名：\n實名 ${showId} [票價]\n（多行訊息，依欄位填寫）\n\n查詢自己：我的實名 ${showId}`);
}

async function cmdUnsetRN(event, args, uid) {
  if (!isAdmin(uid)) return reply(event, '❌ 此功能限管理員。');
  if (args.length<1) return reply(event, '格式：取消實名 [場次ID]');
  const showId = parseInt(args[0]);
  const s = db.prepare('SELECT * FROM shows WHERE id=?').get(showId);
  if (!s) return reply(event, `❌ 找不到場次。`);
  db.prepare('UPDATE shows SET is_real_name=0 WHERE id=?').run(showId);
  await reply(event, `✅ 已取消「${s.name}」的實名制`);
  await pushG(`📢 「${s.name}」已取消實名制`);
}

async function cmdSetFields(event, args, uid) {
  if (!isAdmin(uid)) return reply(event, '❌ 此功能限管理員。');
  if (args.length<2) return reply(event, `格式：設定實名欄位 [場次ID] [欄位1,欄位2,...]\n\n可用欄位：${Object.keys(FIELD_LABEL).map(k=>FIELD_LABEL[k]).join('、')}\n\n例：\n設定實名欄位 1 姓名,身分證,電話,帳號,密碼`);
  const showId = parseInt(args[0]);
  const fstr = args[1];
  const s = db.prepare('SELECT * FROM shows WHERE id=?').get(showId);
  if (!s) return reply(event, `❌ 找不到場次。`);
  const reqs = fstr.split(',').map(f=>FIELDS[f.trim()]).filter(Boolean);
  if (reqs.length===0) return reply(event, `❌ 無有效欄位。`);
  const unique = [...new Set(reqs)];
  db.prepare('UPDATE shows SET required_fields=? WHERE id=?').run(JSON.stringify(unique), showId);
  await reply(event, `✅ 已更新「${s.name}」實名欄位：${unique.map(f=>FIELD_LABEL[f]).join('、')}`);
  if (s.is_real_name) await pushG(`📢 【實名欄位更新】「${s.name}」\n必填：${unique.map(f=>FIELD_LABEL[f]).join('、')}\n\n格式：\n實名 ${showId} [票價]\n${unique.map(f=>FIELD_LABEL[f]+' 請填寫').join('\n')}`);
}

async function cmdSetTPA(event, args, uid) {
  if (!isAdmin(uid)) return reply(event, '❌ 此功能限管理員。');
  if (args.length<2) return reply(event, '格式：設定每帳號 [場次ID] [張數]');
  const showId = parseInt(args[0]), tpa = parseInt(args[1]);
  const s = db.prepare('SELECT * FROM shows WHERE id=?').get(showId);
  if (!s) return reply(event, `❌ 找不到場次。`);
  db.prepare('UPDATE shows SET tickets_per_account=? WHERE id=?').run(tpa, showId);
  await reply(event, `✅ 已設「${s.name}」每帳號可購 ${tpa} 張`);
  if (s.is_real_name) await pushG(`📌 「${s.name}」每帳號可購張數更新為 ${tpa} 張`);
}

async function cmdViewRN(event, args, uid) {
  if (!isAdmin(uid)) return reply(event, '❌ 此功能限管理員。');
  if (args.length<1) return reply(event, '格式：\n查實名 [場次ID]\n查實名 [場次ID] [成員名]');
  const showId = parseInt(args[0]);
  const memberFilter = args.slice(1).join(' ');
  const s = db.prepare('SELECT * FROM shows WHERE id=?').get(showId);
  if (!s) return reply(event, `❌ 找不到場次。`);
  const required = JSON.parse(s.required_fields || '[]');
  let q = 'SELECT * FROM realname WHERE show_id=?';
  const params = [showId];
  if (memberFilter) { q += ' AND member_name LIKE ?'; params.push(`%${memberFilter}%`); }
  q += ' ORDER BY ticket_price DESC, member_name, id';
  const list = db.prepare(q).all(...params);
  if (list.length === 0) return reply(event, '📭 沒有實名紀錄。');
  let msg = `📝 【實名清單】${s.name}\n共 ${list.length} 筆`;
  const byMember = {};
  list.forEach(r => {
    const key = `${r.member_name}|${r.ticket_price}`;
    if (!byMember[key]) byMember[key] = [];
    byMember[key].push(r);
  });
  for (const [key, items] of Object.entries(byMember)) {
    const [name, price] = key.split('|');
    msg += `\n\n👤 ${name}｜${ntStr(price)}（${items.length}帳號）`;
    items.forEach(a => {
      msg += `\n  #${a.id}：`;
      required.forEach(f => { if (a[f]) msg += `${FIELD_LABEL[f]}=${a[f]}｜`; });
    });
  }
  return reply(event, msg);
}

async function cmdSetCap(event, args, uid) {
  if (!isAdmin(uid)) return reply(event, '❌ 此功能限管理員。');
  if (args.length<3) return reply(event, '格式：設定上限 [場次ID] [票價] [新上限]');
  const [sid, p, c] = args.map(Number);
  const s = db.prepare('SELECT * FROM shows WHERE id=?').get(sid);
  if (!s) return reply(event, `❌ 找不到場次。`);
  const caps = JSON.parse(s.caps || '{}');
  caps[p] = c;
  db.prepare('UPDATE shows SET caps=? WHERE id=?').run(JSON.stringify(caps), sid);
  await reply(event, `✅ 「${s.name}」${ntStr(p)} 上限設為 ${c} 張`);
}

async function cmdDelShow(event, args, uid) {
  if (!isAdmin(uid)) return reply(event, '❌ 此功能限管理員。');
  if (args.length<1) return reply(event, '格式：刪除場次 [場次ID]');
  const sid = parseInt(args[0]);
  const s = db.prepare('SELECT * FROM shows WHERE id=?').get(sid);
  if (!s) return reply(event, `❌ 找不到。`);
  db.prepare('UPDATE orders SET status="cancelled" WHERE show_id=?').run(sid);
  db.prepare('DELETE FROM realname WHERE show_id=?').run(sid);
  db.prepare('DELETE FROM allocations WHERE show_id=?').run(sid);
  db.prepare('DELETE FROM shows WHERE id=?').run(sid);
  await reply(event, `✅ 已刪除「${s.name}」`);
  await pushG(`📌 「${s.name}」場次已取消`);
}

async function cmdSendConfirm(event, args, uid) {
  if (!isAdmin(uid)) return reply(event, '❌ 此功能限管理員。');
  if (args.length<1) return reply(event, '格式：發送確認 [場次ID]');
  const sid = parseInt(args[0]);
  const s = db.prepare('SELECT * FROM shows WHERE id=?').get(sid);
  if (!s) return reply(event, `❌ 找不到。`);
  const orders = db.prepare('SELECT * FROM orders WHERE show_id=? AND status!="cancelled"').all(sid);
  if (orders.length === 0) return reply(event, '📭 沒有訂單。');
  const byMember = {};
  orders.forEach(o => {
    if (!byMember[o.member_id]) byMember[o.member_id] = { name:o.member_name, qty:0, face:0 };
    byMember[o.member_id].qty += o.quantity;
    byMember[o.member_id].face += o.ticket_price * o.quantity;
  });
  const mems = Object.entries(byMember).map(([id, d]) => ({ userId:id, name:d.name, note:`${d.qty}張 票面${ntStr(d.face)}` }));
  const intro = `📢 【搶票前確認】${s.name}\n演出：${fmtD(s.show_date)}\n搶票日：${fmtD(s.ticket_sale_date)}\n\n請以下成員確認訂單並完成票面匯款：`;
  await pushGroupMention(intro, mems);
  await reply(event, `✅ 已發送確認通知至群組，共 ${mems.length} 位成員`);
}

async function cmdStartAlloc(event, args, uid) {
  if (!isAdmin(uid)) return reply(event, '❌ 此功能限管理員。');
  if (args.length<1) return reply(event, '格式：開始配票 [場次ID]');
  const sid = parseInt(args[0]);
  const s = db.prepare('SELECT * FROM shows WHERE id=?').get(sid);
  if (!s) return reply(event, `❌ 找不到。`);
  const orders = db.prepare('SELECT member_name, ticket_price, SUM(quantity) qty FROM orders WHERE show_id=? AND status!="cancelled" GROUP BY member_id, ticket_price ORDER BY ticket_price DESC, member_name').all(sid);
  let msg = `🎫 【配票模式】${s.name}\n\n訂單摘要：`;
  orders.forEach(o => msg += `\n${o.member_name} ${ntStr(o.ticket_price)} ${o.qty}張`);
  msg += `\n\n配票指令：\n配票 ${sid} [成員名] [票價] [實拿張數]\n\n例：\n配票 ${sid} 小美 7880 2\n配票 ${sid} 小明 7880 0\n\n全部輸入完：配票完成 ${sid}`;
  return reply(event, msg);
}

async function cmdRecordAlloc(event, args, uid) {
  if (!isAdmin(uid)) return reply(event, '❌ 此功能限管理員。');
  if (args.length<4) return reply(event, '格式：配票 [場次ID] [成員名] [票價] [實拿張數]');
  const sid = parseInt(args[0]);
  const mname = args[1];
  const price = parseInt(args[2]);
  const recv = parseInt(args[3]);
  const od = db.prepare('SELECT member_id, member_name, SUM(quantity) o FROM orders WHERE show_id=? AND member_name LIKE ? AND ticket_price=? AND status!="cancelled" GROUP BY member_id').get(sid, `%${mname}%`, price);
  if (!od) return reply(event, `❌ 找不到「${mname}」在此場次 ${ntStr(price)} 的訂單。`);
  const ordered = od.o;
  const shortfall = Math.max(0, ordered - recv);
  const refund = shortfall * price;
  const exist = db.prepare('SELECT id FROM allocations WHERE show_id=? AND member_id=? AND ticket_price=?').get(sid, od.member_id, price);
  if (exist) db.prepare('UPDATE allocations SET received=?, shortfall=?, refund_amount=? WHERE id=?').run(recv, shortfall, refund, exist.id);
  else db.prepare('INSERT INTO allocations (show_id, member_id, member_name, ticket_price, ordered, received, shortfall, refund_amount) VALUES (?,?,?,?,?,?,?,?)')
    .run(sid, od.member_id, od.member_name, price, ordered, recv, shortfall, refund);
  let msg = `✅ ${od.member_name} ${ntStr(price)}：訂${ordered}張 → 拿${recv}張`;
  if (shortfall>0) msg += `\n⚠️ 缺${shortfall}張，應退${ntStr(refund)}`;
  return reply(event, msg);
}

async function cmdFinishAlloc(event, args, uid) {
  if (!isAdmin(uid)) return reply(event, '❌ 此功能限管理員。');
  if (args.length<1) return reply(event, '格式：配票完成 [場次ID]');
  const sid = parseInt(args[0]);
  const s = db.prepare('SELECT * FROM shows WHERE id=?').get(sid);
  if (!s) return reply(event, `❌ 找不到。`);
  db.prepare('UPDATE shows SET is_allocated=1 WHERE id=?').run(sid);
  const allocs = db.prepare('SELECT * FROM allocations WHERE show_id=? ORDER BY ticket_price DESC, member_name').all(sid);
  const shorts = allocs.filter(a => a.shortfall>0);
  const totalRefund = shorts.reduce((a,b)=>a+b.refund_amount, 0);
  let adminMsg = `✅ 配票完成！「${s.name}」\n共 ${allocs.length} 筆`;
  if (shorts.length>0) {
    adminMsg += `\n\n⚠️ ${shorts.length} 筆缺票：`;
    shorts.forEach(a => adminMsg += `\n  ${a.member_name} ${ntStr(a.ticket_price)} 缺${a.shortfall}張 退${ntStr(a.refund_amount)}`);
    adminMsg += `\n\n💰 總退款：${ntStr(totalRefund)}`;
  } else adminMsg += `\n🎉 全數完整分配`;
  await reply(event, adminMsg);
  let g = `🎫 【配票完成通知】\n\n「${s.name}」已完成配票\n\n請各成員私訊 Bot：\n我的配票 ${sid}\n\n即可查看配票結果及退款資訊。`;
  if (shorts.length>0) g += `\n\n⚠️ 本場次部分票區有缺票，請查詢確認。`;
  await pushG(g);
}

async function cmdCheckList(event, args, type) {
  if (args.length===0) return reply(event, `格式：查${type==='blacklist'?'黑':'白'}名單 [帳號]`);
  const acc = args.join(' ');
  const r = db.prepare(`SELECT * FROM ${type} WHERE account LIKE ? ORDER BY created_at DESC`).all(`%${acc}%`);
  if (r.length===0) return reply(event, type==='blacklist'?`✅ 黑名單無「${acc}」`:`❓ 白名單無「${acc}」`);
  const icon = type==='blacklist'?'🚫':'🌟';
  let m = `${icon} 找到 ${r.length} 筆：`;
  r.forEach((x,i) => m += `\n${i+1}. ${x.account}\n   ${x.reason||'無備註'}`);
  return reply(event, m);
}

async function cmdAddList(event, args, uid, userName, type) {
  if (!isAdmin(uid)) return reply(event, '❌ 此功能限管理員。');
  if (args.length<2) return reply(event, `格式：加${type==='blacklist'?'黑':'白'}名單 [帳號] [原因]`);
  const acc = args[0], reason = args.slice(1).join(' ');
  db.prepare(`INSERT INTO ${type} (account, reason, reported_by) VALUES (?,?,?)`).run(acc, reason, userName);
  return reply(event, `✅ 已加入${type==='blacklist'?'黑':'白'}名單\n帳號：${acc}\n原因：${reason}`);
}

async function cmdListAll(event, uid, type) {
  if (!isAdmin(uid)) return reply(event, '❌ 此功能限管理員。');
  const r = db.prepare(`SELECT * FROM ${type} ORDER BY created_at DESC LIMIT 30`).all();
  if (r.length===0) return reply(event, '名單為空。');
  let m = `${type==='blacklist'?'🚫':'🌟'} 最新30筆：`;
  r.forEach((x,i) => m += `\n${i+1}. ${x.account} - ${x.reason||'無'}`);
  return reply(event, m);
}

async function cmdPayment(event, args, uid, userName) {
  if (args.length===0) return reply(event, '格式：匯款確認 [後五碼] [備註(選填)]');
  const lf = args[0];
  if (!/^\d{5}$/.test(lf)) return reply(event, '❌ 後五碼須為5位數字。');
  const note = args.slice(1).join(' ');
  db.prepare('INSERT INTO payments (member_id, member_name, last_five, note) VALUES (?,?,?,?)').run(uid, userName, lf, note);
  return reply(event, `✅ 匯款已記錄\n${userName}｜${lf}${note?'\n'+note:''}`);
}

async function cmdPayList(event, uid) {
  if (!isAdmin(uid)) return reply(event, '❌ 此功能限管理員。');
  const r = db.prepare('SELECT * FROM payments ORDER BY created_at DESC LIMIT 30').all();
  if (r.length===0) return reply(event, '尚無匯款。');
  let m = '💳 最新30筆：';
  r.forEach((p,i) => { const t = new Date(p.created_at).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}); m += `\n${i+1}. ${p.member_name} ${p.last_five}${p.note?' ('+p.note+')':''} ${t}`; });
  return reply(event, m);
}

async function cmdDispute(event, args, uid, userName) {
  if (args.length<2) return reply(event, '格式：申請異議 [場次ID] [說明]\n（請於收票後24小時內提出）');
  const sid = parseInt(args[0]);
  const desc = args.slice(1).join(' ');
  const s = db.prepare('SELECT * FROM shows WHERE id=?').get(sid);
  return reply(event, `⚖️ 異議已記錄\n${userName}｜${s?s.name:'場次'+sid}\n${desc}\n\n管理員將於24小時內回覆。`);
}

async function cmdAddAdmin(event, args, uid) {
  if (!isAdmin(uid)) return reply(event, '❌ 此功能限管理員。');
  if (args.length<1) return reply(event, '格式：新增管理員 [User ID] [名稱]');
  const nid = args[0], n = args[1]||'管理員';
  db.prepare('INSERT OR IGNORE INTO admins (user_id, name) VALUES (?,?)').run(nid, n);
  return reply(event, `✅ 已將 ${n} 設為管理員`);
}

async function cmdListAdmins(event, uid) {
  if (!isAdmin(uid)) return reply(event, '❌ 此功能限管理員。');
  const l = db.prepare('SELECT * FROM admins').all();
  let m = '👑 管理員：';
  l.forEach((a,i) => m += `\n${i+1}. ${a.name}`);
  return reply(event, m);
}

async function cmdAnnounce(event, content, uid) {
  if (!isAdmin(uid)) return reply(event, '❌ 此功能限管理員。');
  if (!content.trim()) return reply(event, '格式：群組公告 [訊息]');
  await pushG(`📢 【公告】\n\n${content}`);
  return reply(event, '✅ 已發送公告。');
}

async function cmdFeatureUpdate(event, content, uid) {
  if (!isAdmin(uid)) return reply(event, '❌ 此功能限管理員。');
  if (!content.trim()) return reply(event, '格式：功能更新 [說明]');
  const date = new Date().toLocaleDateString('zh-TW',{timeZone:'Asia/Taipei'});
  await pushG(`🔔 【功能更新】${date}\n\n${content}\n\n📌 查詢指令：說明`);
  return reply(event, '✅ 已發送更新通知。');
}

async function cmdManualBackup(event, uid) {
  if (!isAdmin(uid)) return reply(event, '❌ 此功能限管理員。');
  if (!octokit || !GH_OWNER) return reply(event, '❌ 備份未啟用（未設 GITHUB_TOKEN）');
  await reply(event, '⏳ 備份中...');
  const ok = await performBackup();
  await pushU(uid, ok ? `✅ 備份完成\n時間：${lastBackupTime}\n查看：github.com/${GH_OWNER}/${GH_REPO}/tree/${BK_BRANCH}/data` : '❌ 備份失敗，請看 Render Logs');
}

async function cmdBackupStatus(event, uid) {
  if (!isAdmin(uid)) return reply(event, '❌ 此功能限管理員。');
  let m = '🗄️ 【備份狀態】\n';
  if (!octokit) m += '❌ 未設定 GITHUB_TOKEN（未啟用）';
  else if (!GH_OWNER) m += '❌ 未設定 GITHUB_OWNER';
  else {
    m += `✅ 已啟用\n👤 GitHub: ${GH_OWNER}/${GH_REPO}\n🌿 分支: ${BK_BRANCH}`;
    m += lastBackupTime ? `\n⏰ 上次備份：${lastBackupTime}` : '\n⏰ 尚未備份（將於變更後 15 秒內執行）';
    m += `\n\n查看：\ngithub.com/${GH_OWNER}/${GH_REPO}/tree/${BK_BRANCH}/data`;
  }
  return reply(event, m);
}

function txtHelp(admin) {
  let m = `🤖 【票務 Bot 指令】

📋 訂單
• 下單 [場次] [票價] [張數]
• 我的訂單 / 取消訂單 [場次]
• 場次列表 / 場次統計

📝 實名（實名制場次需先填）
• 實名 [場次] [票價]（換行填欄位）
• 我的實名 [場次]
• 刪除實名 [場次] [#號]

💰 費用
• 行政費 [票價] [張數]
• 行政費說明

🔒 私訊查詢
• 我的明細 [場次] - 含行政費
• 我的配票 [場次] - 配票結果

🔍 名單
• 查黑名單 [帳號]
• 查白名單 [帳號]

💳 其他
• 匯款確認 [後五碼]
• 規章 / 流程
• 申請異議 [場次] [說明]`;
  if (admin) m += `

👑 管理員（建議私訊）
🎵 場次
• 上場次 [URL] [演出日] [搶票日] [地點]
• 新增場次 [名稱] [演出] [搶] [地點] [票價]
• 改場次名稱 [場次] [新名稱]
• 設定上限 [場次] [票價] [張數]
• 刪除場次 [場次]

🏷️ 實名
• 設定實名 [場次] [每帳號張數]
• 取消實名 [場次]
• 設定實名欄位 [場次] [欄位列表]
• 設定每帳號 [場次] [張數]
• 查實名 [場次] / 查實名 [場次] [成員]

🎫 流程
• 發送確認 [場次]
• 開始配票 [場次]
• 配票 [場次] [成員] [票價] [拿到張數]
• 配票完成 [場次]

📢 公告
• 群組公告 [訊息]
• 功能更新 [說明]

🗄️ 備份
• 立即備份 / 備份狀態

⚙️ 其他
• 加黑/白名單 / 黑/白名單列表
• 匯款列表
• 新增管理員 [User ID] [名稱]
• 管理員列表`;
  return m;
}

function txtFee() { return `💰 【行政費標準】

🔵 常態（≥10張）
• 最高/次高票價區：$2,500/張
• 第三/第四票價區：$2,000/張
• 其餘：$1,500/張

🟡 優惠（<10張）
• 最高/次高：最低 $2,000/張
• 其餘：最低 $1,000/張

💡 試算：行政費 [票價] [張數]`; }

function txtRules() { return `📢 【規章】

🎟️ 收單
• 搶票日 4 天前可下單
• 搶票日前 3 天起停止收單

💰 費用
• 票面：搶票前匯款
• 行政費：配票完成後結清

⚠️ 退款
• 搶票日起不接受取消
• 場次延期：不退款
• 場次取消：退票面
• 缺票：退缺少票面

📝 實名制
• 部分場次需提供實名資料
• 一帳號限購對應張數
• 資料不齊無法下單

⚖️ 異議
• 收票後 24 小時內提出`; }

function txtProcess() { return `🎟️ 【流程】

① 管理員上場次（自動偵測票價、設上限）
② 實名制場次：成員先提交實名
③ 成員下單（搶票日4天前截止）
④ 搶票前 3 天：Bot @ 所有訂單成員
⑤ 搶票前 1 天：再次 @ 確認
⑥ 搶票日搶票
⑦ 管理員私訊 Bot 配票
⑧ 配票完成 → 群組通知可查
⑨ 成員私訊「我的配票 [場次]」
⑩ 結清行政費`; }

function setupCron() {
  cron.schedule('0 9 * * *', async () => {
    const t = today();
    const shows = db.prepare('SELECT * FROM shows').all();
    for (const s of shows) {
      const days = dDiff(t, s.ticket_sale_date);
      if (days === 3) {
        const mems = db.prepare(`SELECT member_id, member_name, SUM(quantity) qty, SUM(ticket_price*quantity) face FROM orders WHERE show_id=? AND status!="cancelled" GROUP BY member_id`).all(s.id);
        if (mems.length === 0) continue;
        const list = mems.map(m => ({ userId:m.member_id, name:m.member_name, note:`應付票面 ${ntStr(m.face)}（${m.qty}張）` }));
        const intro = `⏰ 【搶票倒數 3 天】${s.name}\n搶票日：${fmtD(s.ticket_sale_date)}\n\n📌 收單將於3天後截止\n\n各成員應付票面：`;
        await pushGroupMention(intro + '\n', list);
        await pushG(`💡 想查為什麼是這個價錢？\n私訊 Bot：我的明細 ${s.id}`);
      }
      if (days === 1) {
        const mems = db.prepare(`SELECT member_id, member_name, SUM(quantity) qty, SUM(ticket_price*quantity) face FROM orders WHERE show_id=? AND status!="cancelled" GROUP BY member_id`).all(s.id);
        if (mems.length === 0) continue;
        const list = mems.map(m => ({ userId:m.member_id, name:m.member_name, note:`應付 ${ntStr(m.face)}` }));
        const intro = `🎫 【明日搶票 - 最後確認】${s.name}\n\n請以下成員確認並完成票面匯款：`;
        await pushGroupMention(intro + '\n', list);
        await pushG(`💳 匯款後：匯款確認 [後五碼]\n📋 明細：我的明細 ${s.id}（私訊）\n❗搶票日起不接受取消`);
      }
    }
  }, { timezone: 'Asia/Taipei' });
  // 每小時自動備份一次（保險措施）
  if (octokit && GH_OWNER) {
    cron.schedule('0 * * * *', () => performBackup().catch(console.error), { timezone: 'Asia/Taipei' });
    console.log('✅ 自動備份排程已啟動（每小時一次）');
  }
  console.log('✅ 定時提醒已啟動');
}

app.post('/webhook', line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then(r => { res.json(r); scheduleBackup(); })
    .catch(e => { console.error(e); res.status(500).end(); });
});
app.get('/', (req, res) => res.send('🤖 LINE Ticket Bot is running!'));
app.get('/health', (req, res) => res.json({ status:'OK', time:new Date().toISOString(), lastBackup:lastBackupTime }));

async function startup() {
  initDB();
  await restoreFromBackup();
  setupCron();
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`🤖 Bot 啟動，Port ${PORT}`));
}
startup();
