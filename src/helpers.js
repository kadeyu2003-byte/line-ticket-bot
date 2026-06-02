'use strict';

const TZ = 'Asia/Taipei';

function nowTW() {
  const s = new Date().toLocaleString('en-US', { timeZone: TZ });
  return new Date(s);
}

function todayStr() { return toDateStr(nowTW()); }

function toDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function dayDiff(a, b) {
  return Math.round((new Date(`${b}T00:00:00`) - new Date(`${a}T00:00:00`)) / 86400000);
}

function daysUntil(grabDateStr) { return dayDiff(todayStr(), grabDateStr); }

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + n);
  return toDateStr(d);
}

function isValidDate(str) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  const d = new Date(`${str}T00:00:00`);
  return !isNaN(d.getTime()) && toDateStr(d) === str;
}

function isLastDayOfMonth() {
  const d = nowTW();
  const tm = new Date(d); tm.setDate(d.getDate() + 1);
  return tm.getDate() === 1;
}

function money(n) { return '$' + Number(n).toLocaleString('en-US'); }

const LINE = '─'.repeat(26);
const DLINE = '═'.repeat(26);

/**
 * 取得某筆訂單項目的服務費（支援條件分區）
 * serviceFee 結構：
 *   { "7880": { "一般": 2500, "前十排": 4000, "前五排": 5500 }, ... }
 *   或舊格式 { "7880": 2500 }（當作 一般:2500）
 */
function getItemFee(event, price, note) {
  const sf = event.serviceFee;
  if (!sf) return null;
  const tier = sf[price];
  if (tier == null) return null;
  if (typeof tier === 'number') return tier; // 舊格式
  if (typeof tier !== 'object') return null;
  // 有條件的格式
  if (note) {
    if (tier[note] != null) return tier[note]; // 完全匹配
    // 模糊匹配：備註中包含條件關鍵字
    for (const [cond, fee] of Object.entries(tier)) {
      if (cond !== '一般' && note.includes(cond)) return fee;
    }
  }
  return tier['一般'] ?? null;
}

/** 計算整筆訂單的服務費（優先用鎖定費率） */
function calcServiceFee(event, items) {
  let total = 0, isSet = false;
  const missing = [];
  for (const it of items) {
    const fee = (it.lockedFee != null) ? it.lockedFee : getItemFee(event, it.price, it.note);
    if (fee != null) { isSet = true; total += fee * it.qty; }
    else missing.push(it.price);
  }
  return { total, missing, isSet };
}

/** 計算整筆訂單的票款（票面＋拓元手續費） */
function calcTicketCost(event, items) {
  let total = 0;
  for (const it of items) total += (it.price + event.tixFee) * it.qty;
  return total;
}

/** 訂單總張數 */
function totalQty(items) {
  return items.reduce((s, it) => s + it.qty, 0);
}

/** 服務費設定摘要 */
function serviceFeeSummary(event) {
  const sf = event.serviceFee;
  if (!sf || Object.keys(sf).length === 0) return '（尚未設定）';
  const parts = [];
  for (const p of event.prices) {
    const tier = sf[p];
    if (tier == null) continue;
    if (typeof tier === 'number') { parts.push(`${p}:${money(tier)}`); continue; }
    const conds = Object.entries(tier).map(([c, f]) => `${c}${money(f)}`).join('/');
    parts.push(`${p}→${conds}`);
  }
  return parts.join('｜') || '（尚未設定）';
}

/** 取得某項目的有效服務費（優先用鎖定費率，沒有才查當前設定） */
function getEffectiveFee(event, item) {
  if (item.lockedFee != null) return item.lockedFee;
  return getItemFee(event, item.price, item.note);
}

module.exports = {
  TZ, nowTW, todayStr, toDateStr, dayDiff, daysUntil, addDays, isValidDate,
  isLastDayOfMonth, money, LINE, DLINE,
  getItemFee, getEffectiveFee, calcServiceFee, calcTicketCost, totalQty, serviceFeeSummary,
};
