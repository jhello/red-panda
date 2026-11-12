(() => {
  'use strict';

  const TOKEN_KEY = 'red-panda.adminToken';
  let token = sessionStorage.getItem(TOKEN_KEY) || '';
  let timer = null;
  let hasData = false;

  const $ = (id) => document.getElementById(id);

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => {
      switch (char) {
        case '&':
          return '&amp;';
        case '<':
          return '&lt;';
        case '>':
          return '&gt;';
        case '"':
          return '&quot;';
        case "'":
          return '&#39;';
        default:
          return char;
      }
    });
  }

  function fmtTime(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleTimeString('zh-CN', { hour12: false });
  }

  function fmtDateTime(iso) {
    if (!iso) return '—';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }

  function humanUptime(seconds) {
    const value = Math.max(0, Math.floor(seconds));
    if (value < 60) return `${value} 秒`;
    const minutes = Math.floor(value / 60);
    if (minutes < 60) return `${minutes} 分钟`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} 小时 ${minutes % 60} 分`;
    return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`;
  }

  function bytes(value) {
    const size = Number(value) || 0;
    if (size < 1024) return `${size} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let index = -1;
    let current = size;
    do {
      current /= 1024;
      index += 1;
    } while (current >= 1024 && index < units.length - 1);
    return `${current.toFixed(current >= 10 ? 1 : 2)} ${units[index]}`;
  }

  function codeClass(code) {
    if (code >= 500) return 'bad';
    if (code >= 400) return 'warn';
    return 'ok';
  }

  function showGate(message = '') {
    $('dashboard').hidden = true;
    $('gate').hidden = false;
    const error = $('gate-error');
    if (message) {
      error.textContent = message;
      error.hidden = false;
    } else {
      error.hidden = true;
    }
    const input = $('gate-token');
    input.value = '';
    input.placeholder = '粘贴令牌';
    setTimeout(() => input.focus(), 60);
  }

  function showDashboard() {
    $('gate').hidden = true;
    $('dashboard').hidden = false;
    hasData = true;
  }

  async function fetchStatus() {
    const response = await fetch('/api/admin/status', {
      headers: { 'X-Admin-Token': token },
      cache: 'no-store',
    });
    if (response.status === 401) {
      const error = new Error('unauthorized');
      error.code = 'unauthorized';
      throw error;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  function setLive(online, note) {
    const pill = $('status-pill');
    pill.classList.toggle('down', !online);
    pill.innerHTML = `<i></i> ${online ? '运行中' : '连接异常'}`;
    const refresh = $('refresh-note');
    refresh.textContent = note;
    refresh.classList.toggle('error', !online);
  }

  async function load({ quiet = false } = {}) {
    if (!token) {
      showGate();
      return;
    }
    if (!quiet) setLive(true, '正在刷新…');
    try {
      const data = await fetchStatus();
      render(data);
      showDashboard();
      setLive(true, `更新于 ${fmtTime(new Date().toISOString())}`);
    } catch (error) {
      if (error.code === 'unauthorized') {
        token = '';
        sessionStorage.removeItem(TOKEN_KEY);
        hasData = false;
        showGate('管理员令牌无效，请重新输入。');
        return;
      }
      setLive(false, `刷新失败：${error.message}`);
      if (!hasData) showGate(`无法连接服务端：${error.message}`);
    }
  }

  function startTimer() {
    clearInterval(timer);
    timer = setInterval(() => {
      if (!document.hidden) load({ quiet: true });
    }, 5000);
  }

  function render(data) {
    const { server, ai, stats } = data;
    const online = data.users.filter((user) => user.online).length;

    $('version').textContent = `v${server.version}`;
    $('server-line').textContent = `${server.hostname} · ${server.platform} · Node ${server.node} · 端口 ${server.port}`;
    $('hero-meta').innerHTML = `
      <div><span>运行时长</span><strong>${humanUptime(server.uptimeSeconds)}</strong></div>
      <div><span>内存 RSS</span><strong>${bytes(server.memory.rss)}</strong></div>
      <div><span>系统负载</span><strong>${server.loadavg.map((n) => Number(n).toFixed(2)).join(' / ')}</strong></div>
      <div><span>请求总数</span><strong>${stats.requestsTotal}</strong></div>`;

    $('summary').innerHTML = `
      <div class="stat">
        <span class="stat-label">服务状态</span>
        <strong class="ok">运行中</strong>
        <span class="stat-foot">已运行 ${humanUptime(server.uptimeSeconds)}</span>
      </div>
      <div class="stat">
        <span class="stat-label">用户</span>
        <strong>${stats.users}</strong>
        <span class="stat-foot">${online} 在线 · ${stats.activeSessions} 个有效会话</span>
      </div>
      <div class="stat">
        <span class="stat-label">旅程</span>
        <strong>${stats.journeys}</strong>
        <span class="stat-foot">AI 调用 ${stats.aiCalls} 次</span>
      </div>
      <div class="stat">
        <span class="stat-label">AI</span>
        <strong class="${ai.configured ? 'ok' : 'warn'} small">${ai.configured ? '已配置' : '未配置'}</strong>
        <span class="stat-foot">${esc(ai.model)}${ai.mock ? ' · mock' : ''}</span>
      </div>`;

    renderUsers(data.users);
    renderRequests(data.requests);
    renderInfo(data);
  }

  function renderUsers(users) {
    $('user-count').textContent = `${users.length} 位用户`;
    if (users.length === 0) {
      $('users-body').innerHTML = '<tr class="empty-row"><td colspan="5">还没有注册用户</td></tr>';
      return;
    }
    $('users-body').innerHTML = users
      .map(
        (user) => `
        <tr>
          <td class="user-name">${esc(user.username)}</td>
          <td>${user.journeyCount}</td>
          <td>${fmtDateTime(user.lastSeenAt)}</td>
          <td>${fmtDateTime(user.createdAt)}</td>
          <td>${
            user.online
              ? '<span class="online-dot">在线</span>'
              : '<span class="offline-dot">离线</span>'
          }</td>
        </tr>`,
      )
      .join('');
  }

  function renderRequests(requests) {
    $('request-count').textContent = `${requests.length} 条`;
    if (requests.length === 0) {
      $('requests-body').innerHTML = '<tr class="empty-row"><td colspan="5">还没有 API 请求</td></tr>';
      return;
    }
    $('requests-body').innerHTML = requests
      .map(
        (request) => `
        <tr>
          <td>${fmtTime(request.time)}</td>
          <td class="method">${esc(request.method)}</td>
          <td class="path" title="${esc(request.path)}">${esc(request.path)}</td>
          <td><span class="code ${codeClass(request.status)}">${request.status}</span></td>
          <td>${request.ms} ms</td>
        </tr>`,
      )
      .join('');
  }

  function renderInfo(data) {
    const { server, ai, stats } = data;
    const urls = server.urls
      .map(
        (entry) =>
          `<a href="${esc(entry.url)}" target="_blank" rel="noreferrer">${esc(entry.url)}</a>`,
      )
      .join('<br>');
    const statuses =
      Object.entries(stats.requestsByStatus ?? {})
        .map(([code, count]) => `${code} × ${count}`)
        .join(' · ') || '—';

    $('info').innerHTML = `
      <div class="info-item">
        <span>访问地址</span>
        <strong>${urls}</strong>
      </div>
      <div class="info-item">
        <span>监听 / 进程</span>
        <strong><code>${esc(server.host)}:${server.port}</code><br>PID ${server.pid} · ${server.cpuCount} 核</strong>
      </div>
      <div class="info-item">
        <span>数据库</span>
        <strong><code>${esc(server.dbPath)}</code><br>${bytes(server.dbSizeBytes)}</strong>
      </div>
      <div class="info-item">
        <span>启动时间</span>
        <strong>${fmtDateTime(server.startedAt)}</strong>
      </div>
      <div class="info-item">
        <span>内存</span>
        <strong>RSS ${bytes(server.memory.rss)} · 堆 ${bytes(server.memory.heapUsed)} / ${bytes(server.memory.heapTotal)}</strong>
      </div>
      <div class="info-item">
        <span>系统</span>
        <strong>${esc(server.arch)} · 负载 ${server.loadavg.map((n) => Number(n).toFixed(2)).join(' / ')}</strong>
      </div>
      <div class="info-item">
        <span>请求状态</span>
        <strong>${esc(statuses)}</strong>
      </div>
      <div class="info-item">
        <span>AI 模型</span>
        <strong>${esc(ai.model)}${ai.mock ? ' (mock)' : ''}<br><code>${esc(ai.baseUrl)}</code></strong>
      </div>
      <div class="info-item">
        <span>数据存储</span>
        <strong>SQLite · 本地文件</strong>
      </div>`;
    $('info-updated').textContent = `更新于 ${fmtTime(new Date().toISOString())}`;
  }

  // ---- events -------------------------------------------------------------

  $('gate-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = $('gate-token');
    const value = input.value.trim();
    if (!value) return;

    const button = event.target.querySelector('button[type="submit"]');
    button.disabled = true;
    button.textContent = '正在验证…';
    token = value;
    try {
      const data = await fetchStatus();
      sessionStorage.setItem(TOKEN_KEY, token);
      render(data);
      showDashboard();
      setLive(true, `更新于 ${fmtTime(new Date().toISOString())}`);
      startTimer();
    } catch (error) {
      token = '';
      sessionStorage.removeItem(TOKEN_KEY);
      showGate(error.code === 'unauthorized' ? '令牌不正确，请重试。' : `连接失败：${error.message}`);
    } finally {
      button.disabled = false;
      button.textContent = '进入看板';
    }
  });

  $('refresh').addEventListener('click', () => load());
  $('logout').addEventListener('click', () => {
    token = '';
    sessionStorage.removeItem(TOKEN_KEY);
    hasData = false;
    clearInterval(timer);
    showGate();
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && token) load({ quiet: true });
  });

  // ---- boot ---------------------------------------------------------------

  if (token) {
    $('gate').hidden = false;
    $('gate-token').placeholder = '正在验证令牌…';
    load();
    startTimer();
  } else {
    showGate();
  }
})();
