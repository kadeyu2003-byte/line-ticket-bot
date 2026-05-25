'use strict';

const store = require('../store');
const { money, LINE, DLINE } = require('../helpers');

/**
 * 設定服務費（僅 OWNER）— 依票價分區
 * 格式：
 *   設定服務費 [編號] [票價:金額] [票價:金額] ...
 *   設定服務費 [編號] 全部 [金額]        ← 所有票價區同價
 * 範例：
 *   設定服務費 3 7880:2500 6880:2000 4880:1500
 *   設定服務費 3 全部 2000
 */
function setServiceFee(isOwner, args) {
  if (!isOwner) return '⛔ 服務費只有主管理員可以設定。';

  const id = Number(args[0]);
  const e = store.data.events[id];
  if (!e) return `❌ 找不到場次 #${args[0]}。`;

  const rest = args.slice(1);
  if (rest.length === 0) {
    return [
      '❌ 請指定金額',
      '',
      '📌 依票價分區設定：',
      `設定服務費 ${id} ${e.prices.map((p) => p + ':金額').join(' ')}`,
      '',
      '📌 全部同價：',
      `設定服務費 ${id} 全部 2000`,
      '',
      `📝 範例：設定服務費 ${id} ${e.prices.map((p, i) => `${p}:${2500 - i * 500}`).join(' ')}`,
    ].join('\n');
  }

  if (!e.serviceFee || typeof e.serviceFee !== 'object') e.serviceFee = {};

  // 全部同價
  if (rest[0] === '全部' || rest[0].toLowerCase() === 'all') {
    const fee = Number(rest[1]);
    if (!(fee >= 0)) return '❌ 金額需為 0 或正整數。';
    e.prices.forEach((p) => (e.serviceFee[p] = fee));
    store.save();
    return renderServiceFee(e, '✅ 已將所有票價區服務費設為 ' + money(fee) + '/張');
  }

  // 逐區 price:fee
  for (const token of rest) {
    const seg = token.split(':');
    if (seg.length !== 2) {
      return `❌ 格式錯誤：「${token}」應為「票價:金額」，例如 7880:2500`;
    }
    const price = Number(seg[0]);
    const fee = Number(seg[1]);
    if (!e.prices.includes(price)) {
      return `❌ 票價 ${price} 不在此場次。可選：${e.prices.join(' / ')}`;
    }
    if (!(fee >= 0)) return `❌ 金額需為 0 或正整數：${token}`;
    e.serviceFee[price] = fee;
  }
  store.save();
  return renderServiceFee(e, '✅ 服務費已更新');
}

/** 顯示某場次目前的服務費設定 + 尚未設定的票價區 */
function renderServiceFee(e, title) {
  const sf = e.serviceFee || {};
  const lines = [title, `🎵 #${e.id} ${e.name} - ${e.session}`, '─'.repeat(26)];
  const missing = [];
  for (const p of e.prices) {
    if (sf[p] != null) lines.push(`💼 ${money(p)} → 服務費 ${money(sf[p])}/張`);
    else {
      lines.push(`⬜ ${money(p)} → 尚未設定`);
      missing.push(p);
    }
  }
  if (missing.length > 0) {
    lines.push('', `⚠️ 還有 ${missing.length} 區未設定，提醒時這幾區會顯示「待設定」。`);
  } else {
    lines.push('', '📌 搶票後 2 天系統會自動提醒登記者繳服務費。');
  }
  return lines.join('\n');
}

/** 查服務費（人人可用）：設定服務費 → 查服務費 [編號] */
function viewServiceFee(args) {
  const id = Number(args[0]);
  const e = store.data.events[id];
  if (!e) return `❌ 找不到場次 #${args[0]}。`;
  return renderServiceFee(e, `💼 服務費設定 #${e.id}`);
}

/**
 * 設定拓元手續費（建立者或 OWNER，預設 200）
 * 格式：設定手續費 [場次編號] [每張金額]
 */
function setTixFee(userId, isOwner, args) {
  if (args.length < 2) return '❌ 格式：設定手續費 [場次編號] [每張金額]';
  const id = Number(args[0]);
  const fee = Number(args[1]);
  const e = store.data.events[id];
  if (!e) return `❌ 找不到場次 #${args[0]}。`;
  if (!isOwner && e.createdBy !== userId) {
    return '⛔ 只有場次建立者或主管理員可改手續費。';
  }
  if (!(fee >= 0)) return '❌ 金額需為 0 或正整數。';
  e.tixFee = fee;
  store.save();
  return `✅ #${e.id} 拓元手續費已改為 ${money(fee)}/張。`;
}

/** 取得某場次「有登記」的成員清單（含序號） */
function listMembers(eventId) {
  const orders = store.data.orders[eventId] || {};
  return Object.entries(orders)
    .filter(([, r]) => Object.keys(r.items).length > 0)
    .map(([userId, r]) => ({ userId, ...r }));
}

/**
 * 查繳費狀態（僅 OWNER）— 顯示帶序號的清單
 * 格式：查繳費 [場次編號]
 */
function paymentStatus(isOwner, args) {
  if (!isOwner) return '⛔ 此指令僅限主管理員使用。';
  const id = Number(args[0]);
  const e = store.data.events[id];
  if (!e) return `❌ 找不到場次 #${args[0]}。`;

  const members = listMembers(id);
  if (members.length === 0) return `📭 場次 #${id} 沒有登記者。`;

  let msg = `💳 繳費狀態 #${e.id} ${e.name} - ${e.session}\n` + DLINE + '\n';
  let ticketDone = 0;
  let svcDone = 0;
  members.forEach((m, i) => {
    const qty = Object.values(m.items).reduce((a, b) => a + b, 0);
    if (m.paid.ticket) ticketDone++;
    if (m.paid.service) svcDone++;
    msg += `${i + 1}. ${m.name}（${qty}張）\n`;
    msg += `   票款 ${m.paid.ticket ? '✅已繳' : '⬜未繳'}｜服務費 ${m.paid.service ? '✅已繳' : '⬜未繳'}\n`;
  });
  msg += LINE + '\n';
  msg += `📊 票款：${ticketDone}/${members.length} 已繳｜服務費：${svcDone}/${members.length} 已繳\n`;
  msg += '\n📝 登記已繳：登記繳費 [編號] [序號] [票款|服務費]';
  return msg;
}

/**
 * 登記某人已繳 / 未繳（僅 OWNER）
 * 格式：
 *   登記繳費 [場次編號] [序號] [票款|服務費]      → 標記已繳
 *   取消繳費 [場次編號] [序號] [票款|服務費]      → 標記未繳
 * 序號用「查繳費」取得
 */
function markPayment(isOwner, args, markPaid) {
  if (!isOwner) return '⛔ 此指令僅限主管理員使用。';
  if (args.length < 3) {
    return `❌ 格式：${markPaid ? '登記繳費' : '取消繳費'} [場次編號] [序號] [票款|服務費]\n💡 序號用「查繳費 [編號]」查`;
  }

  const id = Number(args[0]);
  const seq = parseInt(args[1], 10);
  const typeRaw = args[2];

  const e = store.data.events[id];
  if (!e) return `❌ 找不到場次 #${args[0]}。`;

  const type = typeRaw.includes('服務') ? 'service' : typeRaw.includes('票') ? 'ticket' : null;
  if (!type) return '❌ 第三個參數請填「票款」或「服務費」。';

  const members = listMembers(id);
  const m = members[seq - 1];
  if (!m) return `❌ 序號 ${seq} 不存在，用「查繳費 ${id}」確認。`;

  store.data.orders[id][m.userId].paid[type] = markPaid;
  store.save();

  const typeLabel = type === 'service' ? '服務費' : '票款';
  return `✅ 已將「${m.name}」的${typeLabel}標記為 ${markPaid ? '已繳 ✅' : '未繳 ⬜'}（#${id}）`;
}

module.exports = {
  setServiceFee,
  viewServiceFee,
  setTixFee,
  paymentStatus,
  markPayment,
  listMembers,
};
