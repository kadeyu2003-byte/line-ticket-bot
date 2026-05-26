'use strict';
const store = require('../store');
const { money, getItemFee, calcServiceFee, calcTicketCost, totalQty, LINE, DLINE } = require('../helpers');

/**
 * 設定服務費（OWNER）— 支援條件分區
 * 格式：
 *   設定服務費 [編號] [票價] [金額]                   → 一般:金額
 *   設定服務費 [編號] [票價] 一般:2500 前十排:4000 前五排:5500
 *   設定服務費 [編號] 全部 [金額]                     → 全部票價 一般:金額
 *   設定服務費 [編號] 全部 一般:2500 前十排:4000
 */
function setServiceFee(isOwner, args) {
  if (!isOwner) return '⛔ 服務費只有主管理員可以設定。';
  const id = Number(args[0]);
  const e = store.data.events[id];
  if (!e) return `❌ 找不到場次 #${args[0]}。`;
  const rest = args.slice(1);
  if (rest.length < 2) {
    return [
      '❌ 格式：', '',
      `📌 單價設定：設定服務費 ${id} 7880 2500`,
      `📌 條件設定：設定服務費 ${id} 7880 一般:2500 前十排:4000 前五排:5500`,
      `📌 全部同價：設定服務費 ${id} 全部 2000`,
      `📌 全部+條件：設定服務費 ${id} 全部 一般:2000 前十排:3000`,
    ].join('\n');
  }
  if (!e.serviceFee || typeof e.serviceFee !== 'object') e.serviceFee = {};
  const priceOrAll = rest[0];
  const feeArgs = rest.slice(1);
  const targetPrices = (priceOrAll === '全部' || priceOrAll.toLowerCase() === 'all')
    ? e.prices : [Number(priceOrAll)];
  if (targetPrices.length === 1 && !e.prices.includes(targetPrices[0])) {
    return `❌ 票價 ${targetPrices[0]} 不在此場次。可選：${e.prices.join(' / ')}`;
  }
  // 解析 feeArgs：純數字 = 一般:X，含冒號 = 條件:X
  const conditions = {};
  for (const a of feeArgs) {
    if (a.includes(':')) {
      const [cond, val] = a.split(':');
      const f = Number(val);
      if (!(f >= 0)) return `❌ 金額錯誤：${a}`;
      conditions[cond] = f;
    } else {
      const f = Number(a);
      if (!(f >= 0)) return `❌ 金額錯誤：${a}`;
      conditions['一般'] = f;
    }
  }
  for (const p of targetPrices) {
    const existing = typeof e.serviceFee[p] === 'object' ? e.serviceFee[p] : {};
    e.serviceFee[p] = { ...existing, ...conditions };
  }
  store.save();
  return renderServiceFee(e, '✅ 服務費已更新');
}

function renderServiceFee(e, title) {
  const sf = e.serviceFee || {};
  const lines = [title, `🎵 #${e.id} ${e.name} - ${e.session}`, LINE];
  for (const p of e.prices) {
    const tier = sf[p];
    if (!tier) { lines.push(`⬜ ${money(p)} → 尚未設定`); continue; }
    if (typeof tier === 'number') { lines.push(`💼 ${money(p)} → ${money(tier)}/張`); continue; }
    const detail = Object.entries(tier).map(([c, f]) => `${c}:${money(f)}`).join(' / ');
    lines.push(`💼 ${money(p)} → ${detail}`);
  }
  return lines.join('\n');
}

function viewServiceFee(args) {
  const id = Number(args[0]);
  const e = store.data.events[id];
  if (!e) return `❌ 找不到場次 #${args[0]}。`;
  return renderServiceFee(e, `💼 服務費設定 #${e.id}`);
}

function setTixFee(userId, isOwner, args) {
  if (args.length < 2) return '❌ 格式：設定手續費 [編號] [金額]';
  const id = Number(args[0]), fee = Number(args[1]);
  const e = store.data.events[id];
  if (!e) return `❌ 找不到場次 #${args[0]}。`;
  if (!isOwner && e.createdBy !== userId) return '⛔ 只有建立者或主管理員可改。';
  if (!(fee >= 0)) return '❌ 金額需 ≥ 0。';
  e.tixFee = fee; store.save();
  return `✅ #${e.id} 拓元手續費改為 ${money(fee)}/張。`;
}

function listMembers(eventId) {
  const orders = store.data.orders[eventId] || {};
  return Object.entries(orders)
    .filter(([, r]) => Array.isArray(r.items) && r.items.length > 0)
    .map(([userId, r]) => ({ userId, ...r }));
}

function paymentStatus(isOwner, args) {
  if (!isOwner) return '⛔ 僅限主管理員。';
  const id = Number(args[0]);
  const e = store.data.events[id];
  if (!e) return `❌ 找不到場次 #${args[0]}。`;
  const members = listMembers(id);
  if (members.length === 0) return `📭 場次 #${id} 沒有登記者。`;
  let msg = `💳 繳費狀態 #${e.id} ${e.name}\n` + DLINE + '\n';
  members.forEach((m, i) => {
    const tc = calcTicketCost(e, m.items);
    const sf = calcServiceFee(e, m.items);
    msg += `${i + 1}. ${m.name}（${totalQty(m.items)}張）\n`;
    msg += `   票款${money(tc)} ${m.paid.ticket ? '✅' : '⬜'}｜服務費${sf.isSet ? money(sf.total) : '?'} ${m.paid.service ? '✅' : '⬜'}\n`;
  });
  msg += LINE + '\n📝 登記：登記繳費 [編號] [序號] [票款|服務費]';
  return msg;
}

function markPayment(isOwner, args, markPaid) {
  if (!isOwner) return '⛔ 僅限主管理員。';
  if (args.length < 3) return `❌ 格式：${markPaid ? '登記繳費' : '取消繳費'} [編號] [序號] [票款|服務費]`;
  const id = Number(args[0]), seq = parseInt(args[1], 10), typeRaw = args[2];
  const e = store.data.events[id];
  if (!e) return `❌ 找不到場次 #${args[0]}。`;
  const type = typeRaw.includes('服務') ? 'service' : typeRaw.includes('票') ? 'ticket' : null;
  if (!type) return '❌ 請填「票款」或「服務費」。';
  const members = listMembers(id);
  const m = members[seq - 1];
  if (!m) return `❌ 序號 ${seq} 不存在。`;
  store.data.orders[id][m.userId].paid[type] = markPaid;
  store.save();
  return `✅ ${m.name} 的${type === 'service' ? '服務費' : '票款'}→${markPaid ? '已繳✅' : '未繳⬜'}`;
}

/** 成員自報繳費：回報繳費 [編號] [票款|服務費] */
function reportPayment(userId, userName, args) {
  if (args.length < 2) return '❌ 格式：回報繳費 [場次編號] [票款|服務費]';
  const id = Number(args[0]), typeRaw = args[1];
  const e = store.data.events[id];
  if (!e) return `❌ 找不到場次 #${args[0]}。`;
  const rec = store.data.orders[id]?.[userId];
  if (!rec) return '❌ 您在此場次沒有訂單。';
  const type = typeRaw.includes('服務') ? 'service' : typeRaw.includes('票') ? 'ticket' : null;
  if (!type) return '❌ 請填「票款」或「服務費」。';
  rec.paid[type] = true;
  store.save();
  const label = type === 'service' ? '服務費' : '票款';
  const tc = calcTicketCost(e, rec.items);
  const sf = calcServiceFee(e, rec.items);
  return [
    `✅ ${userName} 回報「${label}」已繳`,
    `🎵 #${e.id} ${e.name}`,
    `🧾 票款${money(tc)} ${rec.paid.ticket ? '✅' : '⬜'}｜服務費${sf.isSet ? money(sf.total) : '?'} ${rec.paid.service ? '✅' : '⬜'}`,
  ].join('\n');
}

module.exports = { setServiceFee, viewServiceFee, setTixFee, paymentStatus, markPayment, reportPayment, listMembers };
