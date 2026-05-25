'use strict';

const store = require('./store');
const events = require('./commands/events');
const orders = require('./commands/orders');
const payments = require('./commands/payments');
const lists = require('./commands/lists');
const tix = require('./commands/tixcraft');
const info = require('./commands/info');

/**
 * 解析使用者訊息並回傳機器人的回覆文字（沒有對應指令則回傳 null）
 * @param {object} ctx { text, userId, userName, sourceType, groupId, isAdmin, isOwner }
 */
function route(ctx) {
  const { text, userId, userName, groupId, isAdmin, isOwner } = ctx;
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0];
  const args = parts.slice(1);

  switch (cmd) {
    // ---- 場次 ----
    case '查場次':
    case '場次列表':
      return events.listEvents();
    case '場次':
      return events.eventDetail(args);
    case '新增場次':
      return events.addEvent(userId, userName, args);
    case '刪除場次':
      return events.deleteEvent(userId, isAdmin, args);

    // ---- 訂單 ----
    case '下單':
    case '登記':
      return orders.order(userId, userName, args);
    case '取消下單':
    case '取消登記':
      return orders.cancel(userId, userName, args);
    case '我的訂單':
      return orders.myOrders(userId, userName);
    case '訂單彙整':
      return orders.summary(isAdmin, args);

    // ---- 費用 / 繳費 ----
    case '設定服務費':
      return payments.setServiceFee(isOwner, args);
    case '查服務費':
      return payments.viewServiceFee(args);
    case '設定手續費':
      return payments.setTixFee(userId, isOwner, args);
    case '查繳費':
      return payments.paymentStatus(isOwner, args);
    case '登記繳費':
      return payments.markPayment(isOwner, args, true);
    case '取消繳費':
      return payments.markPayment(isOwner, args, false);

    // ---- 黑白名單 ----
    case '加白名單':
      return lists.add(isAdmin, 'white', args);
    case '加黑名單':
      return lists.add(isAdmin, 'black', args);
    case '移除白名單':
      return lists.remove(isAdmin, 'white', args);
    case '移除黑名單':
      return lists.remove(isAdmin, 'black', args);
    case '查名單':
      return lists.check(args);
    case '查白名單':
      return lists.view(isAdmin, 'white');
    case '查黑名單':
      return lists.view(isAdmin, 'black');

    // ---- 拓元偵測 ----
    case '關鍵字':
      return tix.listKeywords();
    case '新增關鍵字':
      return tix.addKeyword(isOwner, args);
    case '移除關鍵字':
      return tix.removeKeyword(isOwner, args);
    case '開啟偵測':
      return tix.toggleMonitor(isOwner, true);
    case '關閉偵測':
      return tix.toggleMonitor(isOwner, false);

    // ---- 群組設定 ----
    case '設定主群組':
      if (!isOwner) return '⛔ 只有主管理員可以設定主群組。';
      if (!groupId) return '❌ 請在「群組內」輸入此指令。';
      store.data.mainGroupId = groupId;
      store.save();
      return '✅ 已將本群組設為主群組，所有提醒與拓元通知都會發到這裡。';

    // ---- 資訊 ----
    case '規章':
      return info.rules();
    case '幫助':
    case 'help':
    case 'Help':
    case '？':
    case '?':
      return info.help(isAdmin, isOwner);

    default:
      return null; // 非指令，不回應
  }
}

module.exports = { route };
