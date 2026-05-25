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

/**
 * 抓取列表頁 HTML，依序嘗試：
 *  1) 若有設定 SCRAPER_API_KEY → 走 ScraperAPI 代抓（最穩，能過 Cloudflare）
 *  2) got-scraping（輕量、免費、模擬瀏覽器指紋，多數擋標頭型 403 可過）
 *  3) 一般 axios（最後手段）
 */
async function fetchListHtml() {
  // 方法 1：ScraperAPI（選用）
  const key = process.env.SCRAPER_API_KEY;
  if (key) {
    const premium = process.env.SCRAPER_PREMIUM === '1' ? '&premium=true' : '';
    const api = `https://api.scraperapi.com/?api_key=${key}&country_code=tw${premium}&url=${encodeURIComponent(LIST_URL)}`;
    const res = await axios.get(api, { timeout: 60000, validateStatus: (s) => s < 600 });
    if (res.status >= 400) throw new Error(`ScraperAPI 回傳 ${res.status}（可能需要設 SCRAPER_PREMIUM=1）`);
    return res.data;
  }

  // 方法 2：got-scraping
  try {
    const { gotScraping } = await import('got-scraping');
    const res = await gotScraping({
      url: LIST_URL,
      timeout: { request: 25000 },
      retry: { limit: 1 },
      headerGeneratorOptions: {
        browsers: ['chrome'],
        devices: ['desktop'],
        locales: ['zh-TW'],
        operatingSystems: ['windows'],
      },
    });
    if (res.statusCode === 403) throw new Error('got-scraping 仍被回 403');
    if (res.statusCode >= 400) throw new Error('got-scraping 回傳 ' + res.statusCode);
    return res.body;
  } catch (e) {
    // 方法 3：退回一般 axios
    try {
      const res = await axios.get(LIST_URL, {
        headers: BROWSER_HEADERS,
        timeout: 15000,
        validateStatus: (s) => s < 600,
      });
      if (res.status === 403) {
        throw new Error('403：拓元擋下存取（可能是 Cloudflare）。請到 Render 設定 SCRAPER_API_KEY，見 README。');
      }
      if (res.status >= 400) throw new Error('axios 回傳 ' + res.status);
      return res.data;
    } catch (e2) {
      throw new Error(e.message + ' / ' + e2.message);
    }
  }
}

/** 手動診斷：抓一次並回報結果（給 OWNER 用「測試拓元」呼叫） */
async function diagnose() {
  try {
    const html = await fetchListHtml();
    const events = parseEvents(html);
    if (events.length === 0) {
      return '⚠️ 抓取成功，但解析到 0 筆。\n可能是拓元 HTML 改版，需調整 parseEvents() 的選擇器。';
    }
    const sample = events.slice(0, 5).map((e) => '• ' + e.title).join('\n');
    return [
      `✅ 拓元抓取成功！共解析到 ${events.length} 個場次。`,
      '範例：',
      sample,
      '',
      `🔑 偵測關鍵字：${store.data.tix.keywords.join('、')}`,
      '📌 之後系統會自動比對新場次並通知。',
    ].join('\n');
  } catch (e) {
    return '❌ 拓元抓取失敗：\n' + e.message;
  }
}

/** 從 HTML 解析出場次清單 [{title, url, text}] */
function parseEvents(html) {
  const $ = cheerio.load(html);
  const events = [];
  const seenHere = new Set();

  // 拓元活動連結通常含 /activity/detail/
  $('a[href*="/activity/detail/"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const url = href.startsWith('http') ? href : `https://tixcraft.com${href}`;
    if (seenHere.has(url)) return;
    seenHere.add(url);

    // 標題：優先用連結文字 / title 屬性 / 內部標題元素
    const title =
      ($(el).attr('title') || $(el).text() || $(el).find('h3,h2,.content,.name').first().text() || '')
        .replace(/\s+/g, ' ')
        .trim();

    if (title) events.push({ title, url });
  });

  return events;
}

/** 判定是否為台灣場次 */
function isTaiwan(title) {
  return TW_HINTS.some((k) => title.includes(k));
}

/** 是否符合使用者設定的國外關鍵字 */
function matchKeyword(title) {
  const kws = store.data.tix.keywords || [];
  const lower = title.toLowerCase();
  const hit = kws.find((k) => lower.includes(k.toLowerCase()));
  return hit || null;
}

/**
 * 執行一次偵測，回傳要發送的訊息陣列（可能為空）
 * @param {boolean} silentFirstRun 第一次執行只建立基準、不通知
 */
async function checkOnce(silentFirstRun = false) {
  if (!store.data.tix.enabled) return [];

  let html;
  try {
    html = await fetchListHtml();
  } catch (e) {
    console.error('[拓元偵測] 抓取失敗：', e.message);
    return [];
  }

  const events = parseEvents(html);
  if (events.length === 0) {
    console.warn('[拓元偵測] 解析到 0 筆，可能是 HTML 結構改版，請檢查選擇器。');
    return [];
  }

  const seen = new Set(store.data.tix.seen);
  const fresh = events.filter((e) => !seen.has(e.url));

  // 更新已知清單
  store.data.tix.seen = events.map((e) => e.url);
  store.save();

  if (silentFirstRun) {
    console.log(`[拓元偵測] 首次建立基準：${events.length} 筆，不發通知。`);
    return [];
  }
  if (fresh.length === 0) return [];

  const messages = [];
  const twNew = [];
  const overseasNew = [];

  for (const e of fresh) {
    if (isTaiwan(e.title)) {
      twNew.push(e);
    } else {
      const kw = matchKeyword(e.title);
      if (kw) overseasNew.push({ ...e, kw });
    }
  }

  if (twNew.length > 0) {
    let m = `🔔 拓元偵測到 ${twNew.length} 個新的【台灣】場次！\n` + '─'.repeat(22) + '\n';
    twNew.forEach((e) => {
      m += `🎫 ${e.title}\n${e.url}\n`;
    });
    messages.push(m.trim());
  }

  if (overseasNew.length > 0) {
    let m = `🌍 拓元偵測到符合關鍵字的【國外】場次！\n` + '─'.repeat(22) + '\n';
    overseasNew.forEach((e) => {
      m += `🔥【${e.kw}】${e.title}\n${e.url}\n`;
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

module.exports = {
  checkOnce,
  diagnose,
  listKeywords,
  addKeyword,
  removeKeyword,
  toggleMonitor,
};
