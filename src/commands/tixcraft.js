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
 * 抓取首頁 + /activity 兩頁，合併 HTML 後回傳。
 * 首頁常有 SSR 的活動連結；/activity 可能有 JS 內嵌 JSON。
 */
async function fetchListHtml() {
  const pages = await Promise.allSettled([
    fetchSinglePage(HOME_URL),
    fetchSinglePage(LIST_URL),
  ]);
  const htmlParts = pages
    .filter((p) => p.status === 'fulfilled')
    .map((p) => p.value);
  if (htmlParts.length === 0) {
    const errs = pages.map((p) => p.reason?.message).join(' / ');
    throw new Error('首頁 + /activity 都抓取失敗：' + errs);
  }
  return htmlParts.join('\n<!-- PAGE_BREAK -->\n');
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

/**
 * 從 HTML 解析出場次清單 [{title, url}]
 * 多重策略：
 *  1) 標準 <a> 標籤（SSR 頁面）
 *  2) 正則掃描整段 HTML（抓 script 裡的 JSON 資料）
 *  3) JSON-LD 結構化資料
 */
function parseEvents(html) {
  const $ = cheerio.load(html);
  const seen = new Set();
  const events = [];

  function add(url, title) {
    const norm = url.replace(/^https?:\/\/[^/]+/, '');
    if (seen.has(norm)) return;
    seen.add(norm);
    const full = url.startsWith('http') ? url : `https://tixcraft.com${url}`;
    const clean = (title || '').replace(/\s+/g, ' ').trim();
    if (clean) events.push({ title: clean, url: full });
  }

  // 策略 1：標準 <a> 標籤
  $('a[href*="/activity/detail/"]').each((_, el) => {
    add($(el).attr('href') || '', $(el).attr('title') || $(el).text());
  });
  // 也抓 /activity/game/ 連結（拓元另一種格式）
  $('a[href*="/activity/game/"]').each((_, el) => {
    add($(el).attr('href') || '', $(el).attr('title') || $(el).text());
  });
  // 也抓首頁常見的 activity 連結（/activity/XXX 不含子路徑）
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (/^\/activity\/[^/]+$/.test(href) && !href.includes('.')) {
      add(href, $(el).attr('title') || $(el).text());
    }
  });

  // 策略 2：正則掃描整段 HTML（抓藏在 script / JSON 裡的 URL + 標題）
  // 找所有 /activity/detail/XXX 或 /activity/game/XXX
  const urlRe = /(?:https?:\/\/tixcraft\.com)?\/activity\/(?:detail|game)\/([a-zA-Z0-9_%-]+)/g;
  let m;
  while ((m = urlRe.exec(html)) !== null) {
    const url = m[0].startsWith('http') ? m[0] : `https://tixcraft.com${m[0]}`;
    // 試從附近內容抓標題（在 URL 前後 200 字內找有意義文字）
    const pos = m.index;
    const ctx = html.substring(Math.max(0, pos - 200), Math.min(html.length, pos + 300));
    // 找引號包起來的標題
    const titleMatch = ctx.match(/"(?:title|name|eventName)"\s*[:=]\s*"([^"]{3,80})"/i)
      || ctx.match(/>([^<]{5,80})</);
    const title = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : m[1].replace(/_/g, ' ');
    add(url, title);
  }

  // 策略 3：JSON-LD
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).html());
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (item.url && /tixcraft/.test(item.url)) {
          add(item.url, item.name || item.headline || '');
        }
      }
    } catch (_) {}
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
