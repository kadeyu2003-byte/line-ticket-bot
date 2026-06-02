'use strict';
const store=require('../store');
const {daysUntil,money,calcTicketCost,totalQty,getItemFee,getEffectiveFee,LINE,DLINE}=require('../helpers');

/** 確保 items 是陣列 + 每個 item 有 paid + 清理 NaN */
function ensureArray(rec) {
  if (!rec) return;
  if (!Array.isArray(rec.items)) {
    rec.items=Object.entries(rec.items||{}).filter(([k])=>!isNaN(Number(k))).map(([p,q])=>({price:Number(p),qty:q,note:''}));
  }
  rec.items=rec.items.filter(it=>!isNaN(it.qty)&&it.qty>0);
  // 遷移：如果 item 沒有自己的 paid，從 record-level 的 paid 繼承
  const fallback=rec.paid||{ticket:false,service:false};
  for (const it of rec.items) {
    if (!it.paid) it.paid={ticket:!!fallback.ticket,service:!!fallback.service};
  }
}

function order(userId,userName,args) {
  if (args.length<3) return ['❌ 格式：下單 [編號] [票價] [張數] [備註]','📝 範例：下單 1 9380 2 前五排'].join('\n');
  const id=Number(args[0]),price=Number(args[1]),qty=parseInt(args[2],10),note=args.slice(3).join(' ').trim();
  const e=store.data.events[id];
  if (!e) return '❌ 找不到場次 #'+args[0];
  const d=daysUntil(e.grabDate);
  if (d<1) return '🚫 下單期限已過（最晚搶票前一天）。';
  if (isNaN(qty)||qty<=0||qty>20) return '❌ 張數請填1~20的數字。';
  if (isNaN(price)||!e.prices.includes(price)) return '❌ 票價不在此場次。可選：'+e.prices.join('/');
  if (!store.data.orders[id]) store.data.orders[id]={};
  if (!store.data.orders[id][userId]) store.data.orders[id][userId]={name:userName,items:[]};
  const rec=store.data.orders[id][userId]; ensureArray(rec); rec.name=userName;
  // 每次下單都建一筆新項目，並鎖定當時的服務費
  const sfFee=getItemFee(e,price,note); // 可能為 null（尚未設定）
  rec.items.push({price,qty,note,paid:{ticket:false,service:false},lockedFee:sfFee});
  store.save();
  const tc=(price+e.tixFee)*qty,locked=d<=3;
  return ['✅ 登記成功！',DLINE,'👤 '+userName,'🎵 '+e.name+' - '+e.session,
    '💰 '+money(price)+' × '+qty+'張'+(note?'（'+note+'）':''),
    '🧾 票款：'+money(tc)+'（含拓元'+money(e.tixFee)+'/張）',
    sfFee!=null?'💼 服務費：'+money(sfFee)+'/張×'+qty+'＝'+money(sfFee*qty):'💼 服務費：待管理員設定',
    locked?'🔒 訂單已鎖定，修改請找管理員':'📝 取消：取消下單 '+id+' '+price+' '+qty+(note?' '+note:''),
    d===1?'⚠️ 搶票前一天下單，訂金請於今天18:00前繳交':'',DLINE].filter(Boolean).join('\n');
}

function cancel(userId,userName,args,isAdmin) {
  if (args.length<3) return '❌ 格式：取消下單 [編號] [票價] [張數] [備註]';
  const id=Number(args[0]),price=Number(args[1]),qty=parseInt(args[2],10),note=args.slice(3).join(' ').trim();
  if (isNaN(qty)||qty<=0) return '❌ 張數請填正整數。';
  const e=store.data.events[id]; if (!e) return '❌ 找不到場次 #'+args[0];
  if (daysUntil(e.grabDate)<=3&&!isAdmin) return '🔒 搶票前3天起訂單已鎖定。\n修改請聯繫管理員操作「管理員取消」。';
  const rec=store.data.orders[id]?.[userId]; if (!rec) return '❌ 找不到您的訂單。'; ensureArray(rec);
  const idx=rec.items.findIndex(it=>it.price===price&&(it.note||'')===note);
  if (idx===-1) return '❌ 找不到 '+money(price)+(note?'（'+note+'）':'')+' 的登記。';
  if (rec.items[idx].qty<qty) return '❌ 只有 '+rec.items[idx].qty+' 張。';
  rec.items[idx].qty-=qty;
  if (rec.items[idx].qty===0) rec.items.splice(idx,1);
  if (rec.items.length===0) delete store.data.orders[id][userId];
  store.save();
  return '✅ 已取消 '+money(price)+(note?'（'+note+'）':'')+' × '+qty+'張';
}

function proxyOrder(isAdmin,args) {
  if (!isAdmin) return '⛔ 僅限管理員。';
  if (args.length<4) return '❌ 格式：代下單 [編號] [票價] [張數] [成員名稱] [備註]';
  const id=Number(args[0]),price=Number(args[1]),qty=parseInt(args[2],10),name=args[3],note=args.slice(4).join(' ').trim();
  const e=store.data.events[id]; if (!e) return '❌ 找不到場次 #'+args[0];
  if (isNaN(qty)||qty<=0) return '❌ 張數請填正整數。';
  if (!e.prices.includes(price)) return '❌ 票價不在此場次。';
  const pid='proxy_'+name;
  if (!store.data.orders[id]) store.data.orders[id]={};
  if (!store.data.orders[id][pid]) store.data.orders[id][pid]={name:name+'（代登記）',items:[]};
  const rec=store.data.orders[id][pid];
  const sfFee=getItemFee(e,price,note);rec.items.push({price,qty,note,paid:{ticket:false,service:false},lockedFee:sfFee});
  store.save();
  return ['✅ 已代「'+name+'」登記','🎵 #'+id+' '+e.name,'💰 '+money(price)+'×'+qty+(note?'（'+note+'）':''),
    sfFee!=null?'💼 服務費：'+money(sfFee*qty):''].filter(Boolean).join('\n');
}

function adminCancel(isAdmin,args) {
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
  return '✅ 已取消「'+name+'」'+money(price)+'×'+actual+'張（管理員操作）';
}

function myOrders(userId,userName) {
  const mine=[];
  for (const e of Object.values(store.data.events)) {
    const rec=store.data.orders[e.id]?.[userId]; if (!rec) continue; ensureArray(rec);
    if (rec.items.length>0) mine.push({e,rec});
  }
  if (mine.length===0) return '📭 '+userName+'，目前沒有登記。';
  let msg='📋 '+userName+' 的訂單\n'+DLINE+'\n';
  for (const {e,rec} of mine) {
    const locked=daysUntil(e.grabDate)<=3;
    msg+='#'+e.id+' '+e.name+'-'+e.session+(locked?' 🔒':'')+'\n';
    rec.items.forEach((it,i)=>{
      const fee=getEffectiveFee(e,it);
      const tc=(it.price+e.tixFee)*it.qty;
      msg+='  '+(i+1)+'. '+money(it.price)+'×'+it.qty+(it.note?'（'+it.note+'）':'')+'\n';
      msg+='     票款'+money(tc)+' '+(it.paid.ticket?'✅':'⬜')+'｜服務費'+(fee!=null?money(fee*it.qty):'?')+' '+(it.paid.service?'✅':'⬜')+'\n';
    });
    msg+=LINE+'\n';
  }
  return msg.trim();
}

function summary(isAdmin,args) {
  if (!isAdmin) return '⛔ 僅限管理員。';
  const id=Number(args[0]),e=store.data.events[id]; if (!e) return '❌ 找不到場次。';
  const orders=store.data.orders[id]||{};
  const ms=Object.entries(orders).filter(([,r])=>{ensureArray(r);return r.items.length>0;});
  if (ms.length===0) return '📭 沒有訂單。';
  let msg='📊 彙整 #'+e.id+' '+e.name+'-'+e.session+'\n'+DLINE+'\n',grand=0;
  ms.forEach(([,r])=>{
    const tot=totalQty(r.items);grand+=tot;
    msg+='👤 '+r.name+'（'+tot+'張）\n';
    r.items.forEach(it=>{
      const fee=getEffectiveFee(e,it);
      msg+='  '+money(it.price)+'×'+it.qty+(it.note?'（'+it.note+'）':'')
        +' 票款'+(it.paid.ticket?'✅':'⬜')+'/'+(fee!=null?'服務費'+money(fee*it.qty):'服務費?')+(it.paid.service?'✅':'⬜')+'\n';
    });
  });
  msg+=DLINE+'\n🎫 總：'+grand+'張'; return msg;
}

function allOrders(isAdmin) {
  if (!isAdmin) return '⛔ 僅限管理員。';
  const el=Object.values(store.data.events).filter(e=>{const o=store.data.orders[e.id];return o&&Object.values(o).some(r=>{ensureArray(r);return r.items.length>0;});});
  if (el.length===0) return '📭 沒有任何訂單。';
  let msg='📊 訂單總覽\n'+DLINE+'\n';
  for (const e of el) {
    const ms=Object.entries(store.data.orders[e.id]).filter(([,r])=>{ensureArray(r);return r.items.length>0;});
    msg+='#'+e.id+' '+e.name+'-'+e.session+'\n';
    ms.forEach(([,r])=>{
      r.items.forEach(it=>{
        const tc=(it.price+e.tixFee)*it.qty;
        msg+='  '+r.name+'｜'+money(it.price)+'×'+it.qty+(it.note?'（'+it.note+'）':'')
          +'｜票款'+(it.paid.ticket?'✅':'⬜')+'｜服務費'+(it.paid.service?'✅':'⬜')+'\n';
      });
    });
    msg+=LINE+'\n';
  }
  return msg.trim();
}

module.exports={order,cancel,proxyOrder,adminCancel,myOrders,summary,allOrders,ensureArray};
