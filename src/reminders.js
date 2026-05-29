'use strict';
const store = require('./store');
const { daysUntil, money, calcServiceFee, calcTicketCost, totalQty, isLastDayOfMonth, nowTW, LINE, DLINE } = require('./helpers');

function activeMembers(eid) {
  const o=store.data.orders[eid]||{};
  return Object.entries(o).filter(([,r])=>Array.isArray(r.items)&&r.items.length>0).map(([uid,r])=>({userId:uid,...r}));
}

/** 建立帶 @mention 的 LINE 訊息物件 */
function buildMentionMsg(textParts, mentions) {
  // textParts: string, mentions: [{userId, name}] — 在 textParts 中用 @name 表示
  const mentionees = [];
  let text = textParts;
  for (const m of mentions) {
    if (m.userId.startsWith('proxy_')) continue; // 代登記的無法 tag
    const tag = '@' + m.name;
    const idx = text.indexOf(tag);
    if (idx >= 0) mentionees.push({ index: idx, length: tag.length, type: 'user', userId: m.userId });
  }
  if (mentionees.length === 0) return { type: 'text', text };
  return { type: 'text', text, mention: { mentionees } };
}

/**
 * 催繳提醒（搶票前3天起催票款，搶票當天起催服務費）
 * 回傳要推送的訊息陣列（可能是 string 或 LINE msg 物件）
 */
function buildOverdueReminders() {
  const now = nowTW();
  const hour = now.getHours();
  if (hour < 8 || hour > 23) return []; // 晚上不催

  const messages = [];
  for (const e of Object.values(store.data.events)) {
    const d = daysUntil(e.grabDate);
    const ms = activeMembers(e.id);
    if (ms.length === 0) continue;

    // 票款催繳：搶票前3天起（d<=3），未繳者
    if (d <= 3 && d >= -30) {
      const unpaid = ms.filter(m => !m.paid.ticket);
      if (unpaid.length > 0) {
        const overdueDays = Math.max(0, 3 - d); // 0=剛到期, 越大=越逾期
        if (shouldNag(e, 'ticket', overdueDays)) {
          let text = '⚠️ 票款催繳 #' + e.id + ' ' + e.name + '\n';
          const mentions = [];
          unpaid.forEach(m => {
            const tc = calcTicketCost(e, m.items);
            text += '@' + m.name + ' 票款 ' + money(tc) + ' 未繳\n';
            mentions.push({ userId: m.userId, name: m.name });
          });
          text += '\n💳 請儘速繳交！逾期將持續通知。';
          messages.push(buildMentionMsg(text, mentions));
          markNag(e, 'ticket');
        }
      }
    }

    // 服務費催繳：搶票當天起（d<=0），未繳者，且服務費有設定
    const sfSet = e.serviceFee && typeof e.serviceFee === 'object' && Object.keys(e.serviceFee).length > 0;
    if (d <= 0 && d >= -30 && sfSet) {
      const unpaid = ms.filter(m => !m.paid.service);
      if (unpaid.length > 0) {
        const overdueDays = Math.abs(d);
        if (shouldNag(e, 'service', overdueDays)) {
          let text = '⚠️ 服務費催繳 #' + e.id + ' ' + e.name + '\n';
          const mentions = [];
          unpaid.forEach(m => {
            const sf = calcServiceFee(e, m.items);
            text += '@' + m.name + ' 服務費 ' + (sf.isSet ? money(sf.total) : '?') + ' 未繳\n';
            mentions.push({ userId: m.userId, name: m.name });
          });
          text += '\n💳 服務費最晚搶票後3天內繳清！';
          messages.push(buildMentionMsg(text, mentions));
          markNag(e, 'service');
        }
      }
    }
  }
  return messages;
}

/** 判斷是否該發催繳（漸進式：剛到期6hr→逾期3hr→嚴重逾期1hr） */
function shouldNag(e, type, overdueDays) {
  if (!e._lastNag) e._lastNag = {};
  const key = type;
  const last = e._lastNag[key] || 0;
  const elapsed = (Date.now() - last) / 3600000; // 小時
  if (overdueDays <= 1) return elapsed >= 6;
  if (overdueDays <= 3) return elapsed >= 3;
  return elapsed >= 1; // 逾期3天以上，每小時催
}

function markNag(e, type) {
  if (!e._lastNag) e._lastNag = {};
  e._lastNag[type] = Date.now();
  store.save();
}

/** 月底未繳總提醒 */
function buildMonthEndReminder() {
  const blocks = [];
  for (const e of Object.values(store.data.events)) {
    if (daysUntil(e.grabDate) > 0) continue;
    const ms = activeMembers(e.id);
    const sfSet = e.serviceFee && typeof e.serviceFee === 'object' && Object.keys(e.serviceFee).length > 0;
    const unpaid = ms.filter(m => !m.paid.ticket || (sfSet && !m.paid.service));
    if (unpaid.length === 0) continue;
    let b = '🎵 ' + e.name + '（#' + e.id + '）\n';
    unpaid.forEach(m => {
      const owe = [];
      if (!m.paid.ticket) owe.push('票款' + money(calcTicketCost(e, m.items)));
      if (sfSet && !m.paid.service) { const sf = calcServiceFee(e, m.items); owe.push('服務費' + (sf.isSet ? money(sf.total) : '?')); }
      b += '  👤 ' + m.name + '：欠 ' + owe.join('、') + '\n';
    });
    blocks.push(b.trim());
  }
  if (blocks.length === 0) return null;
  return '📅 月底繳費提醒\n' + DLINE + '\n' + blocks.join('\n' + LINE + '\n');
}

/** 主排程：每小時跑一次 */
async function runHourly(pushFn) {
  // 催繳（帶 tag）
  const msgs = buildOverdueReminders();
  for (const m of msgs) await pushFn(m);

  // 月底
  if (isLastDayOfMonth() && nowTW().getHours() === 10) {
    const me = buildMonthEndReminder();
    if (me) await pushFn(me);
  }
}

module.exports = { runHourly, buildMonthEndReminder };
