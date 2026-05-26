'use strict';

const fs = require('fs');
const path = require('path');

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '..', 'data.json');

const defaultData = {
  nextEventId: 1,
  events: {},
  orders: {},
  groups: [],
  mainGroupId: null,
  whitelist: [],
  blacklist: [],
  tix: {
    keywords: ['aespa', 'IVE', 'BTS', 'ITZY'],
    overseasSites: ['https://ticketmaster.sg'],
    seen: [],
    enabled: true,
  },
};

let data = structuredClone(defaultData);
let collection = null; // MongoDB collection（如果有設定）

/**
 * 初始化：優先用 MongoDB，沒設定就退回 JSON 檔
 * MongoDB 資料不會因 Render 重新部署而消失
 */
async function init() {
  const uri = process.env.MONGODB_URI;
  if (uri) {
    try {
      const { MongoClient } = require('mongodb');
      const client = new MongoClient(uri);
      await client.connect();
      collection = client.db('ticketbot').collection('store');
      const doc = await collection.findOne({ _id: 'main' });
      if (doc) {
        delete doc._id;
        data = Object.assign(structuredClone(defaultData), doc);
        data.tix = Object.assign(structuredClone(defaultData.tix), doc.tix || {});
      }
      console.log(`☁️ MongoDB 已連線（${Object.keys(data.events).length} 場次）— 資料持久化 OK`);
      return;
    } catch (e) {
      console.error('⚠️ MongoDB 連線失敗，改用本機檔案：', e.message);
      collection = null;
    }
  }
  // 退回本機 JSON（重新部署會消失）
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      data = Object.assign(structuredClone(defaultData), raw);
      data.tix = Object.assign(structuredClone(defaultData.tix), raw.tix || {});
      console.log(`📂 本機 data.json 已載入（${Object.keys(data.events).length} 場次）`);
      console.log('⚠️ 注意：未設定 MONGODB_URI，重新部署資料會消失！');
    }
  } catch (e) {
    console.error('⚠️ data.json 載入失敗：', e.message);
  }
}

// 向後兼容：舊的同步 load（不走 MongoDB）
function load() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      data = Object.assign(structuredClone(defaultData), raw);
      data.tix = Object.assign(structuredClone(defaultData.tix), raw.tix || {});
    }
  } catch (e) {}
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    // 1. 存本機檔（即時備份）
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {}
    // 2. 存 MongoDB（持久化）
    if (collection) {
      collection.replaceOne({ _id: 'main' }, { _id: 'main', ...data }, { upsert: true })
        .catch(e => console.error('[MongoDB save]', e.message));
    }
  }, 500);
}

function rememberGroup(groupId) {
  if (groupId && !data.groups.includes(groupId)) {
    data.groups.push(groupId);
    save();
  }
}

function pushTargets() {
  if (data.mainGroupId) return [data.mainGroupId];
  return data.groups;
}

module.exports = {
  get data() { return data; },
  init,
  load,
  save,
  rememberGroup,
  pushTargets,
};
