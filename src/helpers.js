'use strict';

/**
 * 共用工具函式：日期、金額、格式化
 * 全部以「台灣時間 (Asia/Taipei)」為基準。
 */

const TZ = 'Asia/Taipei';

/** 取得台灣現在時間的 Date 物件（實際仍是 UTC，但用 TW 字串運算） */
function nowTW() {
  // 透過 toLocaleString 轉成台灣時間字串再 parse，避免伺服器時區影響
  const s = new Date().toLocaleString('en-US', { timeZone: TZ });
  return new Date(s);
}

/** 回傳 YYYY-MM-DD（台灣日期） */
function todayStr() {
  return toDateStr(nowTW());
}

function toDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 兩個 YYYY-MM-DD 相差天數 (b - a)，只看日期 */
function dayDiff(aStr, bStr) {
  const a = new Date(`${aStr}T00:00:00`);
  const b = new Date(`${bStr}T00:00:00`);
  return Math.round((b - a) / 86400000);
}

/** 距離搶票日還有幾天（負數=已過） */
function daysUntil(grabDateStr) {
  return dayDiff(todayStr(), grabDateStr);
}

/** YYYY-MM-DD 加 n 天 */
function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + n);
  return toDateStr(d);
}

/** 驗證日期字串 YYYY-MM-DD 是否合法 */
function isValidDate(str) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  const d = new Date(`${str}T00:00:00`);
  return !isNaN(d.getTime()) && toDateStr(d) === str;
}

/** 是否為當月最後一天（台灣時間） */
function isLastDayOfMonth() {
  const d = nowTW();
  const tomorrow = new Date(d);
  tomorrow.setDate(d.getDate() + 1);
  return tomorrow.getDate() === 1;
}

/** 金額千分位 */
function money(n) {
  return '$' + Number(n).toLocaleString('en-US');
}

const LINE = '─'.repeat(26);
const DLINE = '═'.repeat(26);

/**
 * 計算某成員在某場次的服務費
 * 服務費結構：event.serviceFee = { [票價]: 每張金額 }（依票價分區）
 * @returns {{ total:number, missing:number[], isSet:boolean }}
 *   missing = 有下單但尚未設定服務費的票價區
 */
function calcServiceFee(event, items) {
  const sf = event.serviceFee;
  const isSet = sf && typeof sf === 'object' && Object.keys(sf).length > 0;
  let total = 0;
  const missing = [];
  for (const [price, qty] of Object.entries(items)) {
    const fee = isSet && sf[price] != null ? sf[price] : null;
    if (fee == null) missing.push(Number(price));
    else total += fee * qty;
  }
  return { total, missing, isSet };
}

/** 服務費設定摘要字串，例如「7880:$2,500｜6880:$2,000」 */
function serviceFeeSummary(event) {
  const sf = event.serviceFee;
  if (!sf || typeof sf !== 'object' || Object.keys(sf).length === 0) return '（尚未設定）';
  return event.prices
    .filter((p) => sf[p] != null)
    .map((p) => `${p}:${money(sf[p])}`)
    .join('｜');
}

module.exports = {
  TZ,
  nowTW,
  todayStr,
  toDateStr,
  dayDiff,
  daysUntil,
  addDays,
  isValidDate,
  isLastDayOfMonth,
  money,
  LINE,
  DLINE,
  calcServiceFee,
  serviceFeeSummary,
};
