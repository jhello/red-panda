(() => {
  'use strict';

  const STORAGE = {
    token: 'odyssey.token',
    server: 'odyssey.server',
  };

  const app = document.getElementById('app');
  const toastEl = document.getElementById('toast');

  const state = {
    ready: false,
    bootError: null,
    token: localStorage.getItem(STORAGE.token) || '',
    user: null,
    server: '',
    journeys: [],
    currentJourney: null,
    currentJourneyId: null,
    authTab: 'login',
  };

  class ApiError extends Error {
    constructor(message, status = 0, code = 'error') {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.code = code;
    }
  }

  // ---- utilities ----------------------------------------------------------

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

  function fmtDate(iso) {
    if (!iso) return '—';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString('zh-CN', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }

  function fmtDay(iso) {
    if (!iso) return '';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
  }

  function normalizeServer(value) {
    let text = String(value ?? '').trim();
    if (!text) return '';
    if (!/^https?:\/\//i.test(text)) text = `http://${text}`;
    try {
      const url = new URL(text);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
      return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
    } catch {
      return '';
    }
  }

  function defaultServer() {
    const configured = normalizeServer(window.ODYSSEY_CONFIG?.defaultServer || '');
    if (configured) return configured;
    if (location.protocol === 'http:' || location.protocol === 'https:') {
      return normalizeServer(location.origin);
    }
    return '';
  }

  function currentServer() {
    return normalizeServer(localStorage.getItem(STORAGE.server) || defaultServer());
  }

  function toast(message, type = 'info') {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.dataset.type = type;
    toastEl.classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toastEl.classList.remove('show'), 2800);
  }

  function showError(id, message) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = message;
    el.hidden = false;
  }

  function hideError(id) {
    const el = document.getElementById(id);
    if (el) el.hidden = true;
  }

  function setBusy(button, busy, label = '请稍候…') {
    if (!button) return;
    if (busy) {
      button.dataset.idleLabel = button.textContent;
      button.textContent = label;
      button.disabled = true;
    } else {
      button.textContent = button.dataset.idleLabel || button.textContent;
      button.disabled = false;
    }
  }

  function navigate(hash) {
    if (location.hash === hash) {
      render();
    } else {
      location.hash = hash;
    }
  }

  function goBack() {
    if (history.length > 1) {
      history.back();
    } else {
      navigate('#/');
    }
  }

  function clearToken() {
    state.token = '';
    state.user = null;
    state.journeys = [];
    state.currentJourney = null;
    localStorage.removeItem(STORAGE.token);
  }

  function parseRoute() {
    const raw = location.hash.replace(/^#/, '') || '/';
    const parts = raw.split('/').filter(Boolean);
    if (parts.length === 0) return { name: 'home' };
    if (parts[0] === 'journey' && parts[1]) return { name: 'journey', id: parts[1] };
    return { name: parts[0] };
  }

  // ---- API ----------------------------------------------------------------

  async function api(path, options = {}) {
    const { method = 'GET', body, auth = true, timeout = 30000 } = options;
    if (!state.server) throw new ApiError('请先设置服务器地址', 0, 'no_server');

    const headers = { Accept: 'application/json' };
    if (auth && state.token) headers.Authorization = `Bearer ${state.token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let response;
    try {
      response = await fetch(`${state.server}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (error) {
      if (error.name === 'TimeoutError') {
        throw new ApiError('请求超时，请稍后重试', 0, 'timeout');
      }
      throw new ApiError('无法连接服务器，请检查网络和服务器地址', 0, 'network');
    }

    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }

    if (!response.ok) {
      if (response.status === 401 && auth) {
        clearToken();
        state.authTab = 'login';
        setTimeout(() => {
          if (state.ready) render();
        }, 0);
      }
      throw new ApiError(data?.error || `请求失败（${response.status}）`, response.status, data?.code);
    }
    return data ?? {};
  }

  async function pingServer(server) {
    let response;
    try {
      response = await fetch(`${server}/api/health`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      throw new Error('无法访问该地址');
    }
    if (!response.ok) throw new Error(`服务返回 HTTP ${response.status}`);
    const data = await response.json().catch(() => null);
    if (!data || data.ok !== true) throw new Error('这个地址不是山海经服务端');
    return data;
  }

  // ---- shared markup ------------------------------------------------------

  const brand = `
    <div class="brand">
      <span class="seal">山海</span>
      <div class="brand-text">
        <span class="brand-cn">山海经</span>
        <span class="brand-en">Odyssey</span>
      </div>
    </div>`;

  function topbar({ title = '', back = false, right = '' } = {}) {
    return `
      <header class="topbar">
        ${back ? '<button class="icon-btn" data-action="back" aria-label="返回">←</button>' : '<span class="topbar-lead"></span>'}
        <span class="topbar-title">${esc(title)}</span>
        <div class="topbar-right">${right}</div>
      </header>`;
  }

  function loadingScreen() {
    return `
      <div class="screen center-screen">
        <div class="loading">
          <span class="seal seal-lg pulse">山海</span>
          <p class="muted">正在翻开山海经…</p>
        </div>
      </div>`;
  }

  // ---- rendering ----------------------------------------------------------

  function render() {
    if (!state.ready) {
      app.innerHTML = loadingScreen();
      return;
    }

    const route = parseRoute();

    if (!state.server) {
      renderSetup();
      return;
    }
    if (state.bootError) {
      renderOffline(state.bootError);
      return;
    }
    if (!state.token) {
      if (route.name === 'settings') {
        renderSettings({ publicView: true });
      } else {
        renderAuth();
      }
      return;
    }
    if (!state.user) {
      app.innerHTML = loadingScreen();
      return;
    }

    switch (route.name) {
      case 'home':
        renderHome();
        break;
      case 'new':
        renderNewJourney();
        break;
      case 'journeys':
        renderJourneys();
        break;
      case 'journey':
        renderJourneyDetail(route.id);
        break;
      case 'settings':
        renderSettings();
        break;
      case 'login':
        history.replaceState(null, '', '#/');
        renderHome();
        break;
      default:
        history.replaceState(null, '', '#/');
        renderHome();
        break;
    }
  }

  function renderSetup() {
    app.innerHTML = `
      <div class="screen setup-screen">
        <div class="auth-hero">
          <span class="seal seal-lg">山海</span>
          <h1 class="auth-title">山海经</h1>
          <p class="auth-en">ODYSSEY</p>
        </div>
        <div class="card auth-card">
          <h2 class="setup-title">连接你的服务器</h2>
          <p class="setup-sub">在笔记本上启动服务端，然后填入它的局域网地址。</p>
          <form id="setup-form" class="form" novalidate>
            <label class="field">
              <span>服务器地址</span>
              <input id="setup-url" value="${esc(defaultServer() || 'http://127.0.0.1:8787')}"
                placeholder="http://192.168.1.10:8787" inputmode="url"
                autocapitalize="off" spellcheck="false" />
            </label>
            <p class="form-error" id="setup-error" hidden></p>
            <button class="btn primary block" type="submit">保存并连接</button>
          </form>
          <p class="hint">手机与电脑需在同一 Wi-Fi；也可以执行 <code>adb reverse tcp:8787 tcp:8787</code> 后填写 <code>http://127.0.0.1:8787</code>。</p>
        </div>
      </div>`;

    const form = document.getElementById('setup-form');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      hideError('setup-error');
      const button = form.querySelector('button[type="submit"]');
      const server = normalizeServer(document.getElementById('setup-url').value);
      if (!server) {
        showError('setup-error', '请输入合法的 http:// 或 https:// 地址');
        return;
      }
      setBusy(button, true, '正在连接…');
      try {
        const health = await pingServer(server);
        localStorage.setItem(STORAGE.server, server);
        state.server = server;
        toast(`已连接 · ${health.name || '山海经'} v${health.version || ''}`);
        state.authTab = 'login';
        location.hash = '#/login';
        await init();
      } catch (error) {
        showError('setup-error', `连接失败：${error.message}`);
        setBusy(button, false);
      }
    });
  }

  function renderOffline(error) {
    app.innerHTML = `
      <div class="screen center-screen">
        <div class="offline">
          <span class="seal seal-lg">山海</span>
          <h1 class="page-title">连不上服务器</h1>
          <p class="muted">${esc(error?.message || '网络请求失败')}</p>
          <p class="muted">请确认服务端已启动，且手机与电脑在同一网络。</p>
          <div class="row">
            <button class="btn primary" data-action="retry">重试</button>
            <button class="btn ghost" data-action="settings">服务器设置</button>
          </div>
        </div>
      </div>`;
  }

  function renderAuth() {
    const tab = state.authTab === 'register' ? 'register' : 'login';
    app.innerHTML = `
      <div class="screen auth-screen">
        <div class="auth-hero">
          <span class="seal seal-lg">山海</span>
          <h1 class="auth-title">山海经</h1>
          <p class="auth-en">ODYSSEY</p>
          <p class="auth-tag">把走过的路，写进山海之间</p>
        </div>

        <div class="card auth-card">
          <div class="tabs" role="tablist">
            <button class="tab ${tab === 'login' ? 'active' : ''}" data-tab="login" role="tab">登录</button>
            <button class="tab ${tab === 'register' ? 'active' : ''}" data-tab="register" role="tab">注册</button>
          </div>
          <form id="auth-form" class="form" novalidate>
            <label class="field">
              <span>用户名</span>
              <input name="username" autocomplete="username" maxlength="32" placeholder="你的名字" required />
            </label>
            <label class="field">
              <span>密码</span>
              <input name="password" type="password" maxlength="128"
                autocomplete="${tab === 'login' ? 'current-password' : 'new-password'}"
                placeholder="${tab === 'login' ? '输入密码' : '至少 8 个字符'}" required />
            </label>
            ${
              tab === 'register'
                ? `<label class="field">
                    <span>确认密码</span>
                    <input name="confirm" type="password" maxlength="128" autocomplete="new-password" placeholder="再输入一次" required />
                  </label>`
                : ''
            }
            <p class="form-error" id="auth-error" hidden></p>
            <button class="btn primary block" type="submit">${tab === 'login' ? '登录' : '创建账户'}</button>
          </form>
          <p class="auth-foot">
            ${tab === 'login' ? '还没有账户？' : '已经有账户？'}
            <button class="link" data-tab-switch="${tab === 'login' ? 'register' : 'login'}">
              ${tab === 'login' ? '注册一个' : '去登录'}
            </button>
          </p>
        </div>

        <button class="link subtle" data-action="settings">服务器设置 · ${esc(state.server)}</button>
      </div>`;

    app.querySelectorAll('[data-tab]').forEach((button) => {
      button.addEventListener('click', () => {
        state.authTab = button.dataset.tab;
        renderAuth();
      });
    });
    app.querySelectorAll('[data-tab-switch]').forEach((button) => {
      button.addEventListener('click', () => {
        state.authTab = button.dataset.tabSwitch;
        renderAuth();
      });
    });

    const form = document.getElementById('auth-form');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      hideError('auth-error');
      const username = form.username.value.trim();
      const password = form.password.value;
      if (!username) return showError('auth-error', '请输入用户名');
      if (!password) return showError('auth-error', '请输入密码');
      if (tab === 'register') {
        if (password.length < 8) return showError('auth-error', '密码至少需要 8 个字符');
        if (password !== form.confirm.value) return showError('auth-error', '两次输入的密码不一致');
      }

      const button = form.querySelector('button[type="submit"]');
      setBusy(button, true, tab === 'login' ? '正在登录…' : '正在创建…');
      try {
        const data = await api(`/api/auth/${tab}`, {
          method: 'POST',
          auth: false,
          body: { username, password },
        });
        state.token = data.token;
        state.user = data.user;
        state.authTab = 'login';
        localStorage.setItem(STORAGE.token, data.token);
        toast(tab === 'register' ? '欢迎加入山海经' : '欢迎回来');
        navigate('#/');
        render();
      } catch (error) {
        showError('auth-error', error.message);
        setBusy(button, false);
      }
    });
  }

  function renderHome() {
    app.innerHTML = `
      <div class="screen">
        <header class="topbar">
          ${brand}
          <div class="topbar-right">
            <button class="icon-btn" data-action="settings" aria-label="设置">⚙</button>
          </div>
        </header>

        <main class="page home-page">
          <section class="hero">
            <p class="eyebrow">你好，${esc(state.user.username)}</p>
            <h1 class="hero-title">山河远阔，<br />从这里启程。</h1>
            <p class="hero-sub">把走过的路，写进属于你的山海经。</p>
          </section>

          <section class="actions">
            <button class="action-card action-primary" data-action="new">
              <span class="action-mark">＋</span>
              <span class="action-copy">
                <strong>创建旅程</strong>
                <span>记录一段新的山海</span>
              </span>
              <span class="action-arrow">→</span>
            </button>
            <button class="action-card" data-action="journeys">
              <span class="action-mark mark-ink">卷</span>
              <span class="action-copy">
                <strong>查看旅程</strong>
                <span>翻阅走过的路</span>
              </span>
              <span class="action-arrow">→</span>
            </button>
          </section>

          <footer class="home-foot">
            <span>已记录 <b id="journey-count">—</b> 段旅程</span>
            <button class="link" data-action="logout">退出登录</button>
          </footer>
        </main>
      </div>`;

    api('/api/journeys')
      .then(({ journeys }) => {
        state.journeys = journeys;
        const el = document.getElementById('journey-count');
        if (el) el.textContent = String(journeys.length);
      })
      .catch(() => {
        const el = document.getElementById('journey-count');
        if (el) el.textContent = '—';
      });
  }

  function renderNewJourney() {
    app.innerHTML = `
      <div class="screen">
        ${topbar({ title: '创建旅程', back: true })}
        <main class="page">
          <h1 class="page-title">新的旅程</h1>
          <p class="page-sub">给它一个名字，再写下你想去的地方。</p>

          <form id="journey-form" class="form" novalidate>
            <label class="field">
              <span>名称</span>
              <input id="journey-name" maxlength="80" placeholder="例如：昆仑之丘" required />
            </label>
            <label class="field">
              <span>描述</span>
              <textarea id="journey-desc" maxlength="5000" rows="6" placeholder="山是什么颜色，风从哪里来……"></textarea>
            </label>

            <div class="ai-row">
              <button type="button" class="btn ghost" id="ai-write">✦ AI 帮我写描述</button>
              <span class="ai-hint">根据名称生成一段简介</span>
            </div>

            <p class="form-error" id="form-error" hidden></p>
            <button class="btn primary block" type="submit">保存旅程</button>
          </form>
        </main>
      </div>`;

    const form = document.getElementById('journey-form');
    const nameInput = document.getElementById('journey-name');
    const descInput = document.getElementById('journey-desc');
    const aiButton = document.getElementById('ai-write');

    aiButton.addEventListener('click', () => {
      runAI(nameInput.value, descInput, aiButton, 'form-error');
    });

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      hideError('form-error');
      const name = nameInput.value.trim();
      if (!name) return showError('form-error', '先给旅程起个名字吧');

      const button = form.querySelector('button[type="submit"]');
      setBusy(button, true, '正在保存…');
      try {
        const { journey } = await api('/api/journeys', {
          method: 'POST',
          body: { name, description: descInput.value.trim() },
        });
        toast('旅程已创建');
        navigate(`#/journey/${journey.id}`);
      } catch (error) {
        showError('form-error', error.message);
        setBusy(button, false);
      }
    });
  }

  async function runAI(name, textarea, button, errorId) {
    if (!String(name).trim()) {
      showError(errorId, '先给旅程起个名字吧');
      return;
    }
    hideError(errorId);
    button.disabled = true;
    const idle = button.textContent;
    button.textContent = '正在落笔…';
    try {
      const data = await api('/api/ai/journey-description', {
        method: 'POST',
        body: { name: String(name).trim() },
        timeout: 90000,
      });
      textarea.value = data.description;
      toast(data.mock ? '已生成示例描述（服务端为 mock 模式）' : 'AI 已写好，你可以继续修改');
    } catch (error) {
      showError(errorId, error.message);
    } finally {
      button.disabled = false;
      button.textContent = idle;
    }
  }

  function renderJourneys() {
    app.innerHTML = `
      <div class="screen">
        ${topbar({ title: '我的旅程', back: true })}
        <main class="page">
          <h1 class="page-title">我的旅程</h1>
          <p class="page-sub" id="journey-summary">正在翻阅…</p>

          <button class="btn primary block" data-action="new">＋ 创建旅程</button>

          <div class="journey-list" id="journey-list">
            <div class="skeleton-card"></div>
            <div class="skeleton-card"></div>
          </div>
        </main>
      </div>`;

    api('/api/journeys')
      .then(({ journeys }) => {
        state.journeys = journeys;
        const list = document.getElementById('journey-list');
        const summary = document.getElementById('journey-summary');
        if (!list) return;
        if (summary) summary.textContent = `共 ${journeys.length} 段旅程`;
        if (journeys.length === 0) {
          list.innerHTML = `
            <div class="empty">
              <span class="empty-mark">山</span>
              <p>还没有旅程。</p>
              <p class="muted">从一段小小的出发开始吧。</p>
            </div>`;
          return;
        }
        list.innerHTML = journeys.map(journeyCard).join('');
        list.querySelectorAll('[data-journey-id]').forEach((card) => {
          card.addEventListener('click', () => navigate(`#/journey/${card.dataset.journeyId}`));
        });
      })
      .catch((error) => {
        const list = document.getElementById('journey-list');
        const summary = document.getElementById('journey-summary');
        if (summary) summary.textContent = '加载失败';
        if (list) {
          list.innerHTML = `
            <div class="empty">
              <p>${esc(error.message)}</p>
              <button class="btn ghost" data-action="retry-journeys">重试</button>
            </div>`;
        }
      });
  }

  function journeyCard(journey) {
    const excerpt = journey.description
      ? esc(journey.description).replace(/\s+/g, ' ')
      : '还没有写下描述';
    return `
      <button class="journey-card" data-journey-id="${journey.id}">
        <span class="journey-top">
          <span class="journey-name">${esc(journey.name)}</span>
          <span class="journey-date">${esc(fmtDay(journey.updated_at))}</span>
        </span>
        <span class="journey-excerpt">${excerpt}</span>
      </button>`;
  }

  function renderJourneyDetail(id) {
    state.currentJourneyId = id;
    app.innerHTML = `
      <div class="screen">
        ${topbar({ title: '旅程', back: true })}
        <main class="page">
          <div class="skeleton-block"></div>
        </main>
      </div>`;

    api(`/api/journeys/${id}`)
      .then(({ journey }) => {
        state.currentJourney = journey;
        renderJourneyView(journey);
      })
      .catch((error) => {
        app.innerHTML = `
          <div class="screen">
            ${topbar({ title: '旅程', back: true })}
            <main class="page">
              <div class="empty">
                <p>${esc(error.message)}</p>
                <button class="btn ghost" data-action="retry-detail">重试</button>
              </div>
            </main>
          </div>`;
      });
  }

  function renderJourneyView(journey) {
    app.innerHTML = `
      <div class="screen">
        ${topbar({
          title: '旅程',
          back: true,
          right: '<button class="icon-btn" data-action="edit" aria-label="编辑">✎</button>',
        })}
        <main class="page detail">
          <p class="eyebrow">${esc(fmtDay(journey.updated_at))}</p>
          <h1 class="detail-title">${esc(journey.name)}</h1>
          <div class="detail-body">
            ${
              journey.description
                ? esc(journey.description).replace(/\n/g, '<br />')
                : '<p class="muted">这段旅程还没有描述。</p>'
            }
          </div>
          <div class="detail-actions">
            <button class="btn ghost" data-action="edit">编辑旅程</button>
            <button class="btn danger" data-action="delete">删除</button>
          </div>
        </main>
      </div>`;
  }

  function renderJourneyEdit(journey) {
    app.innerHTML = `
      <div class="screen">
        ${topbar({ title: '编辑旅程', back: true })}
        <main class="page">
          <h1 class="page-title">编辑旅程</h1>
          <p class="page-sub">名字与描述都可以慢慢改。</p>

          <form id="edit-form" class="form" novalidate>
            <label class="field">
              <span>名称</span>
              <input id="edit-name" maxlength="80" value="${esc(journey.name)}" required />
            </label>
            <label class="field">
              <span>描述</span>
              <textarea id="edit-desc" maxlength="5000" rows="7">${esc(journey.description)}</textarea>
            </label>

            <div class="ai-row">
              <button type="button" class="btn ghost" id="edit-ai">✦ AI 重写描述</button>
              <span class="ai-hint">会覆盖当前描述</span>
            </div>

            <p class="form-error" id="edit-error" hidden></p>
            <div class="row">
              <button class="btn ghost" type="button" data-action="cancel-edit">取消</button>
              <button class="btn primary" type="submit">保存修改</button>
            </div>
          </form>
        </main>
      </div>`;

    const form = document.getElementById('edit-form');
    const nameInput = document.getElementById('edit-name');
    const descInput = document.getElementById('edit-desc');
    const aiButton = document.getElementById('edit-ai');

    aiButton.addEventListener('click', () => {
      runAI(nameInput.value, descInput, aiButton, 'edit-error');
    });

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      hideError('edit-error');
      const name = nameInput.value.trim();
      if (!name) return showError('edit-error', '旅程名称不能为空');

      const button = form.querySelector('button[type="submit"]');
      setBusy(button, true, '正在保存…');
      try {
        const { journey: updated } = await api(`/api/journeys/${journey.id}`, {
          method: 'PUT',
          body: { name, description: descInput.value.trim() },
        });
        state.currentJourney = updated;
        toast('已保存');
        renderJourneyView(updated);
      } catch (error) {
        showError('edit-error', error.message);
        setBusy(button, false);
      }
    });
  }

  function renderSettings({ publicView = false } = {}) {
    app.innerHTML = `
      <div class="screen">
        ${topbar({ title: '设置', back: !publicView })}
        <main class="page">
          <h1 class="page-title">设置</h1>

          <section class="card panel">
            <h2 class="panel-title">服务器</h2>
            <p class="panel-sub">安卓 App 与 HTML5 页面共用同一个服务端。</p>
            <form id="server-form" class="form compact" novalidate>
              <label class="field">
                <span>服务端地址</span>
                <input id="server-url" value="${esc(state.server)}" placeholder="http://192.168.1.10:8787"
                  inputmode="url" autocapitalize="off" spellcheck="false" />
              </label>
              <p class="form-error" id="server-error" hidden></p>
              <p class="form-ok" id="server-ok" hidden></p>
              <button class="btn ghost block" type="submit">保存并测试连接</button>
            </form>
          </section>

          ${
            publicView
              ? `<section class="card panel">
                  <p class="panel-sub">登录后可以创建和查看你的旅程。</p>
                  <button class="btn primary block" data-action="login">去登录</button>
                </section>`
              : `<section class="card panel">
                  <h2 class="panel-title">账户</h2>
                  <dl class="kv">
                    <div><dt>用户名</dt><dd>${esc(state.user.username)}</dd></div>
                    <div><dt>注册时间</dt><dd>${esc(fmtDate(state.user.createdAt))}</dd></div>
                  </dl>
                  <button class="btn danger block" data-action="logout">退出登录</button>
                </section>`
          }

          <section class="card panel">
            <h2 class="panel-title">关于</h2>
            <p class="panel-sub">山海经 · Odyssey ${esc(window.ODYSSEY_CONFIG?.version || '1.0.0')}</p>
            <p class="panel-sub">数据保存在你自己的服务器上。</p>
          </section>
        </main>
      </div>`;

    const form = document.getElementById('server-form');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      hideError('server-error');
      const ok = document.getElementById('server-ok');
      ok.hidden = true;

      const button = form.querySelector('button[type="submit"]');
      const next = normalizeServer(document.getElementById('server-url').value);
      if (!next) {
        showError('server-error', '请输入合法的 http:// 或 https:// 地址');
        return;
      }

      setBusy(button, true, '正在连接…');
      try {
        const health = await pingServer(next);
        const previous = state.server;
        localStorage.setItem(STORAGE.server, next);
        state.server = next;
        ok.textContent = `连接成功 · ${health.name || '山海经'} v${health.version || ''}`;
        ok.hidden = false;

        if (previous && previous !== next) {
          clearToken();
          state.authTab = 'login';
          toast('服务器已切换，请重新登录');
          setTimeout(() => navigate('#/login'), 700);
        } else if (!state.token) {
          setTimeout(() => navigate('#/login'), 700);
        } else {
          setTimeout(() => navigate('#/'), 700);
        }
      } catch (error) {
        showError('server-error', `连接失败：${error.message}`);
      } finally {
        setBusy(button, false);
      }
    });
  }

  // ---- actions ------------------------------------------------------------

  async function doLogout() {
    const token = state.token;
    const server = state.server;
    clearToken();
    state.authTab = 'login';
    if (token && server) {
      try {
        await fetch(`${server}/api/auth/logout`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch {
        // Local logout still succeeds when offline.
      }
    }
    toast('已退出登录');
    navigate('#/login');
    render();
  }

  async function deleteCurrentJourney() {
    const journey = state.currentJourney;
    if (!journey) return;
    if (!confirm(`确定删除「${journey.name}」吗？此操作无法撤销。`)) return;
    try {
      await api(`/api/journeys/${journey.id}`, { method: 'DELETE' });
      toast('旅程已删除');
      state.currentJourney = null;
      navigate('#/journeys');
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  app.addEventListener('click', (event) => {
    const target = event.target.closest('[data-action]');
    if (!target) return;
    switch (target.dataset.action) {
      case 'settings':
        navigate('#/settings');
        break;
      case 'new':
        navigate('#/new');
        break;
      case 'journeys':
        navigate('#/journeys');
        break;
      case 'home':
        navigate('#/');
        break;
      case 'back':
        goBack();
        break;
      case 'logout':
        doLogout();
        break;
      case 'login':
        navigate('#/login');
        break;
      case 'retry':
        init();
        break;
      case 'retry-journeys':
        renderJourneys();
        break;
      case 'retry-detail':
        if (state.currentJourneyId) renderJourneyDetail(state.currentJourneyId);
        break;
      case 'edit':
        if (state.currentJourney) renderJourneyEdit(state.currentJourney);
        break;
      case 'cancel-edit':
        if (state.currentJourney) renderJourneyView(state.currentJourney);
        else navigate('#/journeys');
        break;
      case 'delete':
        deleteCurrentJourney();
        break;
      default:
        break;
    }
  });

  window.addEventListener('hashchange', render);

  // ---- boot ---------------------------------------------------------------

  async function init() {
    state.ready = false;
    state.bootError = null;
    state.user = null;
    state.server = currentServer();
    state.token = localStorage.getItem(STORAGE.token) || '';

    if (state.token && state.server) {
      try {
        const data = await api('/api/me');
        state.user = data.user;
      } catch (error) {
        if (error.status === 401) {
          clearToken();
        } else {
          state.bootError = error;
        }
      }
    }

    state.ready = true;
    render();
  }

  init();
})();
