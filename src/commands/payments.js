'use strict';
const store = require('../store');
const { money, getItemFee, calcServiceFee, calcTicketCost, totalQty, LINE, DLINE } = require('../helpers');

function setServiceFee(isOwner, args) {
  if (!isOwner) return '⛔ 僅限主管理員。';
  const id=Number(args[0]),e=store.data.events[id];
  if (!e) return '❌ 找不到場次 #'+args[0];
  const rest=args.slice(1);
  if (rest.length<2) return ['❌ 格式：','設定服務費 '+id+' 7880 一般:2500 前十排:4000 前五排:5500','設定服務費 '+id+' 全部 2000'].join('\n');
  if (!e.serviceFee||typeof e.serviceFee!=='object') e.serviceFee={};
  const prices=(rest[0]==='全部'||rest[0]==='all')?e.prices:[Number(rest[0])];
  if (prices.length===1&&!e.prices.includes(prices[0])) return '❌ 票價不在此場次。';
  const conds={};
  for (const a of rest.slice(1)) {
    if (a.includes(':')) {const [c,v]=a.split(':');const f=Number(v);if(!(f>=0))return '❌ 金額錯誤：'+a;conds[c]=f;}
    else {const f=Number(a);if(!(f>=0))return '❌ 金額錯誤：'+a;conds['一般']=f;}
  }
  for (const p of prices) { e.serviceFee[p]={...(typeof e.serviceFee[p]==='object'?e.serviceFee[p]:{}),...conds}; }
  store.save();
  return renderSF(e,'✅ 服務費已更新');
}

function renderSF(e,title) {
  const sf=e.serviceFee||{},lines=[title,'🎵 #'+e.id+' '+e.name,LINE];
  for (const p of e.prices) {
    const t=sf[p]; if (!t){lines.push('⬜ '+money(p)+' → 尚未設定');continue;}
    if (typeof t==='number'){lines.push('💼 '+money(p)+' → '+money(t));continue;}
    lines.push('💼 '+money(p)+' → '+Object.entries(t).map(([c,f])=>c+':'+money(f)).join(' / '));
  }
  return lines.join('\n');
}

function viewServiceFee(args) { const e=store.data.events[Number(args[0])]; return e?renderSF(e,'💼 服務費 #'+e.id):'❌ 找不到場次。'; }

function setTixFee(userId,isOwner,args) {
  if (args.length<2) return '❌ 格式：設定手續費 [編號] [金額]';
  const id=Number(args[0]),fee=Number(args[1]),e=store.data.events[id];
  if (!e) return '❌ 找不到場次。'; if (!isOwner&&e.createdBy!==userId) return '⛔ 僅限建立者或主管理員。';
  if (!(fee>=0)) return '❌ 金額需≥0'; e.tixFee=fee; store.save();
  return '✅ #'+e.id+' 拓元手續費改為 '+money(fee)+'/張';
}

function listMembers(eventId) {
  const orders=store.data.orders[eventId]||{};
  return Object.entries(orders).filter(([,r])=>Array.isArray(r.items)&&r.items.length>0).map(([uid,r])=>({userId:uid,...r}));
}

function paymentStatus(isOwner,args) {
  if (!isOwner) return '⛔ 僅限主管理員。';
  const id=Number(args[0]),e=store.data.events[id];
  if (!e) return '❌ 找不到場次。';
  const ms=listMembers(id); if (ms.length===0) return '📭 沒有登記者。';
  let msg='💳 繳費狀態 #'+e.id+' '+e.name+'\n'+DLINE+'\n';
  ms.forEach((m,i)=>{
    const tc=calcTicketCost(e,m.items),sf=calcServiceFee(e,m.items);
    msg+=(i+1)+'. '+m.name+'（'+totalQty(m.items)+'張）\n   票款'+money(tc)+' '+(m.paid.ticket?'✅':'⬜')+'｜服務費'+(sf.isSet?money(sf.total):'?')+' '+(m.paid.service?'✅':'⬜')+'\n';
  });
  msg+=LINE+'\n📝 登記：登記繳費 [編號] [序號] [票款|服務費]';
  return msg;
}

function markPayment(isOwner,args,markPaid) {
  if (!isOwner) return '⛔ 僅限主管理員。';
  if (args.length<3) return '❌ 格式：'+(markPaid?'登記繳費':'取消繳費')+' [編號] [序號] [票款|服務費]';
  const id=Number(args[0]),seq=parseInt(args[1],10),raw=args[2];
  const e=store.data.events[id]; if (!e) return '❌ 找不到場次。';
  const type=raw.includes('服務')?'service':raw.includes('票')?'ticket':null;
  if (!type) return '❌ 請填「票款」或「服務費」。';
  const ms=listMembers(id),m=ms[seq-1]; if (!m) return '❌ 序號不存在。';
  store.data.orders[id][m.userId].paid[type]=markPaid; store.save();
  return '✅ '+m.name+' 的'+(type==='service'?'服務費':'票款')+'→'+(markPaid?'已繳✅':'未繳⬜');
}

module.exports = { setServiceFee, viewServiceFee, setTixFee, paymentStatus, markPayment, listMembers };
