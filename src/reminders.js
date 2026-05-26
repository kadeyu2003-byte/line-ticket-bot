'use strict';
const store = require('./store');
const { daysUntil, money, calcServiceFee, calcTicketCost, totalQty, isLastDayOfMonth, LINE, DLINE } = require('./helpers');

function activeMembers(eventId) {
  const orders = store.data.orders[eventId] || {};
  return Object.entries(orders)
    .filter(([, r]) => Array.isArray(r.items) && r.items.length > 0)
    .map(([userId, r]) => ({ userId, ...r }));
}

/** 搶票前 3 天：票款提醒 */
function buildTicketReminder(e) {
  const members = activeMembers(e.id);
  if (members.length === 0) return null;
  let msg = `⏰ 票款繳費提醒\n🎵 ${e.name} - ${e.session}\n🎫 搶票日：${e.grabDate}\n` + DLINE + '\n';
  members.forEach((m) => {
    const tc = calcTicketCost(e, m.items);
    msg += `👤 ${m.name}：${money(tc)}${m.paid.ticket ? ' ✅' : ''}\n`;
  });
  msg += LINE + '\n💳 繳完請打：回報繳費 ' + e.id + ' 票款';
  return msg;
}

/** 搶票後 2 天：服務費提醒 */
function buildServiceReminder(e) {
  const members = activeMembers(e.id);
  if (members.length === 0) return null;
  const sf0 = e.serviceFee;
  const isSet = sf0 && typeof sf0 === 'object' && Object.keys(sf0).length > 0;
  if (!isSet) return `⚠️ #${e.id} ${e.name} 服務費尚未設定，請主管理員用「設定服務費」設定。`;
  let msg = `⏰ 服務費繳費提醒\n🎵 ${e.name} - ${e.session}\n` + DLINE + '\n';
  members.forEach((m) => {
    const sf = calcServiceFee(e, m.items);
    msg += `👤 ${m.name}：${sf.isSet ? money(sf.total) : '待設定'}${m.paid.service ? ' ✅' : ''}\n`;
  });
  msg += LINE + '\n💳 繳完請打：回報繳費 ' + e.id + ' 服務費';
  return msg;
}

/** 月底未繳提醒 */
function buildMonthEndReminder() {
  const blocks = [];
  for (const e of Object.values(store.data.events)) {
    if (daysUntil(e.grabDate) > 0) continue;
    const members = activeMembers(e.id);
    const sfSet = e.serviceFee && typeof e.serviceFee === 'object' && Object.keys(e.serviceFee).length > 0;
    const unpaid = members.filter(m => !m.paid.ticket || (sfSet && !m.paid.service));
    if (unpaid.length === 0) continue;
    let b = `🎵 ${e.name}（#${e.id}）\n`;
    unpaid.forEach(m => {
      const owe = [];
      if (!m.paid.ticket) owe.push('票款' + money(calcTicketCost(e, m.items)));
      if (sfSet && !m.paid.service) { const sf = calcServiceFee(e, m.items); owe.push('服務費' + (sf.isSet ? money(sf.total) : '?')); }
      b += `  👤 ${m.name}：欠 ${owe.join('、')}\n`;
    });
    blocks.push(b.trim());
  }
  if (blocks.length === 0) return null;
  return ['📅 月底繳費提醒', DLINE, blocks.join('\n' + LINE + '\n'), DLINE, '💳 繳完請打「回報繳費 [編號] [票款|服務費]」'].join('\n');
}

async function runDaily(pushFn) {
  const today = [];
  for (const e of Object.values(store.data.events)) {
    const d = daysUntil(e.grabDate);
    if (d === 3 && !e.remind?.ticket) { const m = buildTicketReminder(e); if (m) today.push(m); if (!e.remind) e.remind = {}; e.remind.ticket = true; store.save(); }
    if (d === -2 && !e.remind?.service) { const m = buildServiceReminder(e); if (m) today.push(m); if (!e.remind) e.remind = {}; e.remind.service = true; store.save(); }
  }
  if (isLastDayOfMonth()) { const m = buildMonthEndReminder(); if (m) today.push(m); }
  for (const text of today) await pushFn(text);
}

module.exports = { runDaily, buildTicketReminder, buildServiceReminder, buildMonthEndReminder };
