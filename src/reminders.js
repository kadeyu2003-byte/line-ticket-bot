'use strict';

const store = require('./store');
const { daysUntil, money, calcServiceFee, isLastDayOfMonth, LINE, DLINE } = require('./helpers');

/** 取得場次「有登記」的成員 */
function activeMembers(eventId) {
  const orders = store.data.orders[eventId] || {};
  return Object.entries(orders)
    .filter(([, r]) => Object.keys(r.items).length > 0)
    .map(([userId, r]) => ({ userId, ...r }));
}

function totalQty(items) {
  return Object.values(items).reduce((a, b) => a + b, 0);
}

/** 搶票前 3 天：提醒繳票款（票面 + 拓元手續費） */
function buildTicketReminder(e) {
  const members = activeMembers(e.id);
  if (members.length === 0) return null;

  let msg = `⏰ 繳費提醒（搶票前 3 天）\n🎵 ${e.name} - ${e.session}\n🎫 搶票日：${e.grabDate}\n`;
  msg += `📌 請於搶票前完成「票款」匯款（票面 ＋ 拓元手續費 ${money(e.tixFee)}/張）\n` + DLINE + '\n';

  let grand = 0;
  members.forEach((m) => {
    let sum = 0;
    const parts = [];
    for (const [price, qty] of Object.entries(m.items)) {
      const sub = (Number(price) + e.tixFee) * qty;
      sum += sub;
      parts.push(`${money(Number(price))}×${qty}`);
    }
    grand += sum;
    msg += `👤 ${m.name}：${parts.join(' + ')} ＝ ${money(sum)}${m.paid.ticket ? ' ✅已繳' : ''}\n`;
  });
  msg += LINE + `\n💰 全體票款合計：${money(grand)}`;
  msg += '\n💳 匯款後請回報末五碼給管理員核對～';
  return msg;
}

/** 搶票後 2 天：提醒繳服務費（依票價分區） */
function buildServiceReminder(e) {
  const members = activeMembers(e.id);
  if (members.length === 0) return null;

  const sf = e.serviceFee;
  const isSet = sf && typeof sf === 'object' && Object.keys(sf).length > 0;

  let msg = `⏰ 服務費提醒（搶票後）\n🎵 ${e.name} - ${e.session}\n` + DLINE + '\n';

  if (!isSet) {
    msg += '⚠️ 本場次服務費尚未設定，請主管理員用「設定服務費 ' + e.id + ' 票價:金額 ...」設定後再提醒。';
    return msg;
  }

  let grand = 0;
  const allMissing = new Set();
  members.forEach((m) => {
    const { total, missing } = calcServiceFee(e, m.items);
    grand += total;
    missing.forEach((p) => allMissing.add(p));
    const detail = Object.entries(m.items)
      .map(([price, qty]) => {
        const fee = sf[price];
        return fee != null ? `${money(Number(price))}區 ${money(fee)}×${qty}` : `${money(Number(price))}區(待設定)`;
      })
      .join('、');
    msg += `👤 ${m.name}：${detail} ＝ ${money(total)}${m.paid.service ? ' ✅已繳' : ''}\n`;
  });
  msg += LINE + `\n💼 全體服務費合計：${money(grand)}`;
  if (allMissing.size > 0) {
    msg += `\n⚠️ 尚未設定服務費的票價區：${[...allMissing].map(money).join('、')}`;
  }
  msg += '\n💳 請於本月底前完成匯款，謝謝配合！';
  return msg;
}

/** 月底：提醒尚未繳清者 */
function buildMonthEndReminder() {
  const blocks = [];
  for (const e of Object.values(store.data.events)) {
    // 只提醒已過搶票日的場次
    if (daysUntil(e.grabDate) > 0) continue;
    const members = activeMembers(e.id);
    const sfSet = e.serviceFee && typeof e.serviceFee === 'object' && Object.keys(e.serviceFee).length > 0;
    const unpaid = members.filter((m) => !m.paid.ticket || (sfSet && !m.paid.service));
    if (unpaid.length === 0) continue;

    let b = `🎵 ${e.name} - ${e.session}（#${e.id}）\n`;
    unpaid.forEach((m) => {
      const owe = [];
      if (!m.paid.ticket) owe.push('票款');
      if (sfSet && !m.paid.service) owe.push('服務費');
      b += `  👤 ${m.name}：尚欠 ${owe.join('、')}\n`;
    });
    blocks.push(b.trim());
  }
  if (blocks.length === 0) return null;

  return [
    '📅 月底繳費提醒',
    '以下成員仍有款項未繳清，請儘速處理：',
    DLINE,
    blocks.join('\n' + LINE + '\n'),
    DLINE,
    '🙏 已繳者請忽略，並提供末五碼供管理員核對。',
  ].join('\n');
}

/**
 * 每日跑一次：檢查 T-3 / T+2 / 月底
 * @param {(text:string)=>Promise} pushFn 推播函式
 */
async function runDaily(pushFn) {
  const today = [];

  for (const e of Object.values(store.data.events)) {
    const d = daysUntil(e.grabDate);

    // 搶票前 3 天（只發一次）
    if (d === 3 && !e.remind.ticket) {
      const m = buildTicketReminder(e);
      if (m) today.push(m);
      e.remind.ticket = true;
      store.save();
    }

    // 搶票後 2 天（只發一次）
    if (d === -2 && !e.remind.service) {
      const m = buildServiceReminder(e);
      if (m) today.push(m);
      e.remind.service = true;
      store.save();
    }
  }

  // 月底未繳提醒
  if (isLastDayOfMonth()) {
    const m = buildMonthEndReminder();
    if (m) today.push(m);
  }

  for (const text of today) {
    await pushFn(text);
  }
  if (today.length) console.log(`[提醒] 已發送 ${today.length} 則`);
}

module.exports = {
  runDaily,
  buildTicketReminder,
  buildServiceReminder,
  buildMonthEndReminder,
};
