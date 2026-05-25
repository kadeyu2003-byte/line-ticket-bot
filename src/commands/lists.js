'use strict';

const store = require('../store');
const { LINE } = require('../helpers');

/**
 * 黑 / 白名單（沿用群組公告的互助機制）
 * 新增/移除/查看完整名單：限管理員
 * 查單一帳號：所有人可用
 */

function ensure() {
  if (!store.data.whitelist) store.data.whitelist = [];
  if (!store.data.blacklist) store.data.blacklist = [];
}

function add(isAdmin, type, args) {
  if (!isAdmin) return '⛔ 此指令僅限管理員使用。';
  ensure();
  if (!args[0]) {
    return `❌ 格式：${type === 'white' ? '加白名單' : '加黑名單'} [帳號/代稱] [備註(選填)]`;
  }
  const account = args[0];
  const note = args.slice(1).join(' ') || '（無備註）';
  const list = type === 'white' ? store.data.whitelist : store.data.blacklist;
  const exist = list.find((i) => i.account === account);
  if (exist) {
    exist.note = note;
    store.save();
    return `✅ 已更新${type === 'white' ? '白' : '黑'}名單：${account}\n📝 ${note}`;
  }
  list.push({ account, note, at: new Date().toLocaleDateString('zh-TW') });
  store.save();
  const tip = type === 'black' ? '\n⚠️ 建議先收全額或婉拒交易。' : '\n✨ 優質客人，可優先配票。';
  return `✅ 已加入${type === 'white' ? '⭐白名單' : '🚫黑名單'}：${account}\n📝 ${note}${tip}`;
}

function remove(isAdmin, type, args) {
  if (!isAdmin) return '⛔ 此指令僅限管理員使用。';
  ensure();
  if (!args[0]) return `❌ 格式：移除${type === 'white' ? '白' : '黑'}名單 [帳號]`;
  const list = type === 'white' ? store.data.whitelist : store.data.blacklist;
  const idx = list.findIndex((i) => i.account === args[0]);
  if (idx === -1) return `❌ 找不到「${args[0]}」。`;
  list.splice(idx, 1);
  store.save();
  return `✅ 已移除：${args[0]}`;
}

function check(args) {
  ensure();
  if (!args[0]) return '❌ 格式：查名單 [帳號/代稱]';
  const account = args[0];
  const w = store.data.whitelist.find((i) => i.account === account);
  const b = store.data.blacklist.find((i) => i.account === account);
  if (!w && !b) return `🔍「${account}」\n✅ 無特殊紀錄，可正常交易。`;
  let msg = `🔍「${account}」\n`;
  if (w) msg += `\n⭐ 白名單｜${w.note}（${w.at}）`;
  if (b) msg += `\n🚫 黑名單｜${b.note}（${b.at}）\n⚠️ 建議先收全額或婉拒！`;
  return msg;
}

function view(isAdmin, type) {
  if (!isAdmin) return '⛔ 此指令僅限管理員使用。';
  ensure();
  const list = type === 'white' ? store.data.whitelist : store.data.blacklist;
  const icon = type === 'white' ? '⭐' : '🚫';
  const name = type === 'white' ? '白名單' : '黑名單';
  if (list.length === 0) return `📭 ${name}目前為空。`;
  let msg = `${icon} ${name}（${list.length} 筆）\n` + LINE + '\n';
  list.forEach((i, n) => {
    msg += `${n + 1}. ${i.account}｜${i.note}（${i.at}）\n`;
  });
  return msg.trim();
}

module.exports = { add, remove, check, view };
