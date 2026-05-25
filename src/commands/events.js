'use strict';

const store = require('../store');
const { isValidDate, daysUntil, money, serviceFeeSummary, LINE, DLINE } = require('../helpers');

/**
 * 新增場次（所有人皆可）
 * 格式：
 *   新增場次 團名 場次 演出日期 搶票日期 票價,票價,... [實名制說明...]
 * 範例：
 *   新增場次 aespa 台北場 2025-08-01 2025-07-15 7880,6880,4880 需證件實名制綁定身分證
 *
 * 「同團不同日期 = 不同場次」；若團名+場次+演出日期完全相同 → 視為重複。
 */
function addEvent(userId, userName, args) {
  if (args.length < 5) {
    return [
      '❌ 格式不完整',
      '',
      '📌 新增場次格式：',
      '新增場次 [團名] [場次] [演出日期] [搶票日期] [票價,票價,...] [實名制說明(選填)]',
      '',
      '📝 範例：',
      '新增場次 aespa 台北場 2025-08-01 2025-07-15 7880,6880,4880 需證件實名制',
      '',
      '💡 日期格式：YYYY-MM-DD',
      '💡 實名制說明可自由填寫（例：免實名 / 綁定身分證 / 需本人取票…）',
    ].join('\n');
  }

  const [name, session, showDate, grabDate, pricesRaw, ...rest] = args;
  const realName = rest.join(' ') || '未註明';

  if (!isValidDate(showDate)) return `❌ 演出日期「${showDate}」格式錯誤，請用 YYYY-MM-DD。`;
  if (!isValidDate(grabDate)) return `❌ 搶票日期「${grabDate}」格式錯誤，請用 YYYY-MM-DD。`;

  const prices = pricesRaw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => n > 0)
    .sort((a, b) => b - a);

  if (prices.length === 0) {
    return `❌ 票價格式錯誤，請用逗號分隔，例如：7880,6880,4880`;
  }

  // 重複偵測：同團 + 同場次 + 同演出日期
  const dup = Object.values(store.data.events).find(
    (e) => e.name === name && e.session === session && e.showDate === showDate
  );
  if (dup) {
    return [
      '⚠️ 這個場次已經有人建立過囉！',
      '',
      `🆔 編號：#${dup.id}`,
      `🎵 ${dup.name}｜${dup.session}`,
      `📅 演出：${dup.showDate}`,
      `🎫 搶票：${dup.grabDate}`,
      '',
      `👉 直接用「下單 ${dup.id} [票價] [張數]」登記即可，不用重複新增。`,
    ].join('\n');
  }

  const id = store.data.nextEventId++;
  store.data.events[id] = {
    id,
    name,
    session,
    showDate,
    grabDate,
    prices,
    realName,
    tixFee: 200, // 拓元手續費預設 200/張
    serviceFee: null, // 服務費僅 OWNER 可設
    createdBy: userId,
    createdByName: userName,
    createdAt: new Date().toISOString(),
    remind: { ticket: false, service: false },
  };
  store.data.orders[id] = {};
  store.save();

  return [
    '✅ 場次新增成功！',
    DLINE,
    `🆔 場次編號：#${id}  ← 下單就用這個`,
    `🎵 團名：${name}`,
    `🎤 場次：${session}`,
    `📅 演出日期：${showDate}`,
    `🎫 搶票日期：${grabDate}`,
    `💰 票價：${prices.join(' / ')}`,
    `🪪 實名制：${realName}`,
    `🧾 拓元手續費：${money(200)}/張（建立者預設）`,
    DLINE,
    `📝 下單方式：下單 ${id} ${prices[0]} 2`,
  ].join('\n');
}

/** 查所有場次 */
function listEvents() {
  const list = Object.values(store.data.events).sort((a, b) => a.id - b.id);
  if (list.length === 0) return '📭 目前沒有任何場次。\n用「新增場次」建立第一個吧！';

  let msg = '🎪 場次列表\n' + DLINE + '\n';
  for (const e of list) {
    const d = daysUntil(e.grabDate);
    let status;
    if (d < 0) status = '⏰ 搶票日已過';
    else if (d === 0) status = '🔥 今天搶票！';
    else if (d <= 3) status = `🔴 剩 ${d} 天（已停止登記）`;
    else status = `🟢 開放登記（剩 ${d} 天）`;

    msg += `#${e.id}｜${e.name} - ${e.session}\n`;
    msg += `  📅 演出：${e.showDate}｜🎫 搶票：${e.grabDate}\n`;
    msg += `  💰 ${e.prices.join('/')}｜🪪 ${e.realName}\n`;
    msg += `  📊 ${status}\n`;
    if (e.serviceFee && Object.keys(e.serviceFee).length > 0)
      msg += `  💼 服務費：${serviceFeeSummary(e)}\n`;
    msg += LINE + '\n';
  }
  msg += '💡 下單：下單 [編號] [票價] [張數]';
  return msg;
}

/** 查單一場次詳情 */
function eventDetail(args) {
  const id = Number(args[0]);
  const e = store.data.events[id];
  if (!e) return `❌ 找不到場次 #${args[0]}，用「查場次」確認編號。`;

  const d = daysUntil(e.grabDate);
  const orders = store.data.orders[id] || {};
  const members = Object.keys(orders).length;

  return [
    `🎫 場次 #${e.id} 詳情`,
    DLINE,
    `🎵 ${e.name}｜${e.session}`,
    `📅 演出日期：${e.showDate}`,
    `🎫 搶票日期：${e.grabDate}（${d < 0 ? '已過' : '剩 ' + d + ' 天'}）`,
    `💰 票價：${e.prices.join(' / ')}`,
    `🪪 實名制：${e.realName}`,
    `🧾 拓元手續費：${money(e.tixFee)}/張`,
    `💼 服務費：${serviceFeeSummary(e)}`,
    `👥 已登記：${members} 人`,
    `🙋 建立者：${e.createdByName}`,
  ].join('\n');
}

/**
 * 刪除場次：限「建立者本人」或 OWNER
 * 格式：刪除場次 [編號]
 */
function deleteEvent(userId, isOwner, args) {
  const id = Number(args[0]);
  const e = store.data.events[id];
  if (!e) return `❌ 找不到場次 #${args[0]}。`;
  if (!isOwner && e.createdBy !== userId) {
    return '⛔ 只有「場次建立者」或管理員可以刪除此場次。';
  }
  delete store.data.events[id];
  delete store.data.orders[id];
  store.save();
  return `🗑️ 已刪除場次 #${id}（${e.name} - ${e.session}）及其所有訂單。`;
}

module.exports = { addEvent, listEvents, eventDetail, deleteEvent };
