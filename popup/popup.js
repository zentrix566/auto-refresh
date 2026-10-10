'use strict';

const el = (id) => document.getElementById(id);
const DEFAULT_MINUTES = 5;
let currentState = null;
let formReady = false;
// 生效域名配置的内存态，增删改都在这里改完再整体保存
let hostItems = [];

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return map[ch];
  });
}

function formatClock(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
}

function formatCountdown(ms) {
  if (!ms || ms <= 0) return '即将执行';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 容错归一化：粘贴完整 URL 或带端口的地址也能提取出域名 */
function toHostname(text) {
  const raw = String(text || '').trim().toLowerCase();
  if (!raw) return '';
  try {
    return new URL(raw.includes('://') ? raw : `http://${raw}`).hostname;
  } catch (e) {
    return raw;
  }
}

function addHost(rawHost) {
  const host = toHostname(rawHost);
  if (!host || hostItems.some((item) => item.host === host)) return false;
  hostItems.push({ host, minutes: DEFAULT_MINUTES });
  return true;
}

function removeHost(host) {
  hostItems = hostItems.filter((item) => item.host !== host);
  saveHosts();
}

/** 每个域名渲染一行：域名 + 独立间隔 + 删除；全部用 DOM API，域名走 textContent 不拼 HTML */
function renderRows() {
  const box = el('hostRows');
  box.innerHTML = '';
  hostItems.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'host-row';

    const name = document.createElement('span');
    name.className = 'host-name';
    name.textContent = item.host;
    name.title = item.host;

    const minLabel = document.createElement('label');
    minLabel.className = 'host-min';
    minLabel.append('每');
    const minInput = document.createElement('input');
    minInput.type = 'number';
    minInput.min = '1';
    minInput.max = '1440';
    minInput.value = item.minutes;
    minInput.addEventListener('change', () => {
      item.minutes = Number(minInput.value) || DEFAULT_MINUTES;
      sendConfig();
    });
    minLabel.append(minInput, '分钟');

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'host-del';
    del.textContent = '×';
    del.title = '移除';
    del.addEventListener('click', () => removeHost(item.host));

    row.append(name, minLabel, del);
    box.appendChild(row);
  });
}

function saveHosts() {
  renderRows();
  sendConfig();
}

/** 把输入框里的内容按分隔符拆开逐个入列，空格/逗号/分号都算分隔 */
function commitHostInput() {
  const parts = el('hostInput').value.split(/[\s,;，；]+/).filter(Boolean);
  el('hostInput').value = '';
  let changed = false;
  parts.forEach((part) => {
    if (addHost(part)) changed = true;
  });
  if (changed) saveHosts();
}

function syncTimeInputs() {
  const disabled = !el('limitHours').checked;
  el('activeFrom').disabled = disabled;
  el('activeTo').disabled = disabled;
}

function renderLogs(logs) {
  const box = el('logs');
  box.innerHTML = logs
    .map((item) => `<div class="${item.level}"><span class="time">${item.time}</span>${escapeHtml(item.text)}</div>`)
    .join('');
  box.scrollTop = box.scrollHeight;
}

function updateCountdown(state) {
  el('statNext').textContent = state.enabled
    ? (state.nextRunAt ? formatCountdown(state.nextRunAt - Date.now()) : '—')
    : '—';
}

function render(state) {
  currentState = state;
  const enabled = Boolean(state.enabled);

  const badge = el('phase');
  badge.textContent = enabled ? '运行中' : '未启用';
  badge.className = `badge ${enabled ? 'done' : ''}`;

  const toggle = el('btnToggle');
  toggle.textContent = enabled ? '停止保活' : '启用保活';
  toggle.className = enabled ? 'danger' : 'primary';

  el('statState').textContent = enabled ? '运行中' : '未启用';
  el('statLast').textContent = formatClock(state.lastRunAt);
  el('statCount').textContent = String(state.runCount || 0);
  updateCountdown(state);

  if (!formReady) {
    hostItems = (Array.isArray(state.hostItems) ? state.hostItems : []).map((item) => ({
      host: String(item.host || ''),
      minutes: Number(item.minutes) || DEFAULT_MINUTES
    }));
    el('silent').checked = Boolean(state.silent);
    el('jitter').checked = Boolean(state.jitter);
    el('limitHours').checked = Boolean(state.limitHours);
    el('activeFrom').value = state.activeFrom || '08:00';
    el('activeTo').value = state.activeTo || '23:00';
    syncTimeInputs();
    formReady = true;
    renderRows();
  }

  renderLogs(state.logs || []);
}

async function getState() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'getState' });
    if (res && res.state) render(res.state);
  } catch (e) {
    // 状态读不到（如扩展刚重载完）就保持当前界面，操作仍然可用
  }
}

async function sendConfig() {
  try {
    await chrome.runtime.sendMessage({
      type: 'setConfig',
      config: {
      hostItems,
      silent: el('silent').checked,
      jitter: el('jitter').checked,
      limitHours: el('limitHours').checked,
        activeFrom: el('activeFrom').value,
        activeTo: el('activeTo').value
      }
    });
  } catch (e) {
    // 送达失败时保持界面现状，下次打开弹窗以存储里的状态为准
  }
}

/** 把当前标签页的域名追加进生效域名列表；静默授权由黄色横条的「立即授权」按钮单独完成 */
async function useCurrentHost() {
  let host = '';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    host = toHostname(tab.url || '');
  } catch (e) {
    host = '';
  }
  if (!host) {
    alert('当前标签页不是普通网页，取不到域名');
    return;
  }
  if (!addHost(host)) {
    alert(`${host} 已在生效域名里`);
    return;
  }
  saveHosts();
}

/** 所有交互绑定集中在这里；先绑定再取状态，状态读不到也不能让按钮失灵 */
function bindEvents() {
  el('hostInput').addEventListener('keydown', (e) => {
    // 输入法组合期间的按键（确认候选词等）不参与添加
    if (e.isComposing) return;
    // 空输入框按退格 = 删掉最后一个域名
    if (e.key === 'Backspace' && !el('hostInput').value && hostItems.length) {
      hostItems.pop();
      saveHosts();
      return;
    }
    if (e.key === 'Enter' || e.key === ',' || e.key === '，' || e.key === ';' || e.key === '；') {
      e.preventDefault();
      commitHostInput();
    }
  });

  el('hostInput').addEventListener('blur', commitHostInput);

  el('silent').addEventListener('change', sendConfig);

  el('limitHours').addEventListener('change', async () => {
    syncTimeInputs();
    await sendConfig();
  });

  el('jitter').addEventListener('change', sendConfig);

  ['activeFrom', 'activeTo'].forEach((id) => {
    el(id).addEventListener('change', sendConfig);
  });

  el('btnUseCurrent').addEventListener('click', useCurrentHost);

  el('btnToggle').addEventListener('click', async () => {
    const enable = !(currentState && currentState.enabled);
    if (enable && !hostItems.length) {
      alert('请先添加生效域名，或点「当前页域名」自动填入');
      return;
    }
    await chrome.runtime.sendMessage({ type: 'setEnabled', enabled: enable }).catch(() => {});
    await getState();
  });

  el('btnRunNow').addEventListener('click', async () => {
    el('btnRunNow').disabled = true;
    try {
      const res = await chrome.runtime.sendMessage({ type: 'runNow' }).catch(() => null);
      if (res && res.state) render(res.state);
    } finally {
      el('btnRunNow').disabled = false;
    }
  });

  el('btnOpenTabs').addEventListener('click', async () => {
    if (!hostItems.length) {
      alert('请先添加生效域名，或点「当前页域名」自动填入');
      return;
    }
    el('btnOpenTabs').disabled = true;
    try {
      await chrome.runtime.sendMessage({ type: 'openKeepAliveTabs' }).catch(() => {});
      await getState();
    } finally {
      el('btnOpenTabs').disabled = false;
    }
  });

  el('btnResetCount').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'resetCount' }).catch(() => {});
    await getState();
  });

  el('btnClearLogs').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'clearLogs' }).catch(() => {});
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'state') render(msg.state);
  });

  setInterval(() => {
    if (currentState) updateCountdown(currentState);
  }, 1000);
}

async function init() {
  // 标题旁显示当前版本，方便确认弹窗跑的是不是最新文件
  el('ver').textContent = `v${chrome.runtime.getManifest().version}`;
  bindEvents();
  await getState();
}

init();
