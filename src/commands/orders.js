'use strict';

const store = require('../store');
const { daysUntil, money, calcServiceFee, LINE, DLINE } = require('../helpers');

/** 取得某成員在某場次的總張數 */
function memberQty(eventId, userId) {
  const o = store.data.orders[eventId]?.[userId];
  if (!o) return 0;
  return Object.values(o.items).reduce((a, b) => a + b, 0);
}

/**
 * 下單 / 登記訂單
 * 格式：下單 [場次編號] [票價] [張數]
 * 範例：下單 3 7880 2
 */
function order(userId, userName, args) {
  if (args.length < 3) {
    return [
      '❌ 格式錯誤',
      '',
      '📌 下單格式：下單 [場次編號] [票價] [張數]',
      '📝 範例：下單 3 7880 2',
      '',
      '💡 場次編號用「查場次」查（就是 # 後面的數字）',
    ].join('\n');
  }

  const id = Number(args[0]);
  const price = Number(args[1]);
  const qty = parseInt(args[2], 10);

  const e = store.data.events[id];
  if (!e) {
    return `❌ 找不到場次 #${args[0]}。\n用「查場次」看看有哪些編號可用。`;
  }

  // ⭐ 搶票日前三天截止規則
  const d = daysUntil(e.grabDate);
  if (d < 0) {
    return [
      '🚫 登記不受理',
      '',
      `「${e.name} - ${e.session}」搶票日（${e.grabDate}）已過，`,
      '無法再登記訂單。',
    ].join('\n');
  }
  if (d <= 3) {
    return [
      '🚫 登記不受理',
      '',
      `「${e.name} - ${e.session}」搶票日為 ${e.grabDate}，`,
      `距今僅剩 ${d} 天。`,
      '',
      '⏰ 規定：搶票日前 3 天內不再受理新登記。',
      '如有急需請直接私訊管理員。',
    ].join('\n');
  }

  if (!e.prices.includes(price)) {
    return `❌ 票價 ${money(price)} 不在此場次。\n✅ 可選：${e.prices.join(' / ')}`;
  }
  if (!qty || qty <= 0 || qty > 20) {
    return '❌ 張數需介於 1 ~ 20 張。';
  }

  // 寫入訂單
  if (!store.data.orders[id]) store.data.orders[id] = {};
  if (!store.data.orders[id][userId]) {
    store.data.orders[id][userId] = {
      name: userName,
      items: {},
      paid: { ticket: false, service: false },
    };
  }
  const rec = store.data.orders[id][userId];
  rec.name = userName; // 名稱可能更新
  rec.items[price] = (rec.items[price] || 0) + qty;
  store.save();

  const total = memberQty(id, userId);
  const ticketCost = price * qty;
  const tixCost = e.tixFee * qty;
  const sfThisTier = e.serviceFee && e.serviceFee[price] != null ? e.serviceFee[price] : null;

  return [
    '✅ 登記成功！',
    DLINE,
    `👤 ${userName}`,
    `🎵 ${e.name} - ${e.session}`,
    `📅 演出：${e.showDate}｜🎫 搶票：${e.grabDate}（剩 ${d} 天）`,
    `💰 本次：${money(price)} × ${qty} 張`,
    `📊 本場次累計：${total} 張`,
    LINE,
    `🧾 預估票款＝票面 ${money(ticketCost)} ＋ 拓元手續費 ${money(tixCost)}`,
    `   ＝ ${money(ticketCost + tixCost)}（搶票前 3 天繳）`,
    sfThisTier != null
      ? `💼 服務費：${money(sfThisTier)}/張 × ${qty} ＝ ${money(sfThisTier * qty)}（搶票後繳）`
      : `💼 服務費：搶到票後由管理員公告`,
    DLINE,
    '📝 取消請用：取消下單 ' + id + ' ' + price + ' [張數]',
  ].join('\n');
}

/**
 * 取消下單
 * 格式：取消下單 [場次編號] [票價] [張數]
 */
function cancel(userId, userName, args) {
  if (args.length < 3) return '❌ 格式：取消下單 [場次編號] [票價] [張數]';

  const id = Number(args[0]);
  const price = Number(args[1]);
  const qty = parseInt(args[2], 10);

  const e = store.data.events[id];
  if (!e) return `❌ 找不到場次 #${args[0]}。`;

  const d = daysUntil(e.grabDate);
  if (d <= 0) {
    return '🚫 依規定，搶票日起不接受取消／退款。有特殊情況請私訊管理員。';
  }

  const rec = store.data.orders[id]?.[userId];
  if (!rec || !rec.items[price]) {
    return `❌ 找不到您在 #${id} 票價 ${money(price)} 的登記。`;
  }
  if (rec.items[price] < qty) {
    return `❌ 您在 ${money(price)} 只登記了 ${rec.items[price]} 張，無法取消 ${qty} 張。`;
  }

  rec.items[price] -= qty;
  if (rec.items[price] === 0) delete rec.items[price];
  // 若整筆清空就移除
  if (Object.keys(rec.items).length === 0) delete store.data.orders[id][userId];
  store.save();

  return [
    '✅ 已取消',
    `🎵 ${e.name} - ${e.session}`,
    `💰 取消：${money(price)} × ${qty} 張`,
    `📊 本場次剩餘：${memberQty(id, userId)} 張`,
  ].join('\n');
}

/** 我的訂單 */
function myOrders(userId, userName) {
  const mine = [];
  for (const e of Object.values(store.data.events)) {
    const rec = store.data.orders[e.id]?.[userId];
    if (rec && Object.keys(rec.items).length > 0) mine.push({ e, rec });
  }
  if (mine.length === 0) {
    return `📭 ${userName}，您目前沒有任何登記。\n用「查場次」看看開放中的場次。`;
  }

  let msg = `📋 ${userName} 的訂單\n` + DLINE + '\n';
  let grand = 0;
  for (const { e, rec } of mine) {
    const total = Object.values(rec.items).reduce((a, b) => a + b, 0);
    grand += total;
    msg += `#${e.id} ${e.name} - ${e.session}（演出 ${e.showDate}）\n`;
    let ticketSum = 0;
    for (const [price, qty] of Object.entries(rec.items)) {
      const sub = (Number(price) + e.tixFee) * qty;
      ticketSum += sub;
      msg += `  💰 ${money(Number(price))} × ${qty}張（含拓元${money(e.tixFee)}）= ${money(sub)}\n`;
    }
    const svc = calcServiceFee(e, rec.items);
    msg += `  🧾 票款合計：${money(ticketSum)}`;
    if (!svc.isSet || svc.missing.length > 0) msg += `｜💼 服務費待公告\n`;
    else msg += `｜💼 服務費：${money(svc.total)}\n`;
    msg += `  💳 票款：${rec.paid.ticket ? '✅已繳' : '⬜未繳'}｜服務費：${rec.paid.service ? '✅已繳' : '⬜未繳'}\n`;
    msg += LINE + '\n';
  }
  msg += `🎫 總計：${grand} 張`;
  return msg;
}

/**
 * 訂單彙整（管理員）— 依票價統計 + 各成員明細
 * 格式：訂單彙整 [場次編號]
 */
function summary(isAdmin, args) {
  if (!isAdmin) return '⛔ 此指令僅限管理員使用。';
  const id = Number(args[0]);
  const e = store.data.events[id];
  if (!e) return `❌ 找不到場次 #${args[0]}。`;

  const orders = store.data.orders[id] || {};
  const members = Object.entries(orders).filter(
    ([, r]) => Object.keys(r.items).length > 0
  );
  if (members.length === 0) return `📭 場次 #${id} 目前沒有任何訂單。`;

  const priceTotals = {};
  e.prices.forEach((p) => (priceTotals[p] = 0));
  let grand = 0;

  let msg = `📊 訂單彙整 #${e.id}\n🎵 ${e.name} - ${e.session}\n📅 演出：${e.showDate}\n👥 ${members.length} 人\n` + DLINE + '\n';

  members.forEach(([, r], idx) => {
    const total = Object.values(r.items).reduce((a, b) => a + b, 0);
    grand += total;
    msg += `${idx + 1}. ${r.name}（${total} 張）`;
    msg += ` 票款${r.paid.ticket ? '✅' : '⬜'}/服務費${r.paid.service ? '✅' : '⬜'}\n`;
    for (const [price, qty] of Object.entries(r.items)) {
      msg += `   ${money(Number(price))} × ${qty}張\n`;
      priceTotals[Number(price)] += qty;
    }
  });

  msg += DLINE + '\n📈 各票價總需求：\n';
  e.prices.forEach((p) => {
    if (priceTotals[p] > 0) msg += `  ${money(p)}：${priceTotals[p]} 張\n`;
  });
  msg += `\n🎫 全場次總張數：${grand} 張`;
  return msg;
}

module.exports = { order, cancel, myOrders, summary, memberQty };
