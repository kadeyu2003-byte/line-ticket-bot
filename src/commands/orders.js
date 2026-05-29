'use strict';
const store = require('../store');
const { daysUntil, money, calcServiceFee, calcTicketCost, totalQty, getItemFee, LINE, DLINE } = require('../helpers');

function ensureArray(rec) {
  if (rec && !Array.isArray(rec.items)) {
    rec.items = Object.entries(rec.items||{}).filter(([k])=>!isNaN(Number(k))).map(([p,q])=>({price:Number(p),qty:q,note:''}));
  }
  if (rec) rec.items = (rec.items||[]).filter(it=>!isNaN(it.qty)&&it.qty>0);
}

function order(userId, userName, args) {
  if (args.length < 3) return ['❌ 格式：下單 [編號] [票價] [張數] [備註]','📝 範例：下單 1 9380 2 前五排'].join('\n');
  const id=Number(args[0]),price=Number(args[1]),qty=parseInt(args[2],10),note=args.slice(3).join(' ').trim();
  const e=store.data.events[id];
  if (!e) return '❌ 找不到場次 #'+args[0];
  const d=daysUntil(e.grabDate);
  if (d<1) return '🚫 下單期限已過（最晚搶票前一天）。';
  if (isNaN(qty)||qty<=0||qty>20) return '❌ 張數請填1~20的數字。';
  if (isNaN(price)||!e.prices.includes(price)) return '❌ 票價不在此場次。可選：'+e.prices.join('/');
  if (!store.data.orders[id]) store.data.orders[id]={};
  if (!store.data.orders[id][userId]) store.data.orders[id][userId]={name:userName,items:[],paid:{ticket:false,service:false}};
  const rec=store.data.orders[id][userId]; ensureArray(rec); rec.name=userName;
  const exist=rec.items.find(it=>it.price===price&&(it.note||'')===note);
  if (exist) exist.qty+=qty; else rec.items.push({price,qty,note});
  store.save();
  const tc=(price+e.tixFee)*qty,sfFee=getItemFee(e,price,note),locked=d<=3;
  return ['✅ 登記成功！',DLINE,'👤 '+userName,'🎵 '+e.name+' - '+e.session,
    '💰 '+money(price)+' × '+qty+'張'+(note?'（'+note+'）':''),
    '🧾 票款：'+money(tc)+'（含拓元'+money(e.tixFee)+'/張）',
    sfFee!=null?'💼 服務費：'+money(sfFee)+'/張 × '+qty+' ＝ '+money(sfFee*qty):'💼 服務費：待管理員設定',
    locked?'🔒 訂單已鎖定（搶票前3天內），修改請找管理員':'📝 取消：取消下單 '+id+' '+price+' '+qty+(note?' '+note:''),
    d===1?'⚠️ 搶票前一天下單，訂金請於今天18:00前繳交':'',DLINE].filter(Boolean).join('\n');
}

function cancel(userId, userName, args, isAdmin) {
  if (args.length<3) return '❌ 格式：取消下單 [編號] [票價] [張數] [備註]';
  const id=Number(args[0]),price=Number(args[1]),qty=parseInt(args[2],10),note=args.slice(3).join(' ').trim();
  if (isNaN(qty)||qty<=0) return '❌ 張數請填正整數。';
  const e=store.data.events[id];
  if (!e) return '❌ 找不到場次 #'+args[0];
  const d=daysUntil(e.grabDate);
  if (d<=3&&!isAdmin) return '🔒 搶票前3天起訂單已鎖定。\n如需修改請聯繫管理員，由管理員操作「管理員取消」。';
  const rec=store.data.orders[id]?.[userId];
  if (!rec) return '❌ 找不到您的訂單。'; ensureArray(rec);
  const idx=rec.items.findIndex(it=>it.price===price&&(it.note||'')===note);
  if (idx===-1) return '❌ 找不到 '+money(price)+(note?'（'+note+'）':'')+' 的登記。';
  if (rec.items[idx].qty<qty) return '❌ 只有 '+rec.items[idx].qty+' 張。';
  rec.items[idx].qty-=qty;
  if (rec.items[idx].qty===0) rec.items.splice(idx,1);
  if (rec.items.length===0) delete store.data.orders[id][userId];
  store.save();
  return '✅ 已取消 '+money(price)+(note?'（'+note+'）':'')+' × '+qty+'張';
}

function proxyOrder(isAdmin, args) {
  if (!isAdmin) return '⛔ 僅限管理員。';
  if (args.length<4) return ['❌ 格式：代下單 [編號] [票價] [張數] [成員名稱] [備註]','📝 範例：代下單 1 9380 2 王小明 前五排'].join('\n');
  const id=Number(args[0]),price=Number(args[1]),qty=parseInt(args[2],10),name=args[3],note=args.slice(4).join(' ').trim();
  const e=store.data.events[id];
  if (!e) return '❌ 找不到場次 #'+args[0];
  if (isNaN(qty)||qty<=0) return '❌ 張數請填正整數。';
  if (!e.prices.includes(price)) return '❌ 票價不在此場次。';
  const pid='proxy_'+name;
  if (!store.data.orders[id]) store.data.orders[id]={};
  if (!store.data.orders[id][pid]) store.data.orders[id][pid]={name:name+'（代登記）',items:[],paid:{ticket:false,service:false}};
  const rec=store.data.orders[id][pid];
  const exist=rec.items.find(it=>it.price===price&&(it.note||'')===note);
  if (exist) exist.qty+=qty; else rec.items.push({price,qty,note});
  store.save();
  const sfFee=getItemFee(e,price,note);
  return ['✅ 已代「'+name+'」登記','🎵 #'+id+' '+e.name,'💰 '+money(price)+' × '+qty+'張'+(note?'（'+note+'）':''),
    sfFee!=null?'💼 服務費：'+money(sfFee*qty):''].filter(Boolean).join('\n');
}

function adminCancel(isAdmin, args) {
  if (!isAdmin) return '⛔ 僅限管理員。';
  if (args.length<4) return '❌ 格式：管理員取消 [編號] [成員名稱] [票價] [張數]';
  const id=Number(args[0]),name=args[1],price=Number(args[2]),qty=parseInt(args[3],10);
  if (!store.data.events[id]) return '❌ 找不到場次 #'+args[0];
  const orders=store.data.orders[id]||{};
  const entry=Object.entries(orders).find(([,r])=>r.name&&r.name.replace('（代登記）','')===name);
  if (!entry) return '❌ 找不到「'+name+'」的訂單。';
  const [uid,rec]=entry; ensureArray(rec);
  const idx=rec.items.findIndex(it=>it.price===price);
  if (idx===-1) return '❌「'+name+'」沒有 '+money(price)+' 的訂單。';
  const actual=Math.min(qty,rec.items[idx].qty);
  rec.items[idx].qty-=actual;
  if (rec.items[idx].qty===0) rec.items.splice(idx,1);
  if (rec.items.length===0) delete store.data.orders[id][uid];
  store.save();
  return '✅ 已取消「'+name+'」'+money(price)+' × '+actual+'張（管理員操作）';
}

function myOrders(userId, userName) {
  const mine=[];
  for (const e of Object.values(store.data.events)) {
    const rec=store.data.orders[e.id]?.[userId]; if (!rec) continue; ensureArray(rec);
    if (rec.items.length>0) mine.push({e,rec});
  }
  if (mine.length===0) return '📭 '+userName+'，目前沒有登記。';
  let msg='📋 '+userName+' 的訂單\n'+DLINE+'\n';
  for (const {e,rec} of mine) {
    const tc=calcTicketCost(e,rec.items),sf=calcServiceFee(e,rec.items),locked=daysUntil(e.grabDate)<=3;
    msg+='#'+e.id+' '+e.name+'-'+e.session+(locked?' 🔒':'')+'\n';
    rec.items.forEach(it=>{const fee=getItemFee(e,it.price,it.note);msg+='  💰 '+money(it.price)+'×'+it.qty+(it.note?'（'+it.note+'）':'')+(fee!=null?' 服務費'+money(fee):'')+'\n';});
    msg+='  🧾 票款'+money(tc)+' '+(rec.paid.ticket?'✅':'⬜')+'｜服務費'+(sf.isSet?money(sf.total):'?')+' '+(rec.paid.service?'✅':'⬜')+'\n'+LINE+'\n';
  }
  return msg.trim();
}

function summary(isAdmin, args) {
  if (!isAdmin) return '⛔ 僅限管理員。';
  const id=Number(args[0]),e=store.data.events[id];
  if (!e) return '❌ 找不到場次 #'+args[0];
  const orders=store.data.orders[id]||{};
  const ms=Object.entries(orders).filter(([,r])=>{ensureArray(r);return r.items.length>0;});
  if (ms.length===0) return '📭 #'+id+' 沒有訂單。';
  let msg='📊 彙整 #'+e.id+' '+e.name+'-'+e.session+'\n👥 '+ms.length+'人\n'+DLINE+'\n',grand=0;
  ms.forEach(([,r],i)=>{const tot=totalQty(r.items);grand+=tot;msg+=(i+1)+'. '+r.name+'（'+tot+'張）票款'+(r.paid.ticket?'✅':'⬜')+'/服務費'+(r.paid.service?'✅':'⬜')+'\n';r.items.forEach(it=>{const fee=getItemFee(e,it.price,it.note);msg+='   '+money(it.price)+'×'+it.qty+(it.note?'（'+it.note+'）':'')+(fee!=null?' →'+money(fee):'')+'\n';});});
  msg+=DLINE+'\n🎫 總：'+grand+'張'; return msg;
}

function allOrders(isAdmin) {
  if (!isAdmin) return '⛔ 僅限管理員。';
  const el=Object.values(store.data.events).filter(e=>{const o=store.data.orders[e.id];return o&&Object.values(o).some(r=>{ensureArray(r);return r.items.length>0;});});
  if (el.length===0) return '📭 目前沒有任何訂單。';
  let msg='📊 訂單總覽\n'+DLINE+'\n';
  for (const e of el) {
    const orders=store.data.orders[e.id];
    const ms=Object.entries(orders).filter(([,r])=>{ensureArray(r);return r.items.length>0;});
    const tq=ms.reduce((s,[,r])=>s+totalQty(r.items),0),td=ms.filter(([,r])=>r.paid.ticket).length,sd=ms.filter(([,r])=>r.paid.service).length;
    msg+='#'+e.id+' '+e.name+'-'+e.session+'\n  👥'+ms.length+'人 '+tq+'張｜票款'+td+'/'+ms.length+'✅｜服務費'+sd+'/'+ms.length+'✅\n';
    ms.forEach(([,r])=>{const tc=calcTicketCost(e,r.items),sf=calcServiceFee(e,r.items);msg+='  • '+r.name+'（'+totalQty(r.items)+'張）'+money(tc)+(r.paid.ticket?'✅':'⬜')+(sf.isSet?'｜'+money(sf.total)+(r.paid.service?'✅':'⬜'):'')+'\n';});
    msg+=LINE+'\n';
  }
  return msg.trim();
}

module.exports = { order, cancel, proxyOrder, adminCancel, myOrders, summary, allOrders };
