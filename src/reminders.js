'use strict';
const store=require('./store');
const {daysUntil,money,getEffectiveFee,isLastDayOfMonth,nowTW,LINE,DLINE}=require('./helpers');
const {ensureArray}=require('./commands/orders');

function activeMembers(eid) {
  const o=store.data.orders[eid]||{};
  return Object.entries(o).filter(([,r])=>{ensureArray(r);return r.items.length>0;}).map(([uid,r])=>({userId:uid,...r}));
}

function buildMentionMsg(text,mentions) {
  const mentionees=[];
  for (const m of mentions) {
    if (m.userId.startsWith('proxy_')) continue;
    const tag='@'+m.name;const idx=text.indexOf(tag);
    if (idx>=0) mentionees.push({index:idx,length:tag.length,type:'user',userId:m.userId});
  }
  return mentionees.length>0?{type:'text',text,mention:{mentionees}}:{type:'text',text};
}

function buildOverdueReminders() {
  const hour=nowTW().getHours();
  if (hour<8||hour>23) return [];
  const messages=[];
  for (const e of Object.values(store.data.events)) {
    const d=daysUntil(e.grabDate),ms=activeMembers(e.id);
    if (ms.length===0) continue;

    // 票款催繳：搶票前3天起
    if (d<=3&&d>=-30) {
      const unpaid=ms.filter(m=>m.items.some(it=>!it.paid.ticket));
      if (unpaid.length>0) {
        const overdue=Math.max(0,3-d);
        if (shouldNag(e,'ticket',overdue)) {
          let text='⚠️ 票款催繳 #'+e.id+' '+e.name+'\n';
          const mentions=[];
          unpaid.forEach(m=>{
            const unpaidItems=m.items.filter(it=>!it.paid.ticket);
            const sum=unpaidItems.reduce((s,it)=>(it.price+e.tixFee)*it.qty+s,0);
            text+='@'+m.name+' '+unpaidItems.length+'筆未繳 共'+money(sum)+'\n';
            mentions.push({userId:m.userId,name:m.name});
          });
          text+='\n💳 請儘速繳交！';
          messages.push(buildMentionMsg(text,mentions));
          markNag(e,'ticket');
        }
      }
    }
    // 服務費催繳：搶票當天起
    const sfSet=e.serviceFee&&typeof e.serviceFee==='object'&&Object.keys(e.serviceFee).length>0;
    if (d<=0&&d>=-30&&sfSet) {
      const unpaid=ms.filter(m=>m.items.some(it=>!it.paid.service));
      if (unpaid.length>0) {
        const overdue=Math.abs(d);
        if (shouldNag(e,'service',overdue)) {
          let text='⚠️ 服務費催繳 #'+e.id+' '+e.name+'\n';
          const mentions=[];
          unpaid.forEach(m=>{
            const unpaidItems=m.items.filter(it=>!it.paid.service);
            const sum=unpaidItems.reduce((s,it)=>{const f=getEffectiveFee(e,it);return s+(f!=null?f*it.qty:0);},0);
            text+='@'+m.name+' '+unpaidItems.length+'筆未繳 共'+money(sum)+'\n';
            mentions.push({userId:m.userId,name:m.name});
          });
          text+='\n💳 服務費最晚搶票後3天內繳清！';
          messages.push(buildMentionMsg(text,mentions));
          markNag(e,'service');
        }
      }
    }
  }
  return messages;
}

function shouldNag(e,type,overdueDays) {
  if (!e._lastNag) e._lastNag={};
  const last=e._lastNag[type]||0;
  const elapsed=(Date.now()-last)/3600000;
  if (overdueDays<=1) return elapsed>=6;
  if (overdueDays<=3) return elapsed>=3;
  return elapsed>=1;
}
function markNag(e,type) {if(!e._lastNag)e._lastNag={};e._lastNag[type]=Date.now();store.save();}

function buildMonthEndReminder() {
  const blocks=[];
  for (const e of Object.values(store.data.events)) {
    if (daysUntil(e.grabDate)>0) continue;
    const ms=activeMembers(e.id);
    const unpaid=ms.filter(m=>m.items.some(it=>!it.paid.ticket||!it.paid.service));
    if (unpaid.length===0) continue;
    let b='🎵 '+e.name+'（#'+e.id+'）\n';
    unpaid.forEach(m=>{
      const tUnpaid=m.items.filter(it=>!it.paid.ticket).length;
      const sUnpaid=m.items.filter(it=>!it.paid.service).length;
      const owe=[];
      if (tUnpaid) owe.push('票款'+tUnpaid+'筆');
      if (sUnpaid) owe.push('服務費'+sUnpaid+'筆');
      b+='  👤 '+m.name+'：'+owe.join('、')+' 未繳\n';
    });
    blocks.push(b.trim());
  }
  if (blocks.length===0) return null;
  return '📅 月底繳費提醒\n'+DLINE+'\n'+blocks.join('\n'+LINE+'\n');
}

async function runHourly(pushFn) {
  const msgs=buildOverdueReminders();
  for (const m of msgs) await pushFn(m);
  if (isLastDayOfMonth()&&nowTW().getHours()===10) {
    const me=buildMonthEndReminder();if(me) await pushFn(me);
  }
}

module.exports={runHourly,buildMonthEndReminder};
