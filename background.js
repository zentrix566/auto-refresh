'use strict';

const ALARM_PREFIX = 'keep-alive:';
// 旧版单一定时器名，升级后顺手清理
const LEGACY_ALARM = 'keep-alive-tick';
const STORE_KEY = 'data';

// Chrome 的 alarms 周期以分钟为单位，最小 1 分钟
const MIN_INTERVAL = 1;
const MAX_INTERVAL = 1440;
const DEFAULT_INTERVAL = 5;
const MAX_LOGS = 50;
// 同一域名两次「会话失效」通知的最小间隔，避免每次刷新都弹
const NOTIFY_THROTTLE = 30 * 60 * 1000;
// 时段外跳过的提示最多每小时记一条，防止刷屏
const OUTSIDE_LOG_THROTTLE = 60 * 60 * 1000;

// storage.local 里只存这一份：配置 + 运行计数 + 日志
const DEFAULT_DATA = {
  enabled: false,
  // 每个域名一条配置：host 域名（子域名自动包含），minutes 该域名的刷新间隔
  // 默认域名为空，首次使用时在弹窗里自行添加
  hostItems: [],
  // 静默刷新：向页面注入隐藏 iframe 续会话，页面不闪烁、不丢表单
  silent: false,
  // 随机抖动：间隔在设定值上 ±20% 浮动，请求模式更像人工；关闭则按设定时间精确刷新
  jitter: false,
  // 限定保活时段，时段外到点只跳过不刷新
  limitHours: false,
  activeFrom: '08:00',
  activeTo: '23:00',
  // 各域名最近一次看到的页面地址，打开保活标签页时优先用
  lastUrls: {},
  // 每个域名上次发会话失效通知的时间，用来节流
  notifyState: {},
  lastOutsideLogAt: 0,
  lastRunAt: 0,
  runCount: 0,
  logs: []
};

// Service Worker 随时可能被杀掉重启，内存只当缓存用。
// 每个入口（alarm / 消息 / 启动）都先从 storage 重新读取，
// 否则 worker 刚被唤醒时会拿着没恢复完的默认配置执行，导致刷新被静默跳过。
let data = { ...DEFAULT_DATA };

async function reload() {
  const stored = await chrome.storage.local.get(STORE_KEY);
  data = migrate({ ...DEFAULT_DATA, ...(stored[STORE_KEY] || {}) });
  return data;
}

/** 旧版数据（hosts 字符串 + 全局间隔）升级成每域名一条配置 */
function migrate(raw) {
  const d = { ...raw };
  if (typeof d.hosts === 'string') {
    const minutes = clampInterval(d.intervalMinutes);
    d.hostItems = parseHosts(d.hosts).map((host) => ({ host, minutes }));
  }
  delete d.hosts;
  delete d.intervalMinutes;
  d.hostItems = sanitizeHostItems(d.hostItems);
  if (!d.lastUrls || typeof d.lastUrls !== 'object') d.lastUrls = {};
  if (!d.notifyState || typeof d.notifyState !== 'object') d.notifyState = {};
  return d;
}

function sanitizeHostItems(items) {
  const seen = new Set();
  const result = [];
  (Array.isArray(items) ? items : []).forEach((item) => {
    const host = normalizePattern(item && item.host);
    if (!host || seen.has(host)) return;
    seen.add(host);
    result.push({ host, minutes: clampInterval(item && item.minutes) });
  });
  return result;
}

async function persist(patch) {
  data = { ...data, ...patch };
  await chrome.storage.local.set({ [STORE_KEY]: data });
  await broadcast();
}

function nowText() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

async function log(text, level = 'info') {
  const logs = [...data.logs, { time: nowText(), text, level }];
  if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
  await persist({ logs });
}

/** 弹窗渲染用的完整状态，下次执行时间取所有域名 alarm 里最近的一个 */
async function snapshot() {
  let nextRunAt = 0;
  if (data.enabled && data.hostItems.length) {
    const alarms = await Promise.all(data.hostItems.map((item) => chrome.alarms.get(alarmNameFor(item.host))));
    const times = alarms.filter(Boolean).map((alarm) => alarm.scheduledTime);
    nextRunAt = times.length ? Math.min(...times) : 0;
  }
  return { ...data, nextRunAt };
}

async function broadcast() {
  const state = await snapshot();
  chrome.runtime.sendMessage({ type: 'state', state }).catch(() => {});
}

function clampInterval(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return DEFAULT_INTERVAL;
  return Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, Math.round(num)));
}

/** 容错归一化：粘贴完整 URL 或带端口的地址也能提取出域名 */
function normalizePattern(raw) {
  const text = String(raw || '').trim().toLowerCase();
  if (!text) return '';
  try {
    return new URL(text.includes('://') ? text : `http://${text}`).hostname;
  } catch (e) {
    return text;
  }
}

function parseHosts(text) {
  return String(text || '')
    .split(/[\s,;]+/)
    .map(normalizePattern)
    .filter(Boolean);
}

function hostMatches(hostname, pattern) {
  const host = String(hostname || '').toLowerCase();
  if (!host || !pattern) return false;
  return host === pattern || host.endsWith(`.${pattern}`);
}

async function findMatchedTabs(hosts) {
  const tabs = await chrome.tabs.query({});
  return tabs.filter((tab) => {
    if (!tab.id || tab.id === chrome.tabs.TAB_ID_NONE) return false;
    let url;
    try {
      url = new URL(tab.url || '');
    } catch (e) {
      return false;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return hosts.some((pattern) => hostMatches(url.hostname, pattern));
  });
}

function findHostItem(items, url) {
  return items.find((item) => {
    try {
      return hostMatches(new URL(url || '').hostname, item.host);
    } catch (e) {
      return false;
    }
  });
}

function tabLabel(tab) {
  const title = (tab.title || '').trim();
  return title ? title.slice(0, 24) : tab.url;
}

/** 页面停在登录地址时提醒一下，方便发现保活其实没顶住 */
function looksLoggedOut(url) {
  try {
    const parsed = new URL(url);
    return /login|logout|signin|sign-in|cas\//i.test(parsed.pathname + parsed.search);
  } catch (e) {
    return false;
  }
}

/** 会话失效的桌面通知按域名节流，别每次刷新都弹一遍 */
async function notifyLoggedOut(host, tab) {
  const last = data.notifyState[host] || 0;
  if (Date.now() - last < NOTIFY_THROTTLE) return;
  data.notifyState = { ...data.notifyState, [host]: Date.now() };
  await persist({ notifyState: data.notifyState });
  try {
    const result = chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: '页面保活助手',
      message: `「${tabLabel(tab)}」停在登录页，${host} 的会话可能已经失效，请重新登录`
    });
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch (e) {
    // 通知失败不影响保活本身，日志里已经有记录
  }
}

/** 在页面里执行：重建一个隐藏 iframe 重新加载当前地址，服务器收到带会话的完整请求，可见页面不动 */
function injectKeepAliveFrame() {
  if (window !== window.top) return { ok: false };
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return { ok: false };
  const id = '__keep-alive-frame__';
  const old = document.getElementById(id);
  if (old) old.remove();
  const frame = document.createElement('iframe');
  frame.id = id;
  frame.src = location.href;
  frame.title = 'keep-alive';
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  frame.style.cssText =
    'position:fixed;left:0;top:0;width:0;height:0;border:0;visibility:hidden;pointer-events:none;z-index:-2147483647;';
  (document.body || document.documentElement).appendChild(frame);
  return { ok: true };
}

/** 刷新单个标签页：开启静默时优先注入隐藏 iframe，被丢弃的页或注入失败时回退普通刷新 */
async function refreshTab(tab) {
  let url;
  try {
    url = new URL(tab.url || '');
  } catch (e) {
    url = null;
  }
  if (data.silent && !tab.discarded && url) {
    try {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: injectKeepAliveFrame
      });
      if (result && result.result && result.result.ok) return 'silent';
    } catch (e) {
      // 页面限制或标签页状态不允许注入，落到下面的普通刷新
    }
  }
  await chrome.tabs.reload(tab.id);
  return 'reload';
}

/** 下一轮间隔：开启随机抖动时在配置值上 ±20% 浮动，请求模式不至于太机械 */
function jitteredMinutes(minutes) {
  const base = clampInterval(minutes);
  if (!data.jitter) return base;
  return Math.max(MIN_INTERVAL, base * (0.8 + Math.random() * 0.4));
}

function alarmNameFor(host) {
  return ALARM_PREFIX + host;
}

function hostFromAlarm(name) {
  return typeof name === 'string' && name.startsWith(ALARM_PREFIX) ? name.slice(ALARM_PREFIX.length) : null;
}

function withinActiveHours() {
  if (!data.limitHours) return true;
  const parse = (text) => {
    const [h, m] = String(text || '').split(':').map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return NaN;
    return h * 60 + m;
  };
  const from = parse(data.activeFrom);
  const to = parse(data.activeTo);
  if (Number.isNaN(from) || Number.isNaN(to)) return true;
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  // 支持跨午夜时段（如 22:00–06:00）
  return from <= to ? cur >= from && cur < to : cur >= from || cur < to;
}

/** 刷新域名下的所有标签页；hostFilter 限定只处理某一个域名（定时触发时用） */
async function runTick(reason, hostFilter) {
  const items = hostFilter ? data.hostItems.filter((item) => item.host === hostFilter) : data.hostItems;
  const hosts = items.map((item) => item.host);
  if (!hosts.length) {
    await log('生效域名为空，本次未刷新', 'warn');
    return;
  }

  const tabs = await findMatchedTabs(hosts);
  if (!tabs.length) {
    await log(`没有找到 ${hosts.join(' / ')} 的打开页面，本次未刷新`, 'warn');
    return;
  }

  let silentCount = 0;
  let reloaded = 0;
  let loading = 0;
  const lastUrls = { ...data.lastUrls };
  for (const tab of tabs) {
    if (tab.status === 'loading') {
      loading += 1;
      continue;
    }
    const item = findHostItem(items, tab.url);
    if (item) lastUrls[item.host] = tab.url;
    if (looksLoggedOut(tab.url)) {
      await log(`「${tabLabel(tab)}」停在登录页，会话可能已经失效`, 'warn');
      if (item) await notifyLoggedOut(item.host, tab);
    }
    if ((await refreshTab(tab)) === 'silent') {
      silentCount += 1;
    } else {
      reloaded += 1;
    }
  }

  await persist({ lastRunAt: Date.now(), runCount: data.runCount + 1, lastUrls });

  const skipped = loading ? `，${loading} 个正在加载已跳过` : '';
  const detail = data.silent ? `静默保活 ${silentCount} 个，普通刷新 ${reloaded} 个` : `刷新 ${reloaded} 个`;
  await log(
    `${reason}刷新完成：${hosts.join(' / ')} 匹配 ${tabs.length} 个页面，${detail}${skipped}`,
    silentCount + reloaded ? 'success' : 'warn'
  );
}

async function scheduleHost(item) {
  await chrome.alarms.create(alarmNameFor(item.host), { delayInMinutes: jitteredMinutes(item.minutes) });
}

/** 清掉不需要的 alarm（含旧版单一定时器），补建缺失的；reschedule=true 时全部重建以应用最新间隔 */
async function applyAlarms(reschedule = false) {
  const wantedSet = new Set(data.enabled ? data.hostItems.map((item) => alarmNameFor(item.host)) : []);
  const all = await chrome.alarms.getAll();
  await Promise.all(
    all
      .filter((alarm) => alarm.name === LEGACY_ALARM || !wantedSet.has(alarm.name))
      .map((alarm) => chrome.alarms.clear(alarm.name))
  );
  for (const item of data.hostItems) {
    if (!data.enabled) break;
    const name = alarmNameFor(item.host);
    const existing = reschedule ? null : await chrome.alarms.get(name);
    if (!existing) await scheduleHost(item);
  }
  await updateBadge();
  await broadcast();
}

async function updateBadge() {
  await chrome.action.setBadgeText({ text: data.enabled ? 'ON' : '' });
  if (data.enabled) {
    await chrome.action.setBadgeBackgroundColor({ color: '#16a34a' });
  }
}

async function setEnabled(enabled) {
  await persist({ enabled: Boolean(enabled) });
  await applyAlarms(true);
  await log(
    data.enabled
      ? `保活已启动：${data.hostItems.map((item) => `${item.host} 每 ${item.minutes} 分钟`).join('，')}`
      : '保活已停止'
  );
}

async function setConfig(patch) {
  await persist({
    hostItems: Array.isArray(patch.hostItems) ? sanitizeHostItems(patch.hostItems) : data.hostItems,
    silent: patch.silent !== undefined ? Boolean(patch.silent) : data.silent,
    jitter: patch.jitter !== undefined ? Boolean(patch.jitter) : data.jitter,
    limitHours: patch.limitHours !== undefined ? Boolean(patch.limitHours) : data.limitHours,
    activeFrom: patch.activeFrom !== undefined ? String(patch.activeFrom || '') : data.activeFrom,
    activeTo: patch.activeTo !== undefined ? String(patch.activeTo || '') : data.activeTo
  });
  await applyAlarms(true);
}

/** 给没有打开页面的域名补一个固定的后台保活标签页 */
async function openKeepAliveTabs() {
  const tabs = await chrome.tabs.query({});
  let opened = 0;
  for (const item of data.hostItems) {
    if (tabs.some((tab) => findHostItem([item], tab.url))) continue;
    await chrome.tabs.create({
      url: data.lastUrls[item.host] || `https://${item.host}/`,
      active: false,
      pinned: true
    });
    opened += 1;
  }
  await log(`保活标签页已就绪：新建 ${opened} 个，已有页面的域名跳过`);
}

async function restore() {
  await reload();
  await applyAlarms(false);
}

chrome.runtime.onInstalled.addListener(restore);
chrome.runtime.onStartup.addListener(restore);
restore();

chrome.alarms.onAlarm.addListener((alarm) => {
  const host = hostFromAlarm(alarm.name);
  if (!host) return;
  (async () => {
    await reload();
    if (!data.enabled) return;
    const item = data.hostItems.find((entry) => entry.host === host);
    if (!item) return;
    try {
      if (withinActiveHours()) {
        await runTick('定时', host);
      } else if (Date.now() - (data.lastOutsideLogAt || 0) > OUTSIDE_LOG_THROTTLE) {
        await persist({ lastOutsideLogAt: Date.now() });
        await log(`当前不在保活时段（${data.activeFrom}–${data.activeTo}），跳过 ${host} 本次刷新`);
      }
    } finally {
      // 无论本次是否执行都要排下一轮，链路不能断
      await scheduleHost(item);
    }
  })();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;

  // 每个分支都必须应答，否则弹窗侧的消息通道会以报错收场
  if (msg.type === 'getState') {
    reload()
      .then(() => snapshot())
      .then((state) => sendResponse({ state }))
      .catch(() => sendResponse({ state: null }));
    return true;
  }

  if (msg.type === 'setEnabled') {
    reload()
      .then(() => setEnabled(msg.enabled))
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg.type === 'setConfig') {
    reload()
      .then(() => setConfig(msg.config || {}))
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg.type === 'openKeepAliveTabs') {
    reload()
      .then(() => openKeepAliveTabs())
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg.type === 'resetCount') {
    reload()
      .then(() => persist({ runCount: 0 }))
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg.type === 'runNow') {
    (async () => {
      try {
        await reload();
        await runTick('手动');
        await applyAlarms(false);
        sendResponse({ state: await snapshot() });
      } catch (e) {
        sendResponse({ state: null });
      }
    })();
    return true;
  }

  if (msg.type === 'clearLogs') {
    reload()
      .then(() => persist({ logs: [] }))
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  return false;
});
