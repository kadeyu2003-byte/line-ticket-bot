'use strict';
const store=require('../store');
const {money,getItemFee,LINE,DLINE}=require('../helpers');
const {ensureArray}=require('./orders');

function setServiceFee(isOwner,args) {
  if (!isOwner) return '⛔ 僅限主管理員。';
  const id=Number(args[0]),e=store.data.events[id]; if (!e) return '❌ 找不到場次 #'+args[0];
  const rest=args.slice(1);
  if (rest.length<2) return '❌ 格式：設定服務費 '+id+' 7880 一般:2500 前十排:4000 前五排:5500';
  if (!e.serviceFee||typeof e.serviceFee!=='object') e.serviceFee={};
  const prices=(rest[0]==='全部'||rest[0]==='all')?e.prices:[Number(rest[0])];
  if (prices.length===1&&!e.prices.includes(prices[0])) return '❌ 票價不在此場次。';
  const conds={};
  for (const a of rest.slice(1)) {
    if (a.includes(':')) {const [c,v]=a.split(':');const f=Number(v);if(!(f>=0))return '❌ 金額錯誤：'+a;conds[c]=f;}
    else {const f=Number(a);if(!(f>=0))return '❌ 金額錯誤：'+a;conds['一般']=f;}
  }
  for (const p of prices) {e.serviceFee[p]={...(typeof e.serviceFee[p]==='object'?e.serviceFee[p]:{}),...conds};}
  store.save();
  return renderSF(e,'✅ 服務費已更新');
}
function renderSF(e,title) {
  const sf=e.serviceFee||{},l=[title,'🎵 #'+e.id+' '+e.name,LINE];
  for (const p of e.prices) {
    const t=sf[p]; if (!t){l.push('⬜ '+money(p)+' → 尚未設定');continue;}
    if (typeof t==='number'){l.push('💼 '+money(p)+' → '+money(t));continue;}
    l.push('💼 '+money(p)+' → '+Object.entries(t).map(([c,f])=>c+':'+money(f)).join(' / '));
  }
  return l.join('\n');
}
function viewServiceFee(args) {const e=store.data.events[Number(args[0])];return e?renderSF(e,'💼 服務費 #'+e.id):'❌ 找不到場次。';}
function setTixFee(userId,isOwner,args) {
  if (args.length<2) return '❌ 格式：設定手續費 [編號] [金額]';
  const id=Number(args[0]),fee=Number(args[1]),e=store.data.events[id];
  if (!e) return '❌ 找不到場次。'; if (!isOwner&&e.createdBy!==userId) return '⛔ 僅限建立者或主管理員。';
  if (!(fee>=0)) return '❌ 金額需≥0'; e.tixFee=fee; store.save();
  return '✅ #'+e.id+' 拓元手續費改為 '+money(fee)+'/張';
}

/**
 * 查繳費：每筆訂單項目各自顯示繳費狀態，帶全域序號
 */
function paymentStatus(isOwner,args) {
  if (!isOwner) return '⛔ 僅限主管理員。';
  const id=Number(args[0]),e=store.data.events[id]; if (!e) return '❌ 找不到場次。';
  const orders=store.data.orders[id]||{};
  const allItems=[]; // {seq, name, userId, itemIdx, item}
  let seq=0;
  for (const [uid,rec] of Object.entries(orders)) {
    ensureArray(rec);
    rec.items.forEach((it,i)=>{
      seq++;
      allItems.push({seq,name:rec.name,userId:uid,itemIdx:i,item:it});
    });
  }
  if (allItems.length===0) return '📭 沒有訂單。';
  let msg='💳 繳費明細 #'+e.id+' '+e.name+'\n'+DLINE+'\n';
  let curName='';
  for (const a of allItems) {
    if (a.name!==curName) {curName=a.name; msg+='👤 '+a.name+'\n';}
    const fee=getItemFee(e,a.item.price,a.item.note);
    const tc=(a.item.price+e.tixFee)*a.item.qty;
    msg+='  '+a.seq+'. '+money(a.item.price)+'×'+a.item.qty+(a.item.note?'（'+a.item.note+'）':'')+'\n';
    msg+='     票款'+money(tc)+' '+(a.item.paid.ticket?'✅':'⬜')+'｜服務費'+(fee!=null?money(fee*a.item.qty):'?')+' '+(a.item.paid.service?'✅':'⬜')+'\n';
  }
  msg+=LINE+'\n📝 登記：登記繳費 '+id+' [序號] [票款|服務費]';
  msg+='\n💡 序號就是上面每筆前面的數字';
  return msg;
}

/**
 * 登記/取消繳費：用全域序號指定某一筆
 */
function markPayment(isOwner,args,markPaid) {
  if (!isOwner) return '⛔ 僅限主管理員。';
  if (args.length<3) return '❌ 格式：'+(markPaid?'登記繳費':'取消繳費')+' [編號] [序號] [票款|服務費]';
  const id=Number(args[0]),targetSeq=parseInt(args[1],10),raw=args[2];
  const e=store.data.events[id]; if (!e) return '❌ 找不到場次。';
  const type=raw.includes('服務')?'service':raw.includes('票')?'ticket':null;
  if (!type) return '❌ 請填「票款」或「服務費」。';
  // 找到對應的 item
  const orders=store.data.orders[id]||{};
  let seq=0,found=null;
  for (const [uid,rec] of Object.entries(orders)) {
    ensureArray(rec);
    for (let i=0;i<rec.items.length;i++) {
      seq++;
      if (seq===targetSeq) {found={uid,rec,idx:i,item:rec.items[i]};break;}
    }
    if (found) break;
  }
  if (!found) return '❌ 序號 '+targetSeq+' 不存在，用「查繳費 '+id+'」確認。';
  found.item.paid[type]=markPaid;
  store.save();
  const label=type==='service'?'服務費':'票款';
  return '✅ 序號'+targetSeq+'（'+found.rec.name+' '+money(found.item.price)+'×'+found.item.qty+'）'
    +label+'→'+(markPaid?'已繳✅':'未繳⬜');
}

module.exports={setServiceFee,viewServiceFee,setTixFee,paymentStatus,markPayment};
