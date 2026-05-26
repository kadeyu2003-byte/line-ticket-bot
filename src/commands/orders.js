'use strict';
const store = require('../store');
const { daysUntil, money, calcServiceFee, calcTicketCost, totalQty, getItemFee, LINE, DLINE } = require('../helpers');

/**
 * 下單 [編號] [票價] [張數] [備註(選填)]
 * 備註可填「前五排」「前十排」等，會影響服務費
 * items 結構：[{ price, qty, note }]
 */
function order(userId, userName, args) {
  if (args.length < 3) {
    return [
      '❌ 格式錯誤', '',
      '📌 下單 [場次編號] [票價] [張數] [備註]',
      '📝 範例：', '下單 3 7880 2', '下單 3 7880 2 前五排',
      '', '💡 備註可填座位需求（前五排/前十排等），會影響服務費計算',
    ].join('\n');
  }
  const id = Number(args[0]), price = Number(args[1]), qty = parseInt(args[2], 10);
  const note = args.slice(3).join(' ').trim();
  const e = store.data.events[id];
  if (!e) return `❌ 找不到場次 #${args[0]}。用「查場次」看編號。`;
  const d = daysUntil(e.grabDate);
  if (d < 0) return `🚫 「${e.name} - ${e.session}」搶票日已過，無法登記。`;
  if (d <= 3) return `🚫 距搶票日僅剩 ${d} 天，已停止登記。如有急需請私訊管理員。`;
  if (!e.prices.includes(price)) return `❌ 票價 ${money(price)} 不在此場次。可選：${e.prices.join(' / ')}`;
  if (!qty || qty <= 0 || qty > 20) return '❌ 張數需介於 1~20。';

  if (!store.data.orders[id]) store.data.orders[id] = {};
  if (!store.data.orders[id][userId]) {
    store.data.orders[id][userId] = { name: userName, items: [], paid: { ticket: false, service: false } };
  }
  const rec = store.data.orders[id][userId];
  // 兼容舊格式：若 items 是物件，轉成陣列
  if (!Array.isArray(rec.items)) {
    const old = rec.items;
    rec.items = Object.entries(old).filter(([k]) => !isNaN(Number(k))).map(([p, q]) => ({ price: Number(p), qty: q, note: '' }));
  }
  rec.name = userName;
  // 合併同 price+note
  const exist = rec.items.find(it => it.price === price && (it.note || '') === note);
  if (exist) exist.qty += qty;
  else rec.items.push({ price, qty, note });
  store.save();

  const tot = totalQty(rec.items);
  const ticketCost = (price + e.tixFee) * qty;
  const sfFee = getItemFee(e, price, note);

  const lines = [
    '✅ 登記成功！', DLINE,
    `👤 ${userName}`,
    `🎵 ${e.name} - ${e.session}`,
    `📅 演出：${e.showDate}｜🎫 搶票：${e.grabDate}（剩 ${d} 天）`,
    `💰 ${money(price)} × ${qty} 張${note ? '（' + note + '）' : ''}`,
    `📊 本場次累計：${tot} 張`, LINE,
    `🧾 本次票款＝${money(ticketCost)}（含拓元${money(e.tixFee)}/張）`,
  ];
  if (sfFee != null) lines.push(`💼 服務費：${money(sfFee)}/張 × ${qty} ＝ ${money(sfFee * qty)}`);
  else lines.push('💼 服務費：待管理員設定');
  if (note) lines.push(`📝 備註：${note}`);
  lines.push(DLINE, `📝 取消：取消下單 ${id} ${price} ${qty}${note ? ' ' + note : ''}`);
  return lines.join('\n');
}

function cancel(userId, userName, args) {
  if (args.length < 3) return '❌ 格式：取消下單 [編號] [票價] [張數] [備註]';
  const id = Number(args[0]), price = Number(args[1]), qty = parseInt(args[2], 10);
  const note = args.slice(3).join(' ').trim();
  const e = store.data.events[id];
  if (!e) return `❌ 找不到場次 #${args[0]}。`;
  if (daysUntil(e.grabDate) <= 0) return '🚫 搶票日起不接受取消。';
  const rec = store.data.orders[id]?.[userId];
  if (!rec || !Array.isArray(rec.items)) return '❌ 找不到您的訂單。';
  const idx = rec.items.findIndex(it => it.price === price && (it.note || '') === note);
  if (idx === -1) return `❌ 找不到 ${money(price)}${note ? '（' + note + '）' : ''} 的登記。`;
  if (rec.items[idx].qty < qty) return `❌ 只有 ${rec.items[idx].qty} 張，無法取消 ${qty} 張。`;
  rec.items[idx].qty -= qty;
  if (rec.items[idx].qty === 0) rec.items.splice(idx, 1);
  if (rec.items.length === 0) delete store.data.orders[id][userId];
  store.save();
  return `✅ 已取消 ${money(price)}${note ? '（' + note + '）' : ''} × ${qty} 張`;
}

function myOrders(userId, userName) {
  const mine = [];
  for (const e of Object.values(store.data.events)) {
    const rec = store.data.orders[e.id]?.[userId];
    if (rec && Array.isArray(rec.items) && rec.items.length > 0) mine.push({ e, rec });
  }
  if (mine.length === 0) return `📭 ${userName}，目前沒有任何登記。`;
  let msg = `📋 ${userName} 的訂單\n` + DLINE + '\n';
  for (const { e, rec } of mine) {
    const tc = calcTicketCost(e, rec.items);
    const sf = calcServiceFee(e, rec.items);
    msg += `#${e.id} ${e.name} - ${e.session}（${e.showDate}）\n`;
    for (const it of rec.items) {
      const fee = getItemFee(e, it.price, it.note);
      msg += `  💰 ${money(it.price)} × ${it.qty}張${it.note ? '（' + it.note + '）' : ''}`;
      msg += fee != null ? ` 服務費${money(fee)}/張` : '';
      msg += '\n';
    }
    msg += `  🧾 票款：${money(tc)}${sf.isSet ? '｜服務費：' + money(sf.total) : '｜服務費待設定'}\n`;
    msg += `  💳 票款${rec.paid.ticket ? '✅' : '⬜'}｜服務費${rec.paid.service ? '✅' : '⬜'}\n`;
    msg += LINE + '\n';
  }
  return msg.trim();
}

/** 訂單彙整（管理員，單場次） */
function summary(isAdmin, args) {
  if (!isAdmin) return '⛔ 僅限管理員。';
  const id = Number(args[0]);
  const e = store.data.events[id];
  if (!e) return `❌ 找不到場次 #${args[0]}。`;
  const orders = store.data.orders[id] || {};
  const members = Object.entries(orders).filter(([, r]) => Array.isArray(r.items) && r.items.length > 0);
  if (members.length === 0) return `📭 場次 #${id} 沒有訂單。`;
  let msg = `📊 訂單彙整 #${e.id} ${e.name} - ${e.session}\n👥 ${members.length} 人\n` + DLINE + '\n';
  let grand = 0;
  members.forEach(([, r], i) => {
    const tot = totalQty(r.items);
    grand += tot;
    msg += `${i + 1}. ${r.name}（${tot}張）票款${r.paid.ticket ? '✅' : '⬜'}/服務費${r.paid.service ? '✅' : '⬜'}\n`;
    for (const it of r.items) {
      const fee = getItemFee(e, it.price, it.note);
      msg += `   ${money(it.price)} × ${it.qty}${it.note ? '（' + it.note + '）' : ''}`;
      msg += fee != null ? ` → 服務費${money(fee)}/張` : '';
      msg += '\n';
    }
  });
  msg += DLINE + `\n🎫 總張數：${grand}`;
  return msg;
}

/** 訂單總覽（管理員，跨場次） */
function allOrders(isAdmin) {
  if (!isAdmin) return '⛔ 僅限管理員。';
  const eventList = Object.values(store.data.events).filter(e => {
    const o = store.data.orders[e.id];
    return o && Object.values(o).some(r => Array.isArray(r.items) && r.items.length > 0);
  });
  if (eventList.length === 0) return '📭 目前所有場次都沒有訂單。';
  let msg = '📊 訂單總覽（全部場次）\n' + DLINE + '\n';
  for (const e of eventList) {
    const orders = store.data.orders[e.id];
    const members = Object.entries(orders).filter(([, r]) => Array.isArray(r.items) && r.items.length > 0);
    const totQty = members.reduce((s, [, r]) => s + totalQty(r.items), 0);
    const ticketDone = members.filter(([, r]) => r.paid.ticket).length;
    const svcDone = members.filter(([, r]) => r.paid.service).length;
    msg += `#${e.id} ${e.name}-${e.session}（${e.showDate}）\n`;
    msg += `  👥 ${members.length}人 ${totQty}張｜票款${ticketDone}/${members.length}✅｜服務費${svcDone}/${members.length}✅\n`;
    for (const [, r] of members) {
      const tot = totalQty(r.items);
      const tc = calcTicketCost(e, r.items);
      const sf = calcServiceFee(e, r.items);
      msg += `  • ${r.name}（${tot}張）票款${money(tc)}${r.paid.ticket ? '✅' : '⬜'}`;
      msg += sf.isSet ? `｜服務費${money(sf.total)}${r.paid.service ? '✅' : '⬜'}` : '';
      msg += '\n';
    }
    msg += LINE + '\n';
  }
  return msg.trim();
}

module.exports = { order, cancel, myOrders, summary, allOrders };
