'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const store = require('../store');

/**
 * 拓元（tixcraft）新場次偵測
 *
 * 規則：
 *  - 台灣場次：只要偵測到新場次就在群組通知
 *  - 國外場次：只通知「符合關鍵字」的（aespa / IVE / BTS / ITZY，可隨時改）
 *
 * ⚠️ 重要：tixcraft.com 對程式存取會回 403。本模組已帶瀏覽器標頭，
 *    大多數情況可成功；若拓元加上 Cloudflare 驗證導致仍失敗，
 *    請改用 README 內提供的 Puppeteer 版 fetch（已附說明）。
 *
 *    另外，列表頁的 HTML 結構若日後改版，請調整 parseEvents() 內的選擇器。
 */

const LIST_URL = process.env.TIX_LIST_URL || 'https://tixcraft.com/activity';
const HOME_URL = 'https://tixcraft.com/';

// 台灣地名關鍵字（用來判定台灣場次 vs 國外場次）
const TW_HINTS = [
  '台北', '臺北', '台中', '臺中', '台南', '臺南', '高雄', '桃園', '新北', '台灣', '臺灣',
  '小巨蛋', '流行音樂中心', '南港', '林口', '大巨蛋', '世貿', 'Taipei', 'Taiwan',
  'Kaohsiung', 'Taichung', 'Tainan',
];

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
  Accept: 'text/html,application/xhtml+xml',
};

/** 抓取單一 URL 的 HTML（ScraperAPI → got-scraping → axios） */
async function fetchSinglePage(url) {
  const key = process.env.SCRAPER_API_KEY;
  if (key) {
    const premium = process.env.SCRAPER_PREMIUM === '1' ? '&premium=true' : '';
    const api = `https://api.scraperapi.com/?api_key=${key}&country_code=tw${premium}&url=${encodeURIComponent(url)}`;
    const res = await axios.get(api, { timeout: 60000, validateStatus: (s) => s < 600 });
    if (res.status >= 400) throw new Error(`ScraperAPI ${res.status}`);
    return res.data;
  }
  try {
    const { gotScraping } = await import('got-scraping');
    const res = await gotScraping({
      url,
      timeout: { request: 25000 },
      retry: { limit: 1 },
      headerGeneratorOptions: {
        browsers: ['chrome'], devices: ['desktop'],
        locales: ['zh-TW'], operatingSystems: ['windows'],
      },
    });
    if (res.statusCode >= 400) throw new Error('got ' + res.statusCode);
    return res.body;
  } catch (e) {
    const res = await axios.get(url, { headers: BROWSER_HEADERS, timeout: 15000, validateStatus: s => s < 600 });
    if (res.status >= 400) throw new Error('axios ' + res.status);
    return res.data;
  }
}

/**
 * 抓取某站台的首頁 + /activity，回傳解析好的 events [{title, url, source}]
 * @param {string} baseDomain e.g. 'https://tixcraft.com' or 'https://ticketmaster.sg'
 */
async function fetchAndParse(baseDomain) {
  const base = baseDomain.replace(/\/+$/, '');
  const urls = [base + '/', base + '/activity'];
  const pages = await Promise.allSettled(urls.map(fetchSinglePage));
  const htmlParts = pages.filter(p => p.status === 'fulfilled').map(p => p.value);
  if (htmlParts.length === 0) throw new Error(`${base} 抓取失敗`);
  const html = htmlParts.join('\n');
  return parseEvents(html, base);
}

/** 抓取所有站台（台灣 + 海外），回傳 { twEvents, overseasEvents } */
async function fetchAllEvents() {
  const twEvents = [];
  const overseasEvents = [];
  // 台灣
  try {
    const events = await fetchAndParse('https://tixcraft.com');
    events.forEach(e => {
      if (isTaiwan(e.title) || isTaiwan(e.url)) twEvents.push(e);
      else overseasEvents.push(e);
    });
  } catch (e) { console.error('[拓元TW]', e.message); }
  // 海外站台
  const sites = store.data.tix.overseasSites || [];
  for (const site of sites) {
    try {
      const events = await fetchAndParse(site);
      overseasEvents.push(...events);
    } catch (e) { console.error(`[拓元 ${site}]`, e.message); }
  }
  return { twEvents, overseasEvents };
}

/** 向後兼容：舊的 fetchListHtml for diagnose */
async function fetchListHtml() {
  const pages = await Promise.allSettled([
    fetchSinglePage('https://tixcraft.com/'),
    fetchSinglePage('https://tixcraft.com/activity'),
  ]);
  return pages.filter(p => p.status === 'fulfilled').map(p => p.value).join('\n') || '';
}

/** 手動診斷：抓一次並回報結果（給 OWNER 用「測試拓元」呼叫） */
async function diagnose() {
  try {
    const html = await fetchListHtml();
    const events = parseEvents(html);
    // HTML 摘要（幫助除錯）
    const htmlLen = html.length;
    const hasScript = html.includes('<script');
    const detailCount = (html.match(/\/activity\/detail\//g) || []).length;
    const actGameCount = (html.match(/\/activity\/game\//g) || []).length;

    if (events.length === 0) {
      return [
        '⚠️ 抓取成功但解析到 0 筆',
        `📊 HTML 長度：${htmlLen.toLocaleString()} 字`,
        `🔍 含 <script>：${hasScript ? '有' : '無'}`,
        `🔗 /activity/detail/ 出現：${detailCount} 次`,
        `🔗 /activity/game/ 出現：${actGameCount} 次`,
        `📝 前 200 字：\n${html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').substring(0, 200)}…`,
        '',
        '💡 如果出現 0 次，代表拓元頁面內容要靠 JS 才載入，需改用 ScraperAPI（設定 SCRAPER_API_KEY）',
      ].join('\n');
    }
    const sample = events.slice(0, 15).map((e) => '• ' + e.title).join('\n');
    return [
      `✅ 拓元抓取成功！共 ${events.length} 個場次。`,
      sample,
      events.length > 15 ? `…及其他 ${events.length - 15} 個` : '',
      `\n🔑 關鍵字：${store.data.tix.keywords.join('、')}`,
    ].filter(Boolean).join('\n');
  } catch (e) {
    return '❌ 拓元抓取失敗：\n' + e.message;
  }
}

/**
 * 從 HTML 解析出場次清單 [{title, url}]
 * 最簡單穩定的做法：用正則從整段 HTML 掃出所有 /activity/detail/XXX slug，
 * 再嘗試從附近 JSON 抓標題。
 */
function parseEvents(html, baseDomain) {
  const base = (baseDomain || 'https://tixcraft.com').replace(/\/+$/, '');
  const slugs = new Map();
  const re = /\/activity\/detail\/([a-zA-Z0-9_.-]+)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (!slugs.has(m[1])) slugs.set(m[1], null);
  }
  for (const slug of slugs.keys()) {
    const idx = html.indexOf('/activity/detail/' + slug);
    if (idx === -1) continue;
    const ctx = html.substring(Math.max(0, idx - 400), Math.min(html.length, idx + 400));
    const t =
      ctx.match(/"(?:title|name|eventName|act_name)"\s*:\s*"([^"]{3,120})"/i) ||
      ctx.match(/"([^"]{5,120})"\s*,\s*"(?:url|link|href)"/i) ||
      ctx.match(/alt="([^"]{5,120})"/i);
    if (t) slugs.set(slug, t[1].replace(/\\[/\\]/g, '').replace(/\s+/g, ' ').trim());
  }
  const events = [];
  for (const [slug, title] of slugs) {
    events.push({
      title: title || slug.replace(/^\d+[a-z]*_/, '').replace(/_/g, ' '),
      url: `${base}/activity/detail/${slug}`,
      source: base,
    });
  }
  return events;
}

/** 判定是否為台灣場次 */
function isTaiwan(title) {
  return TW_HINTS.some((k) => title.includes(k));
}

/** 是否符合使用者設定的國外關鍵字（檢查標題和 URL） */
function matchKeyword(text) {
  const kws = store.data.tix.keywords || [];
  const lower = (text || '').toLowerCase();
  return kws.find((k) => lower.includes(k.toLowerCase())) || null;
}

// ============== 海外站台管理 ==============

function listOverseasSites() {
  const sites = store.data.tix.overseasSites || [];
  return [
    '🌍 海外站台列表：',
    sites.length ? sites.map(s => `• ${s}`).join('\n') : '（無）',
    '', '➕ 新增：新增海外站 [網址]', '➖ 移除：移除海外站 [網址]',
  ].join('\n');
}

function addOverseasSite(isOwner, args) {
  if (!isOwner) return '⛔ 僅限主管理員。';
  if (!args[0]) return '❌ 格式：新增海外站 https://ticketmaster.sg';
  const url = args[0].replace(/\/+$/, '');
  if (!url.startsWith('http')) return '❌ 請輸入完整網址（https://開頭）';
  if (!store.data.tix.overseasSites) store.data.tix.overseasSites = [];
  if (store.data.tix.overseasSites.includes(url)) return `⚠️ 「${url}」已在列表中。`;
  store.data.tix.overseasSites.push(url);
  store.save();
  return `✅ 已新增海外站：${url}\n\n${listOverseasSites()}`;
}

function removeOverseasSite(isOwner, args) {
  if (!isOwner) return '⛔ 僅限主管理員。';
  if (!args[0]) return '❌ 格式：移除海外站 [網址]';
  const url = args[0].replace(/\/+$/, '');
  const before = (store.data.tix.overseasSites || []).length;
  store.data.tix.overseasSites = (store.data.tix.overseasSites || []).filter(s => s !== url);
  if (store.data.tix.overseasSites.length === before) return `❌ 找不到「${url}」。`;
  store.save();
  return `✅ 已移除：${url}\n\n${listOverseasSites()}`;
}

/**
 * 執行一次偵測，回傳要發送的訊息陣列（可能為空）
 * @param {boolean} silentFirstRun 第一次執行只建立基準、不通知
 */
async function checkOnce(silentFirstRun = false) {
  if (!store.data.tix.enabled) return [];
  let twEvents, overseasEvents;
  try {
    ({ twEvents, overseasEvents } = await fetchAllEvents());
  } catch (e) {
    console.error('[拓元偵測]', e.message);
    return [];
  }
  const allEvents = [...twEvents, ...overseasEvents];
  if (allEvents.length === 0) { console.warn('[拓元偵測] 0 筆'); return []; }

  const seen = new Set(store.data.tix.seen);
  const freshTw = twEvents.filter(e => !seen.has(e.url));
  const freshOverseas = overseasEvents.filter(e => !seen.has(e.url));

  store.data.tix.seen = allEvents.map(e => e.url);
  store.save();

  if (silentFirstRun) {
    console.log(`[拓元] 基準：TW ${twEvents.length} + 海外 ${overseasEvents.length}`);
    return [];
  }
  const messages = [];
  if (freshTw.length > 0) {
    let m = `🔔 拓元偵測到 ${freshTw.length} 個新的【台灣】場次！\n` + '─'.repeat(22) + '\n';
    freshTw.forEach(e => { m += `🎫 ${e.title}\n${e.url}\n`; });
    messages.push(m.trim());
  }
  // 海外：只通知關鍵字命中
  const kwHits = freshOverseas.filter(e => matchKeyword(e.title) || matchKeyword(e.url));
  if (kwHits.length > 0) {
    let m = `🌍 偵測到符合關鍵字的【海外】場次！\n` + '─'.repeat(22) + '\n';
    kwHits.forEach(e => {
      const kw = matchKeyword(e.title) || matchKeyword(e.url);
      m += `🔥【${kw}】${e.title}\n${e.url}\n`;
    });
    messages.push(m.trim());
  }
  return messages;
}

// ====================== 關鍵字管理（僅 OWNER）======================

function listKeywords() {
  const kws = store.data.tix.keywords;
  return [
    '🔑 目前國外場次偵測關鍵字：',
    kws.length ? kws.map((k) => `• ${k}`).join('\n') : '（無）',
    '',
    '➕ 新增：新增關鍵字 [字]',
    '➖ 移除：移除關鍵字 [字]',
    `🔌 偵測狀態：${store.data.tix.enabled ? '🟢 開啟' : '🔴 關閉'}`,
  ].join('\n');
}

function addKeyword(isOwner, args) {
  if (!isOwner) return '⛔ 關鍵字只有主管理員可以更改。';
  if (!args[0]) return '❌ 格式：新增關鍵字 [字]';
  const kw = args.join(' ').trim();
  if (store.data.tix.keywords.some((k) => k.toLowerCase() === kw.toLowerCase())) {
    return `⚠️ 關鍵字「${kw}」已存在。`;
  }
  store.data.tix.keywords.push(kw);
  store.save();
  return `✅ 已新增關鍵字：${kw}\n\n${listKeywords()}`;
}

function removeKeyword(isOwner, args) {
  if (!isOwner) return '⛔ 關鍵字只有主管理員可以更改。';
  if (!args[0]) return '❌ 格式：移除關鍵字 [字]';
  const kw = args.join(' ').trim();
  const before = store.data.tix.keywords.length;
  store.data.tix.keywords = store.data.tix.keywords.filter(
    (k) => k.toLowerCase() !== kw.toLowerCase()
  );
  if (store.data.tix.keywords.length === before) return `❌ 找不到關鍵字「${kw}」。`;
  store.save();
  return `✅ 已移除關鍵字：${kw}\n\n${listKeywords()}`;
}

function toggleMonitor(isOwner, on) {
  if (!isOwner) return '⛔ 只有主管理員可以開關偵測。';
  store.data.tix.enabled = on;
  store.save();
  return on ? '🟢 已開啟拓元新場次偵測。' : '🔴 已關閉拓元新場次偵測。';
}

/** 重設偵測：清除已知清單，下次偵測會把所有場次當新的通知 */
function resetSeen(isOwner) {
  if (!isOwner) return '⛔ 僅限主管理員。';
  const count = store.data.tix.seen.length;
  store.data.tix.seen = [];
  store.save();
  return `✅ 已清除 ${count} 筆已知場次紀錄。\n下次偵測會重新通知所有場次（含 BTS 等先前已存在的）。`;
}

/** 搜尋拓元：從目前已知場次中搜尋關鍵字 */
async function searchEvents(isOwner, args) {
  if (!isOwner) return '⛔ 僅限主管理員。';
  if (!args[0]) return '❌ 格式：搜尋拓元 [關鍵字]';
  const kw = args.join(' ').toLowerCase();
  try {
    const html = await fetchListHtml();
    const events = parseEvents(html);
    const hits = events.filter(e => e.title.toLowerCase().includes(kw) || e.url.toLowerCase().includes(kw));
    if (hits.length === 0) return `🔍 在 ${events.length} 個場次中找不到「${args.join(' ')}」。`;
    let msg = `🔍 搜尋「${args.join(' ')}」找到 ${hits.length} 筆：\n`;
    hits.forEach(e => { msg += `• ${e.title}\n  ${e.url}\n`; });
    return msg.trim();
  } catch (e) {
    return '❌ 搜尋失敗：' + e.message;
  }
}

module.exports = {
  checkOnce, diagnose, searchEvents, resetSeen,
  listKeywords, addKeyword, removeKeyword, toggleMonitor,
  listOverseasSites, addOverseasSite, removeOverseasSite,
};
