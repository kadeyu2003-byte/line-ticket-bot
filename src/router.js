'use strict';
const store=require('./store'),events=require('./commands/events'),orders=require('./commands/orders'),
  payments=require('./commands/payments'),lists=require('./commands/lists'),tix=require('./commands/tixcraft'),info=require('./commands/info');

function route(ctx) {
  const {text,userId,userName,groupId,isAdmin,isOwner}=ctx;
  const parts=text.trim().split(/\s+/),cmd=parts[0],args=parts.slice(1);
  switch(cmd) {
    case '查場次': case '場次列表': return events.listEvents();
    case '場次': return events.eventDetail(args);
    case '新增場次': return events.addEvent(userId,userName,args);
    case '刪除場次': return events.deleteEvent(userId,isAdmin,args);
    case '下單': case '登記': return orders.order(userId,userName,args);
    case '取消下單': case '取消登記': return orders.cancel(userId,userName,args,isAdmin);
    case '代下單': return orders.proxyOrder(isAdmin,args);
    case '管理員取消': return orders.adminCancel(isAdmin,args);
    case '我的訂單': return orders.myOrders(userId,userName);
    case '訂單彙整': return orders.summary(isAdmin,args);
    case '訂單總覽': return orders.allOrders(isAdmin);
    case '設定服務費': return payments.setServiceFee(isOwner,args);
    case '查服務費': return payments.viewServiceFee(args);
    case '設定手續費': return payments.setTixFee(userId,isOwner,args);
    case '查繳費': return payments.paymentStatus(isOwner,args);
    case '登記繳費': return payments.markPayment(isOwner,args,true);
    case '取消繳費': return payments.markPayment(isOwner,args,false);
    case '加白名單': return lists.add(isAdmin,'white',args);
    case '加黑名單': return lists.add(isAdmin,'black',args);
    case '移除白名單': return lists.remove(isAdmin,'white',args);
    case '移除黑名單': return lists.remove(isAdmin,'black',args);
    case '查名單': return lists.check(args);
    case '查白名單': return lists.view(isAdmin,'white');
    case '查黑名單': return lists.view(isAdmin,'black');
    case '關鍵字': return tix.listKeywords();
    case '新增關鍵字': return tix.addKeyword(isOwner,args);
    case '移除關鍵字': return tix.removeKeyword(isOwner,args);
    case '開啟偵測': return tix.toggleMonitor(isOwner,true);
    case '關閉偵測': return tix.toggleMonitor(isOwner,false);
    case '重設偵測': return tix.resetSeen(isOwner);
    case '海外站': case '查海外站': return tix.listOverseasSites();
    case '新增海外站': return tix.addOverseasSite(isOwner,args);
    case '移除海外站': return tix.removeOverseasSite(isOwner,args);
    case '設定主群組':
      if (!isOwner) return '⛔ 僅限主管理員。';
      if (!groupId) return '❌ 請在群組內輸入。';
      store.data.mainGroupId=groupId; store.save();
      return '✅ 已設為主群組。';
    case '規章': return info.rules();
    case '幫助': case 'help': case '?': return info.help(isAdmin,isOwner);
    default: return null;
  }
}
module.exports={route};
