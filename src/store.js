'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 資料儲存層
 * - 全部存在記憶體中，並同步寫入 data.json（重啟不會掉資料）
 * - 正式上線量大時可改接 Redis / MongoDB，只要改這個檔
 */

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '..', 'data.json');

const defaultData = {
  nextEventId: 1,
  events: {},
  // events[id] = {
  //   id, name, session, showDate, grabDate, grabTime,
  //   prices: [7880, ...],          // 高→低
  //   realName: '需證件實名制 / 免實名…（自由輸入）',
  //   tixFee: 200,                  // 每張拓元手續費（建立時可改，預設200）
  //   serviceFee: null,             // 每張服務費（僅 OWNER 可設）
  //   createdBy, createdByName, createdAt,
  //   remind: { ticket:false, service:false }  // 是否已發過提醒
  // }

  orders: {},
  // orders[eventId][userId] = {
  //   name,
  //   items: { [price]: qty },
  //   paid: { ticket:false, service:false }
  // }

  groups: [],          // 機器人待過的群組 ID（推播提醒用）
  mainGroupId: null,    // 主群組（提醒優先推這裡；未設定則推全部）

  tix: {
    keywords: ['aespa', 'IVE', 'BTS', 'ITZY'],  // 國外場次關鍵字（可改）
    seen: [],          // 已偵測過的拓元場次 URL
    enabled: true,
  },
};

let data = structuredClone(defaultData);

function load() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      data = Object.assign(structuredClone(defaultData), raw);
      // 補齊巢狀預設
      data.tix = Object.assign(structuredClone(defaultData.tix), raw.tix || {});
      console.log(`📂 已載入資料：${Object.keys(data.events).length} 場次`);
    }
  } catch (e) {
    console.error('⚠️ 載入 data.json 失敗，使用空資料：', e.message);
    data = structuredClone(defaultData);
  }
}

let saveTimer = null;
function save() {
  // debounce，避免高頻寫檔
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {
      console.error('⚠️ 寫入 data.json 失敗：', e.message);
    }
  }, 300);
}

// 記錄群組
function rememberGroup(groupId) {
  if (groupId && !data.groups.includes(groupId)) {
    data.groups.push(groupId);
    save();
  }
}

// 推播目標：有主群組就只推主群組，否則推全部
function pushTargets() {
  if (data.mainGroupId) return [data.mainGroupId];
  return data.groups;
}

module.exports = {
  get data() {
    return data;
  },
  load,
  save,
  rememberGroup,
  pushTargets,
  DATA_FILE,
};
