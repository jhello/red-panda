(() => {
  'use strict';

  const STORAGE = {
    token: 'red-panda.token',
    server: 'red-panda.server',
    user: 'red-panda.user',
    lang: 'red-panda.lang',
    drafts: 'red-panda.drafts',
  };

  const app = document.getElementById('app');
  const overlayHost = document.getElementById('app-overlay');
  const navHost = document.getElementById('app-nav');
  const statusHost = document.getElementById('app-status');
  const toastEl = document.getElementById('toast');

  const state = {
    ready: false,
    token: localStorage.getItem(STORAGE.token) || '',
    user: null,
    server: '',
    journeys: [],
    currentJourney: null,
    currentJourneyId: null,
    memoryJourneyId: null,
    authTab: 'login',
    // null = unknown, true = reachable, false = offline.
    online: null,
  };

  // All personal travel content lives in IndexedDB so Web, Android WebView and
  // future browser shells share one portable storage format. Each account gets
  // its own database so two people sharing a device never see each other's trips.
  const LOCAL_DB = 'red-panda-local-v1';
  const localDbCache = new Map();
  function localDbName() {
    const owner = state.user?.id
      ? `u${state.user.id}`
      : state.user?.email
        ? `e${String(state.user.email).toLowerCase()}`
        : 'guest';
    return `${LOCAL_DB}-${owner.replace(/[^a-z0-9._-]+/gi, '_')}`;
  }
  function openIndexedDb(name) {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const store of ['journeys', 'memories', 'settings']) {
          if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  function readDbStore(db, name) {
    return new Promise((resolve, reject) => {
      const request = db.transaction(name).objectStore(name).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  function writeDbStore(db, name, values) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(name, 'readwrite');
      for (const value of values) tx.objectStore(name).put(value);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * The first version of client storage used one device-wide database. Claim it
   * for the current account once, so upgrading does not hide existing trips and
   * a second account cannot pick up the same data.
   */
  async function importLegacyLocalDb(targetDb) {
    if (!indexedDB.databases || localDbName() === LOCAL_DB) return;
    let names = [];
    try {
      names = (await indexedDB.databases()).map((item) => item.name);
    } catch {
      return;
    }
    if (!names.includes(LOCAL_DB)) return;
    let source;
    try {
      source = await openIndexedDb(LOCAL_DB);
    } catch {
      return;
    }
    try {
      const sourceSettings = await readDbStore(source, 'settings');
      if (sourceSettings.some((item) => item.id === 'legacy-claimed')) return;
      const [sourceJourneys, sourceMemories] = await Promise.all([
        readDbStore(source, 'journeys'),
        readDbStore(source, 'memories'),
      ]);
      const [targetJourneys, targetMemories, targetSettings] = await Promise.all([
        readDbStore(targetDb, 'journeys'),
        readDbStore(targetDb, 'memories'),
        readDbStore(targetDb, 'settings'),
      ]);
      const targetJourneyIds = new Set(targetJourneys.map((item) => String(item.id)));
      const targetMemoryIds = new Set(targetMemories.map((item) => String(item.id)));
      const settingsById = new Map(targetSettings.map((item) => [item.id, item]));
      for (const item of sourceSettings) {
        if (item.id === 'legacy-claimed') continue;
        const existing = settingsById.get(item.id);
        settingsById.set(item.id, existing ? { ...item, ...existing, id: item.id } : item);
      }
      await new Promise((resolve, reject) => {
        const tx = targetDb.transaction(['journeys', 'memories', 'settings'], 'readwrite');
        for (const item of sourceJourneys) if (!targetJourneyIds.has(String(item.id))) tx.objectStore('journeys').put(item);
        for (const item of sourceMemories) if (!targetMemoryIds.has(String(item.id))) tx.objectStore('memories').put(item);
        for (const item of settingsById.values()) tx.objectStore('settings').put(item);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      await writeDbStore(source, 'settings', [{ id: 'legacy-claimed', by: localDbName(), at: new Date().toISOString() }]);
    } catch {
      // Keep the old database untouched if any part of the copy fails.
    } finally {
      source.close();
    }
  }

  function localDb() {
    const name = localDbName();
    if (!localDbCache.has(name)) {
      localDbCache.set(name, (async () => {
        const db = await openIndexedDb(name);
        await importLegacyLocalDb(db);
        return db;
      })());
    }
    return localDbCache.get(name);
  }
  async function storeAll(name) {
    const db = await localDb();
    return new Promise((resolve, reject) => {
      const request = db.transaction(name).objectStore(name).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async function storePut(name, value) {
    const db = await localDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(name, 'readwrite');
      tx.objectStore(name).put(value);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }
  async function storeDelete(name, id) {
    const db = await localDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(name, 'readwrite');
      tx.objectStore(name).delete(id);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }
  const makeId = () => Date.now() * 1000 + Math.floor(Math.random() * 1000);

  /** Keep one object URL per stored media item instead of leaking a new one per render. */
  const mediaObjectUrls = new Map();
  function mediaObjectUrl(item) {
    if (!item?.blob) return item?.url || '';
    if (!mediaObjectUrls.has(item.id)) mediaObjectUrls.set(item.id, URL.createObjectURL(item.blob));
    return mediaObjectUrls.get(item.id);
  }
  function revokeMediaObjectUrl(id) {
    const url = mediaObjectUrls.get(id);
    if (!url) return;
    URL.revokeObjectURL(url);
    mediaObjectUrls.delete(id);
  }

  /** Mirror the server's normalization so local journeys keep the same shape. */
  function normalizeLocalPlan(value) {
    if (!value || typeof value !== 'object') return null;
    const rawItems = Array.isArray(value.items) ? value.items : Array.isArray(value) ? value : [];
    const items = [];
    for (const raw of rawItems) {
      if (!raw || typeof raw !== 'object') continue;
      const destination = String(raw.destination ?? '').trim();
      if (!destination) continue;
      items.push({
        destination: destination.slice(0, 80),
        departTime: String(raw.departTime ?? '').trim().slice(0, 16),
        returnTime: String(raw.returnTime ?? '').trim().slice(0, 16),
      });
    }
    if (!items.length) return null;
    const departs = items.map((item) => item.departTime).filter(Boolean).sort();
    const returns = items.map((item) => item.returnTime).filter(Boolean).sort();
    return { items, departTime: departs[0] ?? '', returnTime: returns.at(-1) ?? '' };
  }

  function buildLocalJourney(body, base = {}) {
    const plan = body.plan === undefined ? (base.plan || null) : normalizeLocalPlan(body.plan);
    const now = new Date().toISOString();
    return {
      ...base,
      id: base.id ?? makeId(),
      name: body.name ?? base.name ?? '',
      description: body.description ?? base.description ?? '',
      plan,
      depart_time: plan?.departTime || '',
      return_time: plan?.returnTime || '',
      created_at: base.created_at || now,
      updated_at: now,
    };
  }

  async function hydrateClientProfile(user) {
    if (!user) return user;
    const saved = (await storeAll('settings')).find((item) => item.id === 'profile') || { id: 'profile' };
    const fallbackName = String(user.email || '').split('@')[0] || t('nav.me');
    const profile = {
      ...saved,
      id: 'profile',
      displayName: saved.displayName || fallbackName,
      locale: saved.locale || '',
      usualOrigin: saved.usualOrigin || [],
    };
    await storePut('settings', profile);
    if (!localStorage.getItem(STORAGE.lang) && profile.locale) {
      currentLocale = profile.locale;
      localStorage.setItem(STORAGE.lang, profile.locale);
      applyDocumentLocale();
    }
    return { ...user, displayName: profile.displayName, locale: profile.locale || getLocale(), usualOrigin: profile.usualOrigin };
  }

  /**
   * Journeys, memories, profile and media are read/written locally. The
   * server only keeps account authentication.
   */
  async function localDataApi(path, options = {}) {
    const method = options.method || 'GET';
    const url = new URL(path, location.origin);
    const p = url.pathname;
    const body = options.body || {};

    if (p === '/api/journeys' && method === 'GET') {
      const journeys = (await storeAll('journeys')).sort((a, b) => String(a.depart_time).localeCompare(String(b.depart_time)));
      return { journeys };
    }
    if (p === '/api/journeys' && method === 'POST') {
      const journey = buildLocalJourney(body);
      await storePut('journeys', journey);
      return { journey };
    }

    let match = /^\/api\/journeys\/([^/]+)$/.exec(p);
    if (match) {
      const id = match[1];
      const journeys = await storeAll('journeys');
      const journey = journeys.find((item) => String(item.id) === id);
      if (method === 'GET') {
        if (!journey) throw new ApiError(t('api.journeyNotFound'), 404, 'not_found');
        return { journey };
      }
      if (method === 'PUT') {
        if (!journey) throw new ApiError(t('api.journeyNotFound'), 404, 'not_found');
        const updated = buildLocalJourney(body, journey);
        await storePut('journeys', updated);
        return { journey: updated };
      }
      if (method === 'DELETE') {
        for (const memory of await storeAll('memories')) {
          if (String(memory.journeyId) !== id) continue;
          for (const item of memory.media || []) revokeMediaObjectUrl(item.id);
          await storeDelete('memories', memory.id);
        }
        await storeDelete('journeys', journey?.id ?? id);
        return {};
      }
    }

    if (p === '/api/memories' && method === 'GET') {
      const all = (await storeAll('memories')).map((memory) => ({
        ...memory,
        media: (memory.media || []).map((item) => ({ ...item, url: mediaObjectUrl(item) })),
      }));
      const journeyId = url.searchParams.get('journeyId');
      const memories = journeyId ? all.filter((item) => String(item.journeyId) === journeyId) : all;
      const counts = {};
      for (const memory of all) {
        const key = String(memory.journeyId);
        counts[key] = (counts[key] || 0) + 1;
      }
      return { memories, counts };
    }
    if (p === '/api/memories' && method === 'POST') {
      const journeyId = body.journeyId ?? null;
      const note = String(body.note ?? '').trim();
      if (journeyId !== null && !(await storeAll('journeys')).some((item) => String(item.id) === String(journeyId))) {
        throw new ApiError(t('api.journeyNotFound'), 404, 'not_found');
      }
      if (!note && journeyId === null) {
        throw new ApiError(t('api.validationEmpty'), 400, 'validation_error');
      }
      const memory = { id: makeId(), journeyId, note, createdAt: new Date().toISOString(), media: [] };
      await storePut('memories', memory);
      return { memory };
    }

    match = /^\/api\/memories\/([^/]+)(\/media)?$/.exec(p);
    if (match) {
      const id = match[1];
      const all = await storeAll('memories');
      const memory = all.find((item) => String(item.id) === id);
      if (p.endsWith('/media') && method === 'POST') {
        if (!memory) throw new ApiError(t('api.memoryNotFound'), 404, 'not_found');
        const blob = options.body;
        if (!(blob instanceof Blob) || !blob.size) {
          throw new ApiError(t('api.memoryEmpty'), 400, 'validation_error');
        }
        const media = {
          id: makeId(),
          kind: blob.type.startsWith('video/') ? 'video' : 'image',
          mime: blob.type,
          size: blob.size,
          createdAt: new Date().toISOString(),
          blob,
        };
        memory.media.push(media);
        await storePut('memories', memory);
        return { media: { ...media, url: mediaObjectUrl(media) } };
      }
      if (method === 'DELETE') {
        if (!memory) throw new ApiError(t('api.memoryNotFound'), 404, 'not_found');
        for (const item of memory.media || []) revokeMediaObjectUrl(item.id);
        await storeDelete('memories', memory.id);
        return {};
      }
    }

    if (p === '/api/me/profile' && method === 'PUT') {
      const existing = (await storeAll('settings')).find((item) => item.id === 'profile') || { id: 'profile' };
      const displayName = String(body.displayName || '').trim();
      if (!displayName || displayName.length > 40) {
        throw new ApiError(t('api.nicknameLength'), 400, 'validation_error');
      }
      existing.displayName = displayName;
      await storePut('settings', existing);
      return { displayName };
    }
    if (p === '/api/me/locale' && method === 'PUT') {
      const existing = (await storeAll('settings')).find((item) => item.id === 'profile') || { id: 'profile' };
      existing.locale = body.locale;
      await storePut('settings', existing);
      return {};
    }
    if (p === '/api/me/usual-origin' && method === 'PUT') {
      const existing = (await storeAll('settings')).find((item) => item.id === 'profile') || { id: 'profile' };
      existing.usualOrigin = body.origins;
      await storePut('settings', existing);
      return { usualOrigin: body.origins };
    }
    return null;
  }

  class ApiError extends Error {
    constructor(message, status = 0, code = 'error') {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.code = code;
    }
  }

  // ---- i18n ----------------------------------------------------------------

  const I18N = {
    zh: {
      langName: '中文',
      documentLang: 'zh-CN',
      documentTitle: '小熊猫 · Red Panda',
      dateLocale: 'zh-CN',

      brand: {
        name: '小熊猫',
        alt: '小熊猫',
        big: '小熊猫',
      },
      common: {
        back: '返回',
        pleaseWait: '请稍候…',
        retry: '重试',
      },
      loading: '正在打开小熊猫…',
      lang: {
        label: '切换语言',
      },
      nav: {
        current: '行程',
        memories: '回忆',
        discover: '发现',
        discoverSoon: '更多目的地正在路上，敬请期待',
        me: '我',
      },

      trip: {
        ongoing: '进行中',
        upcoming: '即将开始',
        ended: '已结束',
        infoTitle: '行程信息',
        weather: '天气',
        traffic: '交通',
        filesTitle: '文件',
        ticket: '门票',
        trainTicket: '车票',
        soon: '即将上线',
        soonHint: '天气、交通和票据还在路上，先把行程记下来就好。',
        openDetail: '查看行程详情',
        allJourneys: '全部行程',
        emptyTitle: '还没有行程',
        emptySub: '说说想去哪里，小熊猫帮你规划',
        otherTitle: '其他行程',
      },

      memories: {
        title: '回忆',
        sub: '给走过的行程添上照片、视频和文字，小熊猫帮你写成旅行回忆。',
        emptyTitle: '还没有回忆',
        emptySub: '选一段走过的行程，开始记录吧。',
        addTitle: '写一段回忆',
        notePlaceholder: '那天发生了什么？',
        pick: '照片 / 视频',
        save: '保存回忆',
        savedToast: '回忆已保存',
        deletedToast: '回忆已删除',
        deleteConfirm: '删除这条回忆吗？',
        count: '{n} 条回忆',
        noCount: '还没有回忆',
        generate: '生成旅行回忆',
        generating: '正在落笔…',
        recapTitle: '旅行回忆',
        share: '分享',
        shareSoon: '朋友圈 / 小红书 / Instagram 分享即将上线',
        uploadFailed: '有文件没能上传成功',
        needContent: '写点什么，或者选一张照片',
        noJourney: '还没有行程',
      },

      draft: {
        title: '草稿：{time}，{destination}，{created}',
        untimed: '未定时间',
        undestined: '未定目的地',
        expand: '展开草稿',
        delete: '删除这个草稿',
        none: '没有草稿',
        previewEmpty: '还没有提取出行程',
      },

      api: {
        noServer: '请先设置服务器地址',
        timeout: '请求超时，请稍后重试',
        networkToast: '无法连接服务器，请检查网络',
        network: '无法连接服务器，请检查网络和服务器地址',
        sessionExpired: '登录已失效，请重新登录',
        requestFailed: '请求失败（{status}）',
        pingUnreachable: '无法访问该地址',
        pingHttp: '服务返回 HTTP {status}',
        pingNotServer: '这个地址不是小熊猫服务端',

        invalid_credentials: '邮箱或密码不正确',
        email_taken: '这个邮箱已经注册过了',
        email_not_verified: '邮箱尚未验证，请查收验证邮件并点击激活链接',
        rate_limited: '尝试次数过多，请十分钟后再试',
        mail_failed: '邮件发送失败，请稍后重试',
        invalid_reset_token: '重置链接无效或已过期，请重新申请',
        invalid_password: '当前密码不正确',
        unauthorized: '登录已失效，请重新登录',
        validation_error: '输入格式不正确',
        payload_too_large: '请求内容过大',
        bad_json: 'JSON 格式不正确',
        not_found: '内容不存在',
        internal_error: '服务器内部错误',
        ai_invalid_json: 'AI 返回的内容格式不正确',
        journeyNotFound: '行程不存在',
        memoryNotFound: '回忆不存在',
        memoryEmpty: '文件内容为空',
        validationEmpty: '写点什么，或者选一段行程',
        nicknameLength: '昵称需要为 1 到 40 个字符',
      },

      offline: {
        banner: '离线模式：服务或网络不可用',
        title: '当前离线',
        detail: '连不上服务器，先用本机数据吧。联网后会自动恢复 AI、邮件和地点搜索。',
        error: '当前连不上服务器，请检查网络后重试',
        action: '重试',
        retrying: '正在重连…',
        online: '已重新连接',
      },

      setup: {
        title: '连接你的服务器',
        sub: '在笔记本上启动服务端，然后填入它的局域网地址。',
        serverLabel: '服务器地址',
        submit: '保存并连接',
        urlError: '请输入合法的 http:// 或 https:// 地址',
        connecting: '正在连接…',
        connectedToast: '已连接 · {name} v{version}',
        connectFailed: '连接失败：{message}',
        hint:
          '手机与电脑需在同一 Wi-Fi；也可以执行 <code>adb reverse tcp:8787 tcp:8787</code> 后填写 <code>http://127.0.0.1:8787</code>。',
      },

      auth: {
        tabLogin: '登录',
        tabRegister: '注册',
        emailLabel: '邮箱',
        passwordLabel: '密码',
        confirmLabel: '确认密码',
        passwordPlaceholderLogin: '输入密码',
        passwordPlaceholderRegister: '至少 8 个字符',
        confirmPlaceholder: '再输入一次',
        showPassword: '显示密码',
        hidePassword: '隐藏密码',
        noticeVerified: '邮箱已验证，请登录。',
        noticeInvalidLink: '验证链接无效或已过期，请重新发送验证邮件。',
        noticeResetDone: '密码已重置，请用新密码登录。',
        loginSubmit: '登录',
        registerSubmit: '注册并验证邮箱',
        forgot: '忘记密码？',
        noAccount: '还没有账户？',
        registerLink: '注册一个',
        haveAccount: '已经有账户？',
        loginLink: '去登录',
        errEmail: '请输入邮箱',
        errEmailInvalid: '请输入有效的邮箱地址',
        errPassword: '请输入密码',
        errPasswordLength: '密码至少需要 8 个字符',
        errConfirm: '两次输入的密码不一致',
        busyLogin: '正在登录…',
        busyRegister: '正在注册…',
        welcome: '欢迎回来',
        verifyFirst: '请先验证邮箱',
        mailSentToast: '验证邮件已发送，请查收',
        tagline: '出门带只小熊猫。',
      },

      pending: {
        title: '验证你的邮箱',
        yourEmail: '你的邮箱',
        body: '我们已向 {email} 发送了一封验证邮件。请点击邮件里的链接激活账户，链接在 24 小时内有效。',
        resend: '重新发送验证邮件',
        backLogin: '返回登录',
        hint: '没有收到邮件？请检查垃圾邮件目录，或确认邮箱地址是否正确。',
        sending: '正在发送…',
        resendHint: '如果未收到，请点击重新发送按钮。',
      },

      forgot: {
        title: '重置密码',
        sub: '输入注册邮箱，我们会发送一封重置密码的邮件。',
        submit: '发送重置邮件',
        sentFallback: '如果该邮箱已注册，重置邮件已发送',
        sent: '重置邮件已发送',
        sentTo: '重置邮件已发送至 {email}',
        expires: '请在 24 小时内点击邮件中的链接。链接有效期至 {date}。',
        notReceived: '如果未收到，请点击重新发送按钮。',
        resend: '重新发送重置邮件',
        sending: '发送中…',
      },

      reset: {
        invalidTitle: '重置链接无效',
        invalidBody: '这个链接缺少重置令牌，请重新申请一封重置邮件。',
        reapply: '重新申请',
        title: '设置新密码',
        sub: '输入新的密码后，所有设备都需要重新登录。',
        newPasswordLabel: '新密码',
        confirmLabel: '确认新密码',
        save: '保存新密码',
        savedToast: '密码已重置，请重新登录',
      },

      home: {
        greeting: '你好，{name}',
        title: '山河远阔，<br />从这里启程。',
        sub: '勇敢探索你的世界。',
        createTitle: '创建旅程',
        createSub: '记录一段新的山海',
        currentTitle: '当前行程',
        emptyTitle: '还没有行程',
        emptySub: '说说想去哪里，小熊猫帮你规划',
        listTitle: '查看旅程',
        listSub: '翻阅走过的路',
        countText: '已记录 <b id="journey-count">—</b> 段旅程',
        logout: '退出登录',
      },

      new: {
        title: '新的旅程',
        errName: '先给旅程起个名字吧',
      },

      ai: {
        rewrite: '✦ AI 重写描述',
        rewriteHint: '会覆盖当前描述',
        busy: '正在落笔…',
        done: 'AI 已写好，你可以继续修改',
        mock: '已生成示例描述（服务端为 mock 模式）',
      },

      plan: {
        placeholders: ['我想去雅典卫城', '下周去卢浮宫和橘园美术馆', '去看新天鹅堡的雪景'],
        artAlt: ['黄昏中的雅典卫城', '暮色里的卢浮宫', '雪中的新天鹅堡'],
        confirm: '先这样',
        thinking: '我想想',
        edit: '编辑',
        resend: '重发',
        editTip: '改完点「确定」再出发。',
        title: '旅程计划',
        sub: '大模型会从你的想法里挑出可以出发的目的地。',
        fieldDestination: '目的地',
        fieldDepart: '出发时间',
        fieldReturn: '返回时间',
        planEmpty: '这次没有为你挑出合适的旅程。',
        editItem: '修改旅程',
        editItemSub: '改完直接点「确定」即可。',
        saveItem: '保存修改',
        create: '创建旅程',
        save: '就这样',
        savedToast: '旅程已保存',
      },

      journeys: {
        title: '我的旅程',
        loading: '正在翻阅…',
        count: '共 {n} 段旅程',
        emptyTitle: '还没有旅程。',
        emptySub: '从一段小小的出发开始吧。',
        noDesc: '还没有写下描述',
        loadFailed: '加载失败',
      },

      detail: {
        topbar: '旅程',
        noDesc: '这段旅程还没有描述。',
        edit: '编辑旅程',
        editAria: '编辑',
        delete: '删除',
      },

      edit: {
        title: '编辑旅程',
        sub: '名字与描述都可以慢慢改。',
        save: '保存修改',
        errName: '旅程名称不能为空',
      },

      journey: {
        createdToast: '旅程已创建',
        deletedToast: '旅程已删除',
        savedToast: '已保存',
        deleteConfirm: '确定删除「{name}」吗？此操作无法撤销。',
      },

      busy: {
        saving: '正在保存…',
        sending: '发送中…',
        updating: '正在更新…',
      },

      field: {
        name: '名称',
        desc: '描述',
      },

      settings: {
        title: '设置',
        serverTitle: '服务器',
        serverSub: '安卓 App 与 HTML5 页面共用同一个服务端。',
        serverLabel: '服务端地址',
        testSubmit: '保存并测试连接',
        publicSub: '登录后可以创建和查看你的旅程。',
        goLogin: '去登录',
        accountTitle: '账户',
        email: '邮箱',
        displayName: '昵称',
        createdAt: '注册时间',
        passwordTitle: '修改密码',
        passwordSub: '修改后其他设备会自动退出登录。',
        currentPassword: '当前密码',
        currentPlaceholder: '输入当前密码',
        updatePassword: '更新密码',
        errCurrent: '请输入当前密码',
        errNewLength: '新密码至少需要 8 个字符',
        errNewConfirm: '两次输入的新密码不一致',
        updatedOk: '密码已更新，其他设备已退出登录。',
        updatedToast: '密码已更新',
        languageTitle: '语言',
        originTitle: '常用地址',
        originName: '名称',
        originCountry: '国家 / 地区',
        originProvince: '省 / 州',
        originCity: '市',
        originDistrict: '区 / 县',
        originTownship: '乡 / 镇 / 街道办',
        originStreet: '街道',
        originStreetNumber: '门牌号码',
        originSave: '保存地址',
        originSaved: '常用地址已保存',
        originInput: '输入地点，如“上海市浦东新区张江路 88 号”',
        originAdd: '新增地点',
        originMap: '地图选点', originMapHint: '点击地图或拖动图钉选择位置', originMapUse: '使用此地点', originEmpty: '还没有常用地址',
        originEdit: '编辑', originUpdate: '保存修改', originCancel: '取消编辑', originLocate: '定位到当前位置', originSearching: '正在搜索地点…', originNoResults: '没有找到地点', originSearchAttribution: '地点数据 © OpenStreetMap contributors', originLocationError: '无法获取当前位置，请检查定位权限。',
        originSecureRequired: '网页定位需要 HTTPS，请用安全连接打开页面，或使用 Android App。',
        accountSecurity: '账户与安全',
        dataBackup: '数据与备份',
        accountInfo: '账户资料',
        newEmail: '新邮箱地址',
        newEmailPlaceholder: '输入新的邮箱地址',
        sendVerificationEmail: '发送验证邮件',
        close: '关闭',
        verificationSentTo: '验证邮件已发送至',
        verificationHint: '请前往新邮箱点击验证链接。验证完成后返回此页，下拉页面即可刷新邮箱地址。链接有效期至 {date}。',
        verificationNote: '验证前仍使用原邮箱；超过 24 小时链接失效，新邮箱地址将不再显示。',
        emailUpdated: '邮箱已更新',
        emailUpdatedBody: '新邮箱验证成功，已替换账户中的原邮箱地址。',
        emailUpdatedShort: '新邮箱验证成功，已替换原邮箱。',
        returnToApp: '请返回小熊猫应用，账户资料会自动同步。',
        goSignIn: '前往登录',
        dataSub: '查看本机数据占用，导入或导出跨平台备份。',
        openDatabase: '打开数据库',
        errEmailEmpty: '请输入新邮箱地址',
        emailSentToast: '验证邮件已发送，请在 24 小时内完成验证',
        emailCancelledToast: '邮箱未更改，待验证地址已取消',
        emailResentToast: '验证邮件已重新发送，请在 24 小时内完成验证',
        resetPassword: '忘记密码',
        resetPasswordSub: '点击下方按钮，我们会向当前账户邮箱发送密码重置邮件。',
        aboutTitle: '关于',
        aboutBody: '小熊猫 · Red Panda {version}',
        aboutData: '数据保存在你自己的服务器上。',
        connectedOk: '连接成功 · {name} v{version}',
        serverChangedToast: '服务器已切换，请重新登录',
      },

      me: {
        footprints: '我的足迹',
        destinations: '{n} 个目的地',
        worldFootprints: '世界地图足迹',
        footprintsSub: '记录旅程，点亮去过的地方',
        editNickname: '修改昵称',
        nicknameEmpty: '昵称不能为空',
        nicknameSaved: '昵称已保存',
      },

      account: {
        updated: '账户信息已更新',
        upToDate: '账户信息已是最新',
        pullRefresh: '松开即可刷新账户信息',
        refreshing: '正在刷新账户信息…',
        refreshed: '账户信息已刷新',
      },

      backup: {
        title: '数据库',
        journeys: '行程',
        memories: '回忆文字',
        media: '照片与视频',
        preferences: '偏好设置',
        records: '数据条目',
        estimatedTotal: '总占用估算',
        types: '数据类型',
        items: '条',
        exportData: '导出',
        chooseFile: '导入',
        details: '数据明细',
        byCount: '按条数',
        bySize: '按体积',
        sizeNote: '体积为本机数据的估算值；媒体按文件大小统计。',
        exportCancelled: '已取消导出',
        exportingJourneys: '正在导出行程（{done}/{total}）…',
        journeysExported: '行程导出完成，{n} 条。正在处理回忆…',
        memoriesExporting: '回忆 {i}/{n}；媒体 {done}/{total} 已导出…',
        exportingMemories: '正在导出回忆 {i}/{n}…',
        mediaExported: '媒体导出完成，{n} 个。正在写入偏好设置（{s} 条）…',
        compressing: '正在压缩备份…',
        exportSuccess: '全部导出成功',
        journeyUnit: '段行程',
        memoryUnit: '条回忆',
        mediaUnit: '个媒体',
        settingUnit: '条设置',
        packagedChoose: '各类数据已打包，正在选择保存位置…',
        exportFailed: '导出失败',
        downloadStarted: '已发起下载 {file}（{size}）。请检查下载列表确认文件已保存。',
        importConfirm: '导入将合并备份数据：新增记录会加入，内容不同的同编号记录会更新，完全相同的记录会跳过。继续吗？',
        readingFile: '正在读取 {file}…',
        decompressing: '正在解压并检查备份…',
        notBackup: '文件不是小熊猫备份',
        unsupportedVersion: '不支持的数据结构版本：{version}',
        incomplete: '备份内容不完整',
        journeysRead: '行程数据：已读取 {n} 条。',
        readingMemories: '正在读取回忆 {i}/{n}…',
        readingMedia: '正在读取照片/视频 {done}/{total}…',
        mediaRead: '媒体数据：已读取 {c} 个；偏好设置：{s} 条，开始比较本机数据…',
        comparing: '比较完成，正在合并设置与数据…',
        mergeComplete: '导入合并完成：\n{results}',
        stats: '{label}：原有 {old} 条，新增 {added} 条，完全相同 {identical} 条，更新 {updated} 条',
        statsJourney: '行程',
        statsMemory: '回忆',
        statsMedia: '媒体',
        statsSettings: '设置',
        selectedFile: '已选择文件',
        imported: '数据已导入',
        importCancelled: '已取消导入',
        importFailed: '导入失败',
      },

      logout: {
        toast: '已退出登录',
      },
    },

    en: {
      langName: 'English',
      documentLang: 'en',
      documentTitle: 'Red Panda · 小熊猫',
      dateLocale: 'en-GB',

      brand: {
        name: 'Red Panda',
        alt: 'Red Panda',
        big: 'Red Panda',
      },
      common: {
        back: 'Back',
        pleaseWait: 'One moment…',
        retry: 'Retry',
      },
      loading: 'Opening Red Panda…',
      lang: {
        label: 'Language',
      },
      nav: {
        current: 'Journeys',
        memories: 'Memories',
        discover: 'Discover',
        discoverSoon: 'More destinations are on the way — stay tuned',
        me: 'Me',
      },

      trip: {
        ongoing: 'Ongoing',
        upcoming: 'Coming up',
        ended: 'Finished',
        infoTitle: 'Trip info',
        weather: 'Weather',
        traffic: 'Traffic',
        filesTitle: 'Files',
        ticket: 'Tickets',
        trainTicket: 'Rail tickets',
        soon: 'Coming soon',
        soonHint: 'Weather, traffic and tickets are still on the way — keep the trip in the app for now.',
        openDetail: 'Open trip details',
        allJourneys: 'All journeys',
        emptyTitle: 'No trip yet',
        emptySub: 'Tell me where you want to go',
        otherTitle: 'Other journeys',
      },

      memories: {
        title: 'Memories',
        sub: 'Add photos, videos and words to a journey you already took — I will turn them into a travel memory.',
        emptyTitle: 'No memories yet',
        emptySub: 'Pick a journey you already took and start writing.',
        addTitle: 'Write a memory',
        notePlaceholder: 'What happened that day?',
        pick: 'Photos / videos',
        save: 'Save memory',
        savedToast: 'Memory saved',
        deletedToast: 'Memory deleted',
        deleteConfirm: 'Delete this memory?',
        count: '{n} memories',
        noCount: 'No memories yet',
        generate: 'Write the travel memory',
        generating: 'Writing…',
        recapTitle: 'Travel memory',
        share: 'Share',
        shareSoon: 'Sharing to Moments, Xiaohongshu and Instagram is coming soon',
        uploadFailed: 'Some files could not be uploaded',
        needContent: 'Write something, or pick a photo',
        noJourney: 'No journey yet',
      },

      draft: {
        title: 'Draft: {time}, {destination}, {created}',
        untimed: 'no time yet',
        undestined: 'no destination yet',
        expand: 'Expand draft',
        delete: 'Delete this draft',
        none: 'No drafts',
        previewEmpty: 'No trip extracted yet',
      },

      api: {
        noServer: 'Set a server address first',
        timeout: 'Request timed out — please try again',
        networkToast: "Can't reach the server — check your network",
        network: "Can't reach the server. Check your network and server address",
        sessionExpired: 'Session expired — please log in again',
        requestFailed: 'Request failed ({status})',
        pingUnreachable: "That address can't be reached",
        pingHttp: 'Server answered HTTP {status}',
        pingNotServer: "That address isn't a Red Panda server",

        invalid_credentials: 'Email or password is incorrect',
        email_taken: 'This email is already registered',
        email_not_verified: 'Email not verified yet — check your inbox for the activation link',
        rate_limited: 'Too many attempts — try again in ten minutes',
        mail_failed: "Couldn't send the email — please try again later",
        invalid_reset_token: 'Reset link is invalid or expired — please request a new one',
        invalid_password: 'Current password is incorrect',
        unauthorized: 'Session expired — please log in again',
        validation_error: 'Invalid input',
        payload_too_large: 'Request too large',
        bad_json: 'Malformed JSON',
        not_found: 'Not found',
        internal_error: 'Internal server error',
        ai_invalid_json: 'The AI returned an unexpected response',
        journeyNotFound: 'Journey not found',
        memoryNotFound: 'Memory not found',
        memoryEmpty: 'The file is empty',
        validationEmpty: 'Write something or pick a journey',
        nicknameLength: 'Nickname must be 1 to 40 characters',
      },

      offline: {
        banner: 'Offline mode: server or network unavailable',
        title: 'You are offline',
        detail: "Can't reach the server, so local data is all you get for now. AI, email and place search come back once you are online again.",
        error: "Can't reach the server — check your connection and try again",
        action: 'Retry',
        retrying: 'Reconnecting…',
        online: 'Back online',
      },

      setup: {
        title: 'Connect your server',
        sub: 'Start the server on your laptop, then enter its LAN address here.',
        serverLabel: 'Server address',
        submit: 'Save & connect',
        urlError: 'Please enter a valid http:// or https:// address',
        connecting: 'Connecting…',
        connectedToast: 'Connected · {name} v{version}',
        connectFailed: 'Connection failed: {message}',
        hint:
          'Phone and laptop need the same Wi-Fi. You can also run <code>adb reverse tcp:8787 tcp:8787</code> and use <code>http://127.0.0.1:8787</code>.',
      },

      auth: {
        tabLogin: 'Log in',
        tabRegister: 'Sign up',
        emailLabel: 'Email',
        passwordLabel: 'Password',
        confirmLabel: 'Confirm password',
        passwordPlaceholderLogin: 'Your password',
        passwordPlaceholderRegister: 'At least 8 characters',
        confirmPlaceholder: 'Repeat it',
        showPassword: 'Show password',
        hidePassword: 'Hide password',
        noticeVerified: 'Email verified — please log in.',
        noticeInvalidLink: 'The verification link is invalid or expired. Please request a new email.',
        noticeResetDone: 'Password reset — log in with your new password.',
        loginSubmit: 'Log in',
        registerSubmit: 'Sign up & verify email',
        forgot: 'Forgot password?',
        noAccount: 'No account yet?',
        registerLink: 'Create one',
        haveAccount: 'Already have an account?',
        loginLink: 'Log in',
        errEmail: 'Please enter your email',
        errEmailInvalid: 'Please enter a valid email address',
        errPassword: 'Please enter your password',
        errPasswordLength: 'Password needs at least 8 characters',
        errConfirm: "The two passwords don't match",
        busyLogin: 'Logging in…',
        busyRegister: 'Signing up…',
        welcome: 'Welcome back',
        verifyFirst: 'Please verify your email first',
        mailSentToast: 'Verification email sent — please check your inbox',
        tagline: 'Take a little red panda along.',
      },

      pending: {
        title: 'Verify your email',
        yourEmail: 'your inbox',
        body: "We've sent a verification email to {email}. Tap the link in the email to activate your account; the link is valid for 24 hours.",
        resend: 'Resend verification email',
        backLogin: 'Back to login',
        hint: "No email? Check the spam folder, or double-check the address.",
        sending: 'Sending…',
        resendHint: 'If you do not receive it, tap Resend verification email.',
      },

      forgot: {
        title: 'Reset password',
        sub: "Enter your registered email and we'll send you a reset link.",
        submit: 'Send reset email',
        sentFallback: 'If that address is registered, the reset email is on its way',
        sent: 'Password reset email sent',
        sentTo: 'Password reset email sent to {email}',
        expires: 'Open the link in the email within 24 hours. It expires at {date}.',
        notReceived: 'If it does not arrive, tap Resend email.',
        resend: 'Resend reset email',
        sending: 'Sending…',
      },

      reset: {
        invalidTitle: 'Invalid reset link',
        invalidBody: 'This link is missing its token. Please request a new reset email.',
        reapply: 'Request again',
        title: 'Set a new password',
        sub: 'After changing it, every device has to log in again.',
        newPasswordLabel: 'New password',
        confirmLabel: 'Confirm new password',
        save: 'Save new password',
        savedToast: 'Password reset — please log in again',
      },

      home: {
        greeting: 'Hello, {name}',
        title: 'Vast mountains, far rivers —<br />your journey starts here.',
        sub: 'Go boldly explore your world.',
        createTitle: 'New journey',
        createSub: 'Record a new adventure',
        currentTitle: 'Current trip',
        emptyTitle: 'No trip yet',
        emptySub: 'Tell me where you want to go',
        listTitle: 'My journeys',
        listSub: "Revisit the roads you've walked",
        countText: '<b id="journey-count">—</b> journeys recorded',
        logout: 'Log out',
      },

      new: {
        title: 'A new journey',
        errName: 'Give your journey a name first',
      },

      ai: {
        rewrite: '✦ Rewrite with AI',
        rewriteHint: 'Replaces the current description',
        busy: 'Writing…',
        done: 'AI wrote a draft — feel free to edit it',
        mock: 'Sample description generated (server is in mock mode)',
      },

      plan: {
        placeholders: [
          'I want to visit the Acropolis',
          'Louvre and the Musée de l’Orangerie next week',
          'To see the snow at Neuschwanstein Castle',
        ],
        artAlt: ['The Acropolis at dusk', 'The Louvre at twilight', 'Neuschwanstein in the snow'],
        confirm: "Let's go with that",
        thinking: 'Thinking…',
        edit: 'Edit',
        resend: 'Resend',
        editTip: 'Edit it and confirm again when you are ready.',
        title: 'Trip plan',
        sub: 'The model picks out places worth traveling to from your idea.',
        fieldDestination: 'Destination',
        fieldDepart: 'Departure',
        fieldReturn: 'Return',
        planEmpty: "It didn't find a place worth traveling to this time.",
        editItem: 'Edit stop',
        editItemSub: 'Make your changes, then confirm.',
        saveItem: 'Save changes',
        create: 'Create journey',
        save: 'Save it',
        savedToast: 'Journey saved',
      },

      journeys: {
        title: 'My journeys',
        loading: 'Loading…',
        count: '{n} journeys',
        emptyTitle: 'No journeys yet.',
        emptySub: 'Start with one small step.',
        noDesc: 'No description yet',
        loadFailed: "Couldn't load",
      },

      detail: {
        topbar: 'Journey',
        noDesc: 'This journey has no description yet.',
        edit: 'Edit journey',
        editAria: 'Edit',
        delete: 'Delete',
      },

      edit: {
        title: 'Edit journey',
        sub: 'Take your time with the name and description.',
        save: 'Save changes',
        errName: "Journey name can't be empty",
      },

      journey: {
        createdToast: 'Journey created',
        deletedToast: 'Journey deleted',
        savedToast: 'Saved',
        deleteConfirm: 'Delete "{name}"? This can\'t be undone.',
      },

      busy: {
        saving: 'Saving…',
        sending: 'Sending…',
        updating: 'Updating…',
      },

      field: {
        name: 'Name',
        desc: 'Description',
      },

      settings: {
        title: 'Settings',
        serverTitle: 'Server',
        serverSub: 'The Android app and the web app share the same server.',
        serverLabel: 'Server address',
        testSubmit: 'Save & test connection',
        publicSub: 'Log in to create and view your journeys.',
        goLogin: 'Log in',
        accountTitle: 'Account',
        email: 'Email',
        displayName: 'Display name',
        createdAt: 'Registered',
        passwordTitle: 'Change password',
        passwordSub: 'Other devices will be signed out afterwards.',
        currentPassword: 'Current password',
        currentPlaceholder: 'Your current password',
        updatePassword: 'Update password',
        errCurrent: 'Please enter your current password',
        errNewLength: 'New password needs at least 8 characters',
        errNewConfirm: "The two new passwords don't match",
        updatedOk: 'Password updated; other devices were signed out.',
        updatedToast: 'Password updated',
        languageTitle: 'Language',
        originTitle: 'Usual departure place',
        originName: 'Name',
        originCountry: 'Country / region',
        originProvince: 'State / province',
        originCity: 'City',
        originDistrict: 'District / county',
        originTownship: 'Township / subdistrict',
        originStreet: 'Street',
        originStreetNumber: 'Street number',
        originSave: 'Save departure place',
        originSaved: 'Departure place saved',
        originInput: 'Enter a place, e.g. “88 Zhangjiang Road, Pudong, Shanghai”',
        originAdd: 'Add place',
        originMap: 'Pick on map', originMapHint: 'Click the map or drag the pin to choose a place', originMapUse: 'Use this place', originEmpty: 'No saved places yet',
        originEdit: 'Edit', originUpdate: 'Save changes', originCancel: 'Cancel edit', originLocate: 'Locate me', originSearching: 'Searching places…', originNoResults: 'No places found', originSearchAttribution: 'Place data © OpenStreetMap contributors', originLocationError: 'Could not get your location. Check location permission.',
        originSecureRequired: 'Web location requires HTTPS. Open this page securely or use the Android app.',
        resetPassword: 'Forgot password',
        resetPasswordSub: 'Use the button below to send a password reset email to your account address.',
        aboutTitle: 'About',
        aboutBody: 'Red Panda · 小熊猫 {version}',
        aboutData: 'Your data lives on your own server.',
        connectedOk: 'Connected · {name} v{version}',
        serverChangedToast: 'Server changed — please log in again',
        accountSecurity: 'Account & security',
        dataBackup: 'Data & backup',
        accountInfo: 'Account information',
        newEmail: 'New email address',
        newEmailPlaceholder: 'Enter a new email address',
        sendVerificationEmail: 'Send verification email',
        close: 'Close',
        verificationSentTo: 'Verification email sent to',
        verificationHint: 'Open the verification link sent to this address. After verifying, return here and pull down to refresh your email address. It expires at {date}.',
        verificationNote: 'Your current email remains active until verified. After 24 hours the link and pending address expire.',
        emailUpdated: 'Email updated',
        emailUpdatedBody: 'Your new email has been verified and now replaces the previous address on your account.',
        emailUpdatedShort: 'The verified address is now your account email.',
        returnToApp: 'Return to Red Panda to sync your account details.',
        goSignIn: 'Go to sign in',
        dataSub: 'Review local storage and manage portable backups.',
        openDatabase: 'Open database',
        errEmailEmpty: 'Enter a new email address',
        emailSentToast: 'Verification email sent. Verify within 24 hours',
        emailCancelledToast: 'Email unchanged; pending address cancelled',
        emailResentToast: 'Verification email resent. Verify within 24 hours',
      },

      me: {
        footprints: 'My footprints',
        destinations: '{n} destinations',
        worldFootprints: 'World map footprints',
        footprintsSub: 'Your journeys, marked on the map',
        editNickname: 'Edit nickname',
        nicknameEmpty: 'Nickname cannot be empty',
        nicknameSaved: 'Nickname saved',
      },

      account: {
        updated: 'Account information updated',
        upToDate: 'Account information is up to date',
        pullRefresh: 'Release to refresh account information',
        refreshing: 'Refreshing account information…',
        refreshed: 'Account information refreshed',
      },

      backup: {
        title: 'Database',
        journeys: 'Journeys',
        memories: 'Memory entries',
        media: 'Photos and videos',
        preferences: 'Preferences',
        records: 'Records',
        estimatedTotal: 'Estimated total',
        types: 'Types',
        items: 'items',
        exportData: 'Export',
        chooseFile: 'Import',
        details: 'Data details',
        byCount: 'By count',
        bySize: 'By size',
        sizeNote: 'Sizes are estimates; media uses file sizes.',
        exportCancelled: 'Export cancelled',
        exportingJourneys: 'Exporting journeys ({done}/{total})…',
        journeysExported: 'Journeys complete ({n}). Processing memories…',
        memoriesExporting: 'Memories {i}/{n}; media {done}/{total} exported…',
        exportingMemories: 'Exporting memories {i}/{n}…',
        mediaExported: 'Media complete ({n}). Writing preferences ({s})…',
        compressing: 'Compressing backup…',
        exportSuccess: 'All data exported successfully',
        journeyUnit: 'journeys',
        memoryUnit: 'memories',
        mediaUnit: 'media',
        settingUnit: 'settings',
        packagedChoose: 'Data packaged; choose a save location…',
        exportFailed: 'Export failed',
        downloadStarted: 'Download started: {file} ({size}). Check your downloads list to confirm it was saved.',
        importConfirm: 'Import will merge the backup: new records are added, changed records with matching IDs are updated, and identical records are skipped. Continue?',
        readingFile: 'Reading {file}…',
        decompressing: 'Decompressing and checking backup…',
        notBackup: 'This file is not a Red Panda backup',
        unsupportedVersion: 'Unsupported data version: {version}',
        incomplete: 'The backup is incomplete',
        journeysRead: 'Journeys: read {n} records.',
        readingMemories: 'Reading memories {i}/{n}…',
        readingMedia: 'Reading photos/videos {done}/{total}…',
        mediaRead: 'Media: read {c}; preferences: {s}. Comparing with local data…',
        comparing: 'Comparison complete; merging settings and data…',
        mergeComplete: 'Import merge complete:\n{results}',
        stats: '{label}: {old} existing, {added} added, {identical} identical, {updated} updated',
        statsJourney: 'Journeys',
        statsMemory: 'Memories',
        statsMedia: 'Media',
        statsSettings: 'Settings',
        selectedFile: 'Selected file',
        imported: 'Data imported',
        importCancelled: 'Import cancelled',
        importFailed: 'Import failed',
      },

      logout: {
        toast: 'Logged out',
      },
    },

    de: {
      langName: 'Deutsch',
      documentLang: 'de',
      documentTitle: 'Red Panda · 小熊猫',
      dateLocale: 'de-DE',

      brand: {
        name: 'Red Panda',
        alt: 'Red Panda',
        big: 'Roter Panda',
      },
      common: {
        back: 'Zurück',
        pleaseWait: 'Einen Moment…',
        retry: 'Erneut versuchen',
      },
      loading: 'Red Panda wird geöffnet…',
      lang: {
        label: 'Sprache',
      },
      nav: {
        current: 'Reisen',
        memories: 'Erinnerungen',
        discover: 'Entdecken',
        discoverSoon: 'Weitere Ziele sind unterwegs — bald verfügbar',
        me: 'Ich',
      },

      trip: {
        ongoing: 'Läuft',
        upcoming: 'Demnächst',
        ended: 'Beendet',
        infoTitle: 'Reise-Infos',
        weather: 'Wetter',
        traffic: 'Verkehr',
        filesTitle: 'Dateien',
        ticket: 'Eintrittskarten',
        trainTicket: 'Fahrkarten',
        soon: 'Demnächst',
        soonHint: 'Wetter, Verkehr und Tickets kommen noch — bis dahin reicht die Reise selbst.',
        openDetail: 'Reise ansehen',
        allJourneys: 'Alle Reisen',
        emptyTitle: 'Noch keine Reise',
        emptySub: 'Sag mir, wohin es gehen soll',
        otherTitle: 'Weitere Reisen',
      },

      memories: {
        title: 'Erinnerungen',
        sub: 'Füge Fotos, Videos und Worte zu einer Reise hinzu — ich schreibe daraus eine Reiseerinnerung.',
        emptyTitle: 'Noch keine Erinnerungen',
        emptySub: 'Wähle eine bereits gemachte Reise und leg los.',
        addTitle: 'Erinnerung schreiben',
        notePlaceholder: 'Was ist an diesem Tag passiert?',
        pick: 'Fotos / Videos',
        save: 'Erinnerung speichern',
        savedToast: 'Erinnerung gespeichert',
        deletedToast: 'Erinnerung gelöscht',
        deleteConfirm: 'Diese Erinnerung löschen?',
        count: '{n} Erinnerungen',
        noCount: 'Noch keine Erinnerungen',
        generate: 'Reiseerinnerung schreiben',
        generating: 'Schreibt…',
        recapTitle: 'Reiseerinnerung',
        share: 'Teilen',
        shareSoon: 'Teilen in Moments, Xiaohongshu und Instagram kommt bald',
        uploadFailed: 'Einige Dateien konnten nicht hochgeladen werden',
        needContent: 'Schreib etwas oder wähle ein Foto',
        noJourney: 'Noch keine Reise',
      },

      draft: {
        title: 'Entwurf: {time}, {destination}, {created}',
        untimed: 'noch keine Zeit',
        undestined: 'noch kein Ziel',
        expand: 'Entwurf öffnen',
        delete: 'Diesen Entwurf löschen',
        none: 'Keine Entwürfe',
        previewEmpty: 'Noch keine Reise geplant',
      },

      api: {
        noServer: 'Gib zuerst eine Serveradresse ein',
        timeout: 'Zeitüberschreitung – bitte erneut versuchen',
        networkToast: 'Server nicht erreichbar – Netzwerk prüfen',
        network: 'Server nicht erreichbar. Prüfe Netzwerk und Serveradresse',
        sessionExpired: 'Sitzung abgelaufen – bitte neu anmelden',
        requestFailed: 'Anfrage fehlgeschlagen ({status})',
        pingUnreachable: 'Diese Adresse ist nicht erreichbar',
        pingHttp: 'Server antwortete mit HTTP {status}',
        pingNotServer: 'Diese Adresse ist kein Red Panda Server',

        invalid_credentials: 'E-Mail oder Passwort ist falsch',
        email_taken: 'Diese E-Mail ist bereits registriert',
        email_not_verified:
          'E-Mail noch nicht bestätigt – schau nach der Aktivierungs-E-Mail in deinem Postfach',
        rate_limited: 'Zu viele Versuche – in zehn Minuten nochmal',
        mail_failed: 'E-Mail konnte nicht gesendet werden – später erneut versuchen',
        invalid_reset_token: 'Reset-Link ungültig oder abgelaufen – bitte neu anfordern',
        invalid_password: 'Aktuelles Passwort ist falsch',
        unauthorized: 'Sitzung abgelaufen – bitte neu anmelden',
        validation_error: 'Ungültige Eingabe',
        payload_too_large: 'Anfrage zu groß',
        bad_json: 'Fehlerhaftes JSON',
        not_found: 'Nicht gefunden',
        internal_error: 'Interner Serverfehler',
        ai_invalid_json: 'Die KI hat eine unerwartete Antwort zurückgegeben',
        journeyNotFound: 'Reise nicht gefunden',
        memoryNotFound: 'Erinnerung nicht gefunden',
        memoryEmpty: 'Datei ist leer',
        validationEmpty: 'Schreib etwas oder wähle eine Reise',
        nicknameLength: 'Der Spitzname muss 1 bis 40 Zeichen lang sein',
      },

      offline: {
        banner: 'Offline-Modus: Server oder Netzwerk nicht erreichbar',
        title: 'Du bist offline',
        detail:
          'Der Server ist nicht erreichbar, vorerst gibt es nur lokale Daten. KI, E-Mail und Ortssuche sind wieder da, sobald du online bist.',
        error: 'Server nicht erreichbar – bitte Netzwerk prüfen und erneut versuchen',
        action: 'Erneut',
        retrying: 'Verbindung wird wiederhergestellt…',
        online: 'Wieder online',
      },

      setup: {
        title: 'Mit deinem Server verbinden',
        sub: 'Starte den Server auf dem Laptop und gib hier seine LAN-Adresse ein.',
        serverLabel: 'Serveradresse',
        submit: 'Speichern & verbinden',
        urlError: 'Bitte gib eine gültige http://- oder https://-Adresse ein',
        connecting: 'Verbinde…',
        connectedToast: 'Verbunden · {name} v{version}',
        connectFailed: 'Verbindung fehlgeschlagen: {message}',
        hint:
          'Handy und Laptop brauchen dasselbe WLAN. Du kannst auch <code>adb reverse tcp:8787 tcp:8787</code> ausführen und <code>http://127.0.0.1:8787</code> verwenden.',
      },

      auth: {
        tabLogin: 'Anmelden',
        tabRegister: 'Registrieren',
        emailLabel: 'E-Mail',
        passwordLabel: 'Passwort',
        confirmLabel: 'Passwort bestätigen',
        passwordPlaceholderLogin: 'Dein Passwort',
        passwordPlaceholderRegister: 'Mindestens 8 Zeichen',
        confirmPlaceholder: 'Bitte wiederholen',
        showPassword: 'Passwort anzeigen',
        hidePassword: 'Passwort verbergen',
        noticeVerified: 'E-Mail bestätigt – bitte anmelden.',
        noticeInvalidLink:
          'Der Bestätigungslink ist ungültig oder abgelaufen. Bitte fordere eine neue E-Mail an.',
        noticeResetDone: 'Passwort zurückgesetzt – melde dich mit dem neuen Passwort an.',
        loginSubmit: 'Anmelden',
        registerSubmit: 'Registrieren & E-Mail bestätigen',
        forgot: 'Passwort vergessen?',
        noAccount: 'Noch kein Konto?',
        registerLink: 'Konto erstellen',
        haveAccount: 'Schon ein Konto?',
        loginLink: 'Anmelden',
        errEmail: 'Bitte gib deine E-Mail-Adresse ein',
        errEmailInvalid: 'Bitte gib eine gültige E-Mail-Adresse ein',
        errPassword: 'Bitte gib dein Passwort ein',
        errPasswordLength: 'Das Passwort braucht mindestens 8 Zeichen',
        errConfirm: 'Die Passwörter stimmen nicht überein',
        busyLogin: 'Melde an…',
        busyRegister: 'Registriere…',
        welcome: 'Willkommen zurück',
        verifyFirst: 'Bitte bestätige zuerst deine E-Mail',
        mailSentToast: 'Bestätigungs-E-Mail gesendet – bitte Postfach prüfen',
        tagline: 'Nimm einen kleinen Roten Panda mit.',
      },

      pending: {
        title: 'E-Mail bestätigen',
        yourEmail: 'dein Postfach',
        body: 'Wir haben eine Bestätigungs-E-Mail an {email} geschickt. Tippe in der E-Mail auf den Link, um dein Konto zu aktivieren. Er ist 24 Stunden gültig.',
        resend: 'Bestätigungs-E-Mail erneut senden',
        backLogin: 'Zur Anmeldung',
        hint: 'Keine E-Mail erhalten? Prüfe den Spam-Ordner und die Adresse.',
        sending: 'Sende…',
        resendHint: 'Falls sie nicht ankommt, tippe auf „Bestätigungs-E-Mail erneut senden“.',
      },

      forgot: {
        title: 'Passwort zurücksetzen',
        sub: 'Gib deine registrierte E-Mail-Adresse ein und wir senden dir einen Reset-Link.',
        submit: 'Reset-E-Mail senden',
        sentFallback: 'Falls die Adresse registriert ist, ist die Reset-E-Mail unterwegs',
        sent: 'E-Mail zum Zurücksetzen des Passworts wurde gesendet',
        sentTo: 'E-Mail zum Zurücksetzen gesendet an {email}',
        expires: 'Öffne den Link in der E-Mail innerhalb von 24 Stunden. Er ist gültig bis {date}.',
        notReceived: 'Falls sie nicht ankommt, tippe auf „Erneut senden“.',
        resend: 'Reset-E-Mail erneut senden',
        sending: 'Wird gesendet…',
      },

      reset: {
        invalidTitle: 'Ungültiger Reset-Link',
        invalidBody: 'In diesem Link fehlt der Token. Bitte fordere eine neue Reset-E-Mail an.',
        reapply: 'Neu anfordern',
        title: 'Neues Passwort festlegen',
        sub: 'Danach müssen sich alle Geräte neu anmelden.',
        newPasswordLabel: 'Neues Passwort',
        confirmLabel: 'Neues Passwort bestätigen',
        save: 'Neues Passwort speichern',
        savedToast: 'Passwort zurückgesetzt – bitte neu anmelden',
      },

      home: {
        greeting: 'Hallo, {name}',
        title: 'Weite Berge, ferne Flüsse –<br />hier beginnt deine Reise.',
        sub: 'Wage mutig deine Welt.',
        createTitle: 'Neue Reise',
        createSub: 'Ein neues Abenteuer festhalten',
        currentTitle: 'Aktuelle Reise',
        emptyTitle: 'Noch keine Reise',
        emptySub: 'Sag mir, wohin es gehen soll',
        listTitle: 'Meine Reisen',
        listSub: 'Blätter durch deine Wege',
        countText: '<b id="journey-count">—</b> Reisen festgehalten',
        logout: 'Abmelden',
      },

      new: {
        title: 'Eine neue Reise',
        errName: 'Gib der Reise zuerst einen Namen',
      },

      ai: {
        rewrite: '✦ Mit KI neu schreiben',
        rewriteHint: 'Ersetzt die aktuelle Beschreibung',
        busy: 'Schreibt…',
        done: 'Die KI ist fertig – du kannst es anpassen',
        mock: 'Beispieltext erzeugt (Server im Mock-Modus)',
      },

      plan: {
        placeholders: [
          'Ich will die Akropolis besuchen',
          'Louvre und Orangemuseum nächste Woche',
          'Um den Schnee am Neuschwanstein zu sehen',
        ],
        artAlt: ['Die Akropolis in der Dämmerung', 'Der Louvre im Abendlicht', 'Neuschwanstein im Schnee'],
        confirm: 'So machen wir’s',
        thinking: 'Ich überlege…',
        edit: 'Bearbeiten',
        resend: 'Erneut senden',
        editTip: 'Ändere es und bestätige dann erneut.',
        title: 'Reiseplan',
        sub: 'Das Modell schlägt Orte vor, die sich lohnen.',
        fieldDestination: 'Ziel',
        fieldDepart: 'Abreise',
        fieldReturn: 'Rückkehr',
        planEmpty: 'Diesmal hat es keinen passenden Ziel gefunden.',
        editItem: 'Stopp bearbeiten',
        editItemSub: 'Änderungen übernehmen, dann bestätigen.',
        saveItem: 'Änderungen speichern',
        create: 'Reise erstellen',
        save: 'Speichern',
        savedToast: 'Reise gespeichert',
      },

      journeys: {
        title: 'Meine Reisen',
        loading: 'Lade…',
        count: '{n} Reisen',
        emptyTitle: 'Noch keine Reisen.',
        emptySub: 'Fang mit einem kleinen Schritt an.',
        noDesc: 'Noch keine Beschreibung',
        loadFailed: 'Laden fehlgeschlagen',
      },

      detail: {
        topbar: 'Reise',
        noDesc: 'Diese Reise hat noch keine Beschreibung.',
        edit: 'Reise bearbeiten',
        editAria: 'Bearbeiten',
        delete: 'Löschen',
      },

      edit: {
        title: 'Reise bearbeiten',
        sub: 'Name und Beschreibung kannst du in Ruhe ändern.',
        save: 'Änderungen speichern',
        errName: 'Der Name darf nicht leer sein',
      },

      journey: {
        createdToast: 'Reise erstellt',
        deletedToast: 'Reise gelöscht',
        savedToast: 'Gespeichert',
        deleteConfirm: '„{name}“ wirklich löschen? Das kann nicht rückgängig gemacht werden.',
      },

      busy: {
        saving: 'Speichere…',
        sending: 'Sende…',
        updating: 'Aktualisiere…',
      },

      field: {
        name: 'Name',
        desc: 'Beschreibung',
      },

      settings: {
        title: 'Einstellungen',
        serverTitle: 'Server',
        serverSub: 'Die Android-App und die Web-App nutzen denselben Server.',
        serverLabel: 'Serveradresse',
        testSubmit: 'Speichern & Verbindung testen',
        publicSub: 'Melde dich an, um Reisen zu erstellen und anzusehen.',
        goLogin: 'Anmelden',
        accountTitle: 'Konto',
        email: 'E-Mail',
        displayName: 'Anzeigename',
        createdAt: 'Registriert am',
        passwordTitle: 'Passwort ändern',
        passwordSub: 'Andere Geräte werden danach abgemeldet.',
        currentPassword: 'Aktuelles Passwort',
        currentPlaceholder: 'Dein aktuelles Passwort',
        updatePassword: 'Passwort aktualisieren',
        errCurrent: 'Bitte gib dein aktuelles Passwort ein',
        errNewLength: 'Das neue Passwort braucht mindestens 8 Zeichen',
        errNewConfirm: 'Die neuen Passwörter stimmen nicht überein',
        updatedOk: 'Passwort aktualisiert; andere Geräte wurden abgemeldet.',
        updatedToast: 'Passwort aktualisiert',
        languageTitle: 'Sprache',
        originTitle: 'Üblicher Abfahrtsort',
        originName: 'Name',
        originCountry: 'Land / Region',
        originProvince: 'Bundesland / Provinz',
        originCity: 'Stadt',
        originDistrict: 'Bezirk / Landkreis',
        originTownship: 'Gemeinde / Ortsteil',
        originStreet: 'Straße',
        originStreetNumber: 'Hausnummer',
        originSave: 'Abfahrtsort speichern',
        originSaved: 'Abfahrtsort gespeichert',
        originInput: 'Ort eingeben, z. B. „Zhangjiang-Straße 88, Shanghai“',
        originAdd: 'Ort hinzufügen',
        originMap: 'Auf Karte wählen', originMapHint: 'Karte anklicken oder Markierung ziehen', originMapUse: 'Diesen Ort verwenden', originEmpty: 'Noch keine gespeicherten Orte',
        originEdit: 'Bearbeiten', originUpdate: 'Änderungen speichern', originCancel: 'Bearbeitung abbrechen', originLocate: 'Mein Standort', originSearching: 'Orte werden gesucht…', originNoResults: 'Keine Orte gefunden', originSearchAttribution: 'Ortsdaten © OpenStreetMap contributors', originLocationError: 'Standort nicht verfügbar. Bitte Standortberechtigung prüfen.',
        originSecureRequired: 'Der Web-Standort benötigt HTTPS. Öffne die Seite sicher oder nutze die Android-App.',
        accountSecurity: 'Konto & Sicherheit',
        dataBackup: 'Daten & Sicherung',
        accountInfo: 'Kontoinformationen',
        newEmail: 'Neue E-Mail-Adresse',
        newEmailPlaceholder: 'Neue E-Mail-Adresse eingeben',
        sendVerificationEmail: 'Bestätigungs-E-Mail senden',
        close: 'Schließen',
        verificationSentTo: 'Bestätigungs-E-Mail gesendet an',
        verificationHint: 'Öffne den Bestätigungslink in der neuen E-Mail. Kehre danach hierher zurück und ziehe die Seite nach unten, um die Adresse zu aktualisieren. Der Link ist gültig bis {date}.',
        verificationNote: 'Bis zur Bestätigung bleibt die aktuelle E-Mail aktiv. Nach 24 Stunden verfällt der Link und die neue Adresse wird nicht mehr angezeigt.',
        emailUpdated: 'E-Mail aktualisiert',
        emailUpdatedBody: 'Deine neue E-Mail wurde bestätigt und ersetzt jetzt die bisherige Adresse deines Kontos.',
        emailUpdatedShort: 'Die bestätigte Adresse ist jetzt deine Konto-E-Mail.',
        returnToApp: 'Kehre zu Red Panda zurück, um deine Kontodaten zu synchronisieren.',
        goSignIn: 'Zur Anmeldung',
        dataSub: 'Prüfe den lokalen Speicher und verwalte plattformübergreifende Sicherungen.',
        openDatabase: 'Datenbank öffnen',
        errEmailEmpty: 'Bitte gib eine neue E-Mail-Adresse ein',
        emailSentToast: 'Bestätigungs-E-Mail gesendet – bitte innerhalb von 24 Stunden bestätigen',
        emailCancelledToast: 'E-Mail unverändert; ausstehende Adresse verworfen',
        emailResentToast: 'Bestätigungs-E-Mail erneut gesendet – bitte innerhalb von 24 Stunden bestätigen',
        resetPassword: 'Passwort vergessen',
        resetPasswordSub: 'Mit der Schaltfläche unten senden wir einen Link an deine Konto-E-Mail-Adresse.',
        aboutTitle: 'Über',
        aboutBody: 'Red Panda · 小熊猫 {version}',
        aboutData: 'Deine Daten liegen auf deinem eigenen Server.',
        connectedOk: 'Verbunden · {name} v{version}',
        serverChangedToast: 'Server gewechselt – bitte neu anmelden',
      },

      me: {
        footprints: 'Meine Spuren',
        destinations: '{n} Ziele',
        worldFootprints: 'Weltkarte der Spuren',
        footprintsSub: 'Reisen festhalten, besuchte Orte erleuchten',
        editNickname: 'Spitznamen bearbeiten',
        nicknameEmpty: 'Der Spitzname darf nicht leer sein',
        nicknameSaved: 'Spitzname gespeichert',
      },

      account: {
        updated: 'Kontodaten aktualisiert',
        upToDate: 'Kontodaten sind aktuell',
        pullRefresh: 'Loslassen, um Kontodaten zu aktualisieren',
        refreshing: 'Kontodaten werden aktualisiert…',
        refreshed: 'Kontodaten aktualisiert',
      },

      backup: {
        title: 'Datenbank',
        journeys: 'Reisen',
        memories: 'Erinnerungstexte',
        media: 'Fotos und Videos',
        preferences: 'Einstellungen',
        records: 'Einträge',
        estimatedTotal: 'Geschätzte Gesamtgröße',
        types: 'Datentypen',
        items: 'Einträge',
        exportData: 'Exportieren',
        chooseFile: 'Importieren',
        details: 'Datenübersicht',
        byCount: 'Nach Anzahl',
        bySize: 'Nach Größe',
        sizeNote: 'Größen sind Schätzwerte; Medien zählen nach Dateigröße.',
        exportCancelled: 'Export abgebrochen',
        exportingJourneys: 'Reisen werden exportiert ({done}/{total})…',
        journeysExported: 'Reisen exportiert ({n}). Erinnerungen werden verarbeitet…',
        memoriesExporting: 'Erinnerungen {i}/{n}; Medien {done}/{total} exportiert…',
        exportingMemories: 'Erinnerungen werden exportiert ({i}/{n})…',
        mediaExported: 'Medien exportiert ({n}). Einstellungen werden geschrieben ({s})…',
        compressing: 'Sicherung wird komprimiert…',
        exportSuccess: 'Alle Daten erfolgreich exportiert',
        journeyUnit: 'Reisen',
        memoryUnit: 'Erinnerungen',
        mediaUnit: 'Medien',
        settingUnit: 'Einstellungen',
        packagedChoose: 'Daten paketiert; Speicherort wählen…',
        exportFailed: 'Export fehlgeschlagen',
        downloadStarted: 'Download gestartet: {file} ({size}). Prüfe die Downloadliste, ob die Datei gespeichert wurde.',
        importConfirm: 'Beim Import wird die Sicherung zusammengeführt: Neue Einträge kommen hinzu, geänderte Einträge mit gleicher ID werden aktualisiert, identische Einträge übersprungen. Fortfahren?',
        readingFile: '{file} wird gelesen…',
        decompressing: 'Sicherung wird entpackt und geprüft…',
        notBackup: 'Die Datei ist keine Red-Panda-Sicherung',
        unsupportedVersion: 'Nicht unterstützte Datenversion: {version}',
        incomplete: 'Die Sicherung ist unvollständig',
        journeysRead: 'Reisen: {n} Einträge gelesen.',
        readingMemories: 'Erinnerungen werden gelesen ({i}/{n})…',
        readingMedia: 'Fotos/Videos werden gelesen ({done}/{total})…',
        mediaRead: 'Medien: {c} gelesen; Einstellungen: {s}. Vergleich mit lokalen Daten…',
        comparing: 'Vergleich abgeschlossen; Einstellungen und Daten werden zusammengeführt…',
        mergeComplete: 'Import abgeschlossen:\n{results}',
        stats: '{label}: vorher {old}, neu {added}, identisch {identical}, aktualisiert {updated}',
        statsJourney: 'Reisen',
        statsMemory: 'Erinnerungen',
        statsMedia: 'Medien',
        statsSettings: 'Einstellungen',
        selectedFile: 'Ausgewählte Datei',
        imported: 'Daten importiert',
        importCancelled: 'Import abgebrochen',
        importFailed: 'Import fehlgeschlagen',
      },

      logout: {
        toast: 'Abgemeldet',
      },
    },
  };

  const LOCALE_KEYS = ['zh', 'en', 'de'];
  let currentLocale = null;

  function resolveKey(dict, key) {
    return key.split('.').reduce((acc, part) => {
      if (acc && acc[part] !== undefined) return acc[part];
      return undefined;
    }, dict);
  }

  function normalizeLocaleTag(tag) {
    const text = String(tag ?? '').trim().toLowerCase();
    if (LOCALE_KEYS.includes(text)) return text;
    if (/^zh\b|^zh[-_]/.test(text)) return 'zh';
    if (/^en\b|^en[-_]/.test(text)) return 'en';
    if (/^de\b|^de[-_]/.test(text)) return 'de';
    return '';
  }

  function detectLocale() {
    const saved = normalizeLocaleTag(localStorage.getItem(STORAGE.lang));
    if (saved) return saved;
    for (const tag of navigator.languages || [navigator.language]) {
      const match = normalizeLocaleTag(tag);
      if (match) return match;
    }
    // Unknown system languages fall back to English.
    return 'en';
  }

  function getLocale() {
    if (!currentLocale) currentLocale = detectLocale();
    return currentLocale;
  }

  function applyDocumentLocale() {
    const dict = I18N[getLocale()] || I18N.zh;
    document.documentElement.lang = dict.documentLang;
    document.title = dict.documentTitle;
  }

  function setLocale(locale) {
    if (!LOCALE_KEYS.includes(locale) || locale === getLocale()) return;
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    const focusedLang = document.activeElement?.dataset?.lang || '';
    currentLocale = locale;
    localStorage.setItem(STORAGE.lang, locale);
    applyDocumentLocale();
    if (state.token && state.user) {
      state.user = { ...state.user, locale };
      cacheUser(state.user);
      api('/api/me/locale', { method: 'PUT', body: { locale } }).catch(() => {});
    }
    // 语言切换只是换一套文案，不需要播放页面入场动画，也不应该丢失滚动位置。
    render({ animate: false });
    window.scrollTo(scrollX, scrollY);
    if (focusedLang) {
      app.querySelector(`[data-lang="${focusedLang}"]`)?.focus({ preventScroll: true });
    }
  }

  function t(key, vars = {}) {
    const dict = I18N[getLocale()] || I18N.zh;
    let text = resolveKey(dict, key);
    if (text === undefined) text = resolveKey(I18N.zh, key);
    if (text === undefined || typeof text === 'object') text = key;
    for (const [name, value] of Object.entries(vars)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
    return text;
  }

  function languageSwitcher() {
    const active = getLocale();
    return `
      <div class="language-choice-list" role="radiogroup" aria-label="${t('lang.label')}">
        ${LOCALE_KEYS.map((key) => `<button type="button" class="language-choice${key === active ? ' is-selected' : ''}" data-lang="${key}" role="radio" aria-checked="${key === active}"><span class="language-choice-name">${I18N[key].langName}</span><span class="language-radio" aria-hidden="true"></span></button>`).join('')}
      </div>`;
  }

  function authLanguageSwitcher() {
    const active = getLocale();
    return `<div class="lang-switch auth-language-switch" role="group" aria-label="${t('lang.label')}">${LOCALE_KEYS.map((key) => `<button type="button" class="lang-opt${key === active ? ' active' : ''}" data-lang="${key}" aria-pressed="${key === active}">${I18N[key].langName}</button>`).join('')}</div>`;
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
    return date.toLocaleString(I18N[getLocale()].dateLocale, {
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
    return date.toLocaleDateString(I18N[getLocale()].dateLocale, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
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
    const configured = normalizeServer(window.REDPANDA_CONFIG?.defaultServer || '');
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

  function setBusy(button, busy, label = t('common.pleaseWait')) {
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

  /**
   * 四个主页面（行程 / 回忆 / 发现 / 我）共用同一条历史记录，
   * 子页面（详情、编辑、回忆详情…）在这条记录之上叠一层。
   * 这样在主页面上按返回，系统会直接退出应用，而不是回到上一个标签页。
   */
  let historyDepth = 0;
  let pendingTabHash = '';
  let pendingTabAfter = null;

  const TAB_HASHES = ['#/', '#/memories', '#/discover', '#/me'];

  function isTabHash(hash) {
    return TAB_HASHES.includes(String(hash ?? '').split('?')[0]);
  }

  /** 切换主页面：不新增历史记录，返回键依然直接退出应用。 */
  function navigateTab(hash, after = null) {
    pendingTabAfter = after;
    if (historyDepth === 0) {
      if (location.hash === hash) {
        render();
        runPendingTabAfter();
      } else if (replaceHash(hash)) {
        render();
        runPendingTabAfter();
      } else {
        // 极少数环境不允许改写历史，退回普通跳转（会多出一条历史）。
        location.hash = hash;
      }
      return;
    }
    // 先退回主页面那条记录，再把它改成新的标签页。
    pendingTabHash = hash;
    suppressPopCount += 1;
    history.go(-historyDepth);
  }

  /** 改写当前历史条目的地址（不新增条目）。 */
  function replaceHash(hash) {
    try {
      history.replaceState(null, '', hash);
      return true;
    } catch {
      return false;
    }
  }

  /** 主页面切换完成之后，再做一件事（比如接着进入「创建旅程」）。 */
  function runPendingTabAfter() {
    const after = pendingTabAfter;
    pendingTabAfter = null;
    if (typeof after === 'function') after();
  }

  /** 进入子页面：在主页面之上叠一层历史记录。 */
  function navigate(hash) {
    if (location.hash === hash) {
      render();
    } else {
      location.hash = hash;
      historyDepth += 1;
    }
  }

  function goBack() {
    if (historyDepth > 0) {
      history.back();
    } else {
      navigateTab('#/');
    }
  }

  function readCachedUser() {
    try {
      const raw = localStorage.getItem(STORAGE.user);
      if (!raw) return null;
      const user = JSON.parse(raw);
      return user && typeof user === 'object' ? user : null;
    } catch {
      return null;
    }
  }

  function cacheUser(user) {
    if (!user) {
      localStorage.removeItem(STORAGE.user);
      return;
    }
    try {
      localStorage.setItem(STORAGE.user, JSON.stringify(user));
    } catch {
      // Private mode or a full quota should not break login.
    }
  }

  function clearToken() {
    state.token = '';
    state.user = null;
    state.journeys = [];
    state.currentJourney = null;
    localStorage.removeItem(STORAGE.token);
    localStorage.removeItem(STORAGE.user);
  }

  function parseRoute() {
    const raw = location.hash.replace(/^#/, '') || '/';
    const [pathPart, queryPart = ''] = raw.split('?');
    const parts = pathPart.split('/').filter(Boolean);
    const query = {};
    for (const [key, value] of new URLSearchParams(queryPart)) query[key] = value;
    if (parts.length === 0) return { name: 'home', query };
    if (parts[0] === 'journey' && parts[1]) return { name: 'journey', id: parts[1], query };
    if (parts[0] === 'settings' && parts[1]) return { name: 'settings', section: ['security','account'].includes(parts[1]) ? 'account-security' : parts[1], query };
    if (parts[0] === 'memories' && parts[1]) return { name: 'memories', id: parts[1], query };
    return { name: parts[0], query };
  }

  // ---- API ----------------------------------------------------------------

  let lastNetworkToast = 0;

  function localizedApiError(data, status) {
    const code = data?.code;
    if (code) {
      const translated = resolveKey(I18N[getLocale()] || I18N.zh, `api.${code}`);
      if (translated !== undefined) return translated;
    }
    return data?.error || t('api.requestFailed', { status });
  }

  async function api(path, options = {}) {
    const { method = 'GET', body, auth = true, timeout = 30000, raw = false, contentType = '' } = options;
    const pathname = path.split('?')[0];
    if (/^\/api\/(journeys|memories)(\/|$)/.test(pathname) || ['/api/me/profile', '/api/me/locale', '/api/me/usual-origin'].includes(pathname)) {
      const local = await localDataApi(path, options);
      if (local !== null) return local;
    }
    if (!state.server) throw new ApiError(t('api.noServer'), 0, 'no_server');
    // The server is known to be unreachable: fail immediately instead of
    // waiting for the network timeout, and keep retrying in the background.
    if (state.online === false) {
      scheduleReconnect();
      throw new ApiError(t('offline.error'), 0, 'offline');
    }

    const headers = { Accept: 'application/json' };
    if (auth && state.token) headers.Authorization = `Bearer ${state.token}`;
    if (body !== undefined && !raw) headers['Content-Type'] = 'application/json';
    if (raw && contentType) headers['Content-Type'] = contentType;

    let response;
    try {
      response = await fetch(`${state.server}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (error) {
      const timedOut = error.name === 'TimeoutError';
      if (state.ready) {
        if (timedOut) {
          toast(t('api.timeout'), 'error');
        } else if (Date.now() - lastNetworkToast > 4000) {
          lastNetworkToast = Date.now();
          toast(t('api.networkToast'), 'error');
        }
      }
      // The server did not answer: switch to offline mode and keep retrying.
      setOnline(false);
      scheduleReconnect();
      if (timedOut) {
        throw new ApiError(t('api.timeout'), 0, 'timeout');
      }
      throw new ApiError(t('api.network'), 0, 'network');
    }
    // Any answer means the server is reachable, even if it reports an error.
    if (state.online !== true) setOnline(true);

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
        if (state.ready) toast(t('api.sessionExpired'), 'error');
        setTimeout(() => {
          if (state.ready) render();
        }, 0);
      }
      throw new ApiError(localizedApiError(data, response.status), response.status, data?.code);
    }
    return data ?? {};
  }

  let databaseSort='count';
  let databaseStatus={message:'',percent:null,kind:''};
  let databaseSnapshotCache=null;
  function backupStatus(message, percent = null, kind = '') {
    databaseStatus={message,percent,kind};
    const host=document.getElementById('database-status'); if(!host)return;
    host.dataset.kind=kind; host.innerHTML=`<p>${esc(message)}</p>${percent===null?'':`<progress max="100" value="${Math.max(0,Math.min(100,percent))}"></progress><span>${Math.round(percent)}%</span>`}`;
  }
  function byteSize(value){return new TextEncoder().encode(JSON.stringify(value,(_key,item)=>item instanceof Blob?undefined:item).replace(/,"(?:blob|url|data)":(?:null|"[^"]*")/g,'')).length;}
  async function databaseSnapshot(){
    const [journeys,memories,settings]=await Promise.all([storeAll('journeys'),storeAll('memories'),storeAll('settings')]);
    const media=memories.flatMap(m=>m.media||[]);
    const types=[
      {key:'journeys',name:t('backup.journeys'),count:journeys.length,size:byteSize(journeys)},
      {key:'memories',name:t('backup.memories'),count:memories.length,size:byteSize(memories.map(({media,...m})=>m))},
      {key:'media',name:t('backup.media'),count:media.length,size:media.reduce((n,x)=>n+Number(x.blob?.size||x.size||0),0)},
      {key:'settings',name:t('backup.preferences'),count:settings.length,size:byteSize(settings)},
    ];
    return {journeys,memories,settings,types,totalCount:types.reduce((n,x)=>n+x.count,0),totalSize:types.reduce((n,x)=>n+x.size,0)};
  }
  function formatBytes(value){if(value<1024)return`${value} B`;if(value<1048576)return`${(value/1024).toFixed(1)} KB`;return`${(value/1048576).toFixed(1)} MB`;}
  function drawDatabaseSummary(snapshot){
    const summary=document.getElementById('database-summary'); if(!summary)return;
    summary.innerHTML=`<div><span>${t('backup.records')}</span><strong>${snapshot.totalCount}</strong></div><div><span>${t('backup.estimatedTotal')}</span><strong>${formatBytes(snapshot.totalSize)}</strong></div><div><span>${t('backup.types')}</span><strong>${snapshot.types.length}</strong></div>`;
  }
  function drawDatabaseTypes(){
    if(!databaseSnapshotCache)return;
    const rows=databaseSnapshotCache.types.slice().sort((a,b)=>databaseSort==='size'?b.size-a.size:b.count-a.count);
    const list=document.getElementById('database-types'); if(list)list.innerHTML=rows.map(x=>`<div class="database-row"><strong>${esc(x.name)}</strong><span>${x.count} ${t('backup.items')}</span><span>${formatBytes(x.size)}</span></div>`).join('');
    document.querySelectorAll('[data-action^="database-sort-"]').forEach(button=>{const active=button.dataset.action===`database-sort-${databaseSort}`;button.classList.toggle('is-active',active);const arrow=button.querySelector('.database-sort-arrow');if(arrow)arrow.textContent=active?'▼':'';});
  }
  async function refreshDatabaseStats(){databaseSnapshotCache=await databaseSnapshot();drawDatabaseSummary(databaseSnapshotCache);drawDatabaseTypes();}
  async function renderDatabase(){
    app.innerHTML=`<div class="screen settings-screen"><main class="page database-page">
      <div id="database-summary" class="database-summary"><div class="skeleton-block"></div></div>
      <div class="database-actions"><button class="btn ghost" data-action="backup-export">${t('backup.exportData')}</button><label class="btn ghost" for="backup-file">${t('backup.chooseFile')}</label><input id="backup-file" type="file" accept=".rpd,.json,application/json,application/gzip" hidden /></div>
      <div id="database-status" class="backup-status" role="status" aria-live="polite"></div>
      <section class="database-table"><div class="database-table-head"><strong>${t('backup.details')}</strong><div><button class="link subtle" data-action="database-sort-count">${t('backup.byCount')}<span class="database-sort-arrow" aria-hidden="true"></span></button><button class="link subtle" data-action="database-sort-size">${t('backup.bySize')}<span class="database-sort-arrow" aria-hidden="true"></span></button></div></div><div id="database-types"><div class="skeleton-block"></div></div></section>
      <p class="panel-sub">${t('backup.sizeNote')}</p>
    </main></div>`;
    databaseSnapshotCache=await databaseSnapshot();
    drawDatabaseSummary(databaseSnapshotCache);
    drawDatabaseTypes();
    backupStatus(databaseStatus.message,databaseStatus.percent,databaseStatus.kind);
  }
  async function exportBackup() {
    // Invoke the destination picker during the user gesture where supported.
    const clock=new Date(),stamp=`${clock.getFullYear()}${String(clock.getMonth()+1).padStart(2,'0')}${String(clock.getDate()).padStart(2,'0')}${String(clock.getHours()).padStart(2,'0')}${String(clock.getMinutes()).padStart(2,'0')}${String(clock.getSeconds()).padStart(2,'0')}`,filename=`red-panda-backup-${stamp}.rpd`;
    let destination = null;
    const androidSave = typeof window.AndroidBackup?.saveBackup === 'function';
    if (!androidSave && window.showSaveFilePicker) {
      try { destination = await window.showSaveFilePicker({ suggestedName:filename, types:[{description:'Red Panda backup',accept:{'application/gzip':['.rpd']}}] }); }
      catch (error) { if(error.name==='AbortError'){backupStatus(t('backup.exportCancelled'));return;} destination=null; }
    }
    const snapshot=await databaseSnapshot();
    const {journeys,memories,settings}=snapshot;
    const mediaTotal=snapshot.types.find(x=>x.key==='media').count;let mediaDone=0;
    backupStatus(t('backup.exportingJourneys', { done: journeys.length, total: journeys.length }), 8);
    const journeyRecords=journeys.map(x=>({...x}));
    backupStatus(t('backup.journeysExported', { n: journeyRecords.length }), 25);
    const packed=[];
    for(let i=0;i<memories.length;i++){const m=memories[i];const media=[];for(const v of(m.media||[])){media.push({...v,url:undefined,blob:undefined,data:v.blob?await blobToBase64(v.blob):''});mediaDone++;backupStatus(t('backup.memoriesExporting', { i: i+1, n: memories.length, done: mediaDone, total: mediaTotal }),25+(mediaTotal?55*mediaDone/mediaTotal:55));}packed.push({...m,media});if(!media.length)backupStatus(t('backup.exportingMemories', { i: i+1, n: memories.length }),25+(memories.length?55*(i+1)/memories.length:55));}
    backupStatus(t('backup.mediaExported', { n: mediaDone, s: settings.length }),82);
    const data={format:'red-panda-backup',schemaVersion:1,version:1,journeys:journeyRecords,memories:packed,settings:settings.map(x=>({...x}))};
    backupStatus(t('backup.compressing'),85);
    const stream=new Blob([new TextEncoder().encode(JSON.stringify(data))]).stream().pipeThrough(new CompressionStream('gzip'));
    const file=await new Response(stream).blob();
    if(destination){const writer=await destination.createWritable();await writer.write(file);await writer.close();backupStatus(`${t('backup.exportSuccess')} · ${journeyRecords.length} ${t('backup.journeyUnit')} · ${packed.length} ${t('backup.memoryUnit')} · ${mediaDone} ${t('backup.mediaUnit')} · ${settings.length} ${t('backup.settingUnit')} · ${destination.name}`,100,'success');}
    else if(window.AndroidBackup?.saveBackup){backupStatus(t('backup.packagedChoose'),95);const base64=await blobToBase64(file);await new Promise((resolve,reject)=>{window.__backupSaveResult=(ok,message)=>{window.__backupSaveResult=null;if(ok){backupStatus(`${t('backup.exportSuccess')} · ${journeyRecords.length} ${t('backup.journeyUnit')} · ${packed.length} ${t('backup.memoryUnit')} · ${mediaDone} ${t('backup.mediaUnit')} · ${settings.length} ${t('backup.settingUnit')} · ${message}`,100,'success');resolve();}else{backupStatus(`${t('backup.exportFailed')}: ${message}`,null,'error');reject(new Error(message));}};window.AndroidBackup.saveBackup(filename,base64);});}
    else {const a=document.createElement('a');a.href=URL.createObjectURL(file);a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),60000);backupStatus(t('backup.downloadStarted', { file: filename, size: formatBytes(file.size) }),100,'pending');}
  }
  function blobToBase64(blob) { return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result).split(',')[1]);r.onerror=()=>reject(r.error);r.readAsDataURL(blob);}); }
  const BACKUP_IMPORTERS = {
    1: async data => ({journeys:data.journeys,memories:data.memories,settings:data.settings||[]}),
  };
  function stableValue(value){
    if(value instanceof Blob)return {blobSize:value.size,blobType:value.type};
    if(Array.isArray(value))return value.map(stableValue);
    if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).filter(k=>!['blob','data','url'].includes(k)).sort().map(k=>[k,stableValue(value[k])]));
    return value;
  }
  async function blobFingerprint(blob){
    if(!blob)return '';
    const bytes=await blob.arrayBuffer();
    if(crypto.subtle){const hash=await crypto.subtle.digest('SHA-256',bytes);return Array.from(new Uint8Array(hash),x=>x.toString(16).padStart(2,'0')).join('');}
    let hash=2166136261;const view=new Uint8Array(bytes);for(const b of view)hash=Math.imul(hash^b,16777619);
    return `${(hash>>>0).toString(16)}:${blob.size}:${blob.type}`;
  }
  async function backupRecordSignature(record, includeMedia=false){
    const base={...record};
    if(record.blob){base.blobFingerprint=await blobFingerprint(record.blob);delete base.blob;}
    if(includeMedia)base.media=await Promise.all((record.media||[]).map(async item=>({...item,blobFingerprint:await blobFingerprint(item.blob),blob:undefined,data:undefined,url:undefined})));
    return JSON.stringify(stableValue(base));
  }
  async function compareBackupRecords(incoming,existing,includeMedia=false){
    const oldById=new Map(existing.map(x=>[String(x.id),x]));const result={old:existing.length,added:0,identical:0,updated:0,records:[]};
    for(const item of incoming){const old=oldById.get(String(item.id));if(!old){result.added++;result.records.push(item);continue;}const [a,b]=await Promise.all([backupRecordSignature(item,includeMedia),backupRecordSignature(old,includeMedia)]);if(a===b)result.identical++;else{result.updated++;result.records.push(item);}}
    return result;
  }
  const importStatsText=(label,s)=>t('backup.stats',{label,old:s.old,added:s.added,identical:s.identical,updated:s.updated});
  async function importBackup(file) {
    if (!confirm(t('backup.importConfirm'))) return false;
    backupStatus(t('backup.readingFile', { file: file.name }),0);
    let buf=await file.arrayBuffer(); const u=new Uint8Array(buf);
    backupStatus(t('backup.decompressing'),15);
    if(u[0]===0x1f&&u[1]===0x8b) buf=await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    const data=JSON.parse(new TextDecoder().decode(buf));
    if(data.format!=='red-panda-backup') throw new Error(t('backup.notBackup'));
    // schemaVersion is the current explicit format field; `version` remains
    // accepted for backups written by the first released format.
    const schemaVersion=Number(data.schemaVersion ?? data.version);
    const adapt=BACKUP_IMPORTERS[schemaVersion]; if(!adapt)throw new Error(t('backup.unsupportedVersion', { version: schemaVersion }));
    const normalized=await adapt(data); if(!Array.isArray(normalized.journeys)||!Array.isArray(normalized.memories))throw new Error(t('backup.incomplete'));
    backupStatus(t('backup.journeysRead', { n: normalized.journeys.length }),25);
    const memories=[];let count=0,total=normalized.memories.reduce((n,m)=>n+(m.media||[]).length,0);
    for(let i=0;i<normalized.memories.length;i++){const m=normalized.memories[i],media=[];backupStatus(t('backup.readingMemories', { i: i+1, n: normalized.memories.length }),20+(normalized.memories.length?15*(i+1)/normalized.memories.length:15));for(const v of(m.media||[])){const raw=atob(v.data||'');const bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));const {data,url:_url,...metadata}=v;media.push({...metadata,blob:new Blob([bytes],{type:v.mime||'application/octet-stream'})});count++;backupStatus(t('backup.readingMedia', { done: count, total: total }),35+(total?35*count/total:35));}memories.push({...m,media});}
    backupStatus(t('backup.mediaRead', { c: count, s: normalized.settings.length }),75);
    const oldJourneys=await storeAll('journeys'),oldMemories=await storeAll('memories'),oldSettings=await storeAll('settings');
    const [journeyStats,memoryStats,settingStats]=await Promise.all([
      compareBackupRecords(normalized.journeys,oldJourneys),compareBackupRecords(memories,oldMemories,true),compareBackupRecords(normalized.settings,oldSettings),
    ]);
    const oldMedia=oldMemories.flatMap(m=>m.media||[]),newMedia=memories.flatMap(m=>m.media||[]);
    const mediaStats=await compareBackupRecords(newMedia,oldMedia);
    backupStatus(t('backup.comparing'),82);
    const db=await localDb();await new Promise((resolve,reject)=>{const tx=db.transaction(['journeys','memories','settings'],'readwrite');for(const j of journeyStats.records)tx.objectStore('journeys').put(j);for(const m of memoryStats.records)tx.objectStore('memories').put(m);for(const s of settingStats.records)tx.objectStore('settings').put(s);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});
    await refreshDatabaseStats();
    const results=[importStatsText(t('backup.statsJourney'),journeyStats),importStatsText(t('backup.statsMemory'),memoryStats),importStatsText(t('backup.statsMedia'),mediaStats),importStatsText(t('backup.statsSettings'),settingStats)];
    backupStatus(t('backup.mergeComplete', { results: results.join('\n') }),100,'success');
    return true;
  }
  async function pingServer(server) {
    let response;
    try {
      response = await fetch(`${server}/api/health`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      throw new Error(t('api.pingUnreachable'));
    }
    if (!response.ok) throw new Error(t('api.pingHttp', { status: response.status }));
    const data = await response.json().catch(() => null);
    if (!data || data.ok !== true) throw new Error(t('api.pingNotServer'));
    return data;
  }

  // ---- connection state ----------------------------------------------------
  //
  // The app is offline-first: every personal feature reads and writes the
  // device's IndexedDB, so the UI must never wait for the network. The server
  // only adds online features (AI, email, place search), and those come back
  // automatically once the connection is restored.
  //
  // The state machine itself lives in connection.js so it can be tested.

  const connection = RedPandaConnection.createConnectionManager({
    getServer: () => state.server,
    onStatus: (alive, previous) => {
      state.online = alive;
      renderConnectionBanner();
      // Only announce a real offline -> online recovery, not the first probe.
      if (alive && previous === false) toast(t('offline.online'), 'info');
    },
    onReconnect: async () => {
      await syncSession();
      render();
    },
  });

  /** Record the connection state and refresh the offline banner. */
  function setOnline(online) {
    const previous = state.online;
    connection.setStatus(online);
    state.online = connection.online;
    return previous !== state.online;
  }

  /** Manual "retry" from the offline banner. */
  async function retryServer() {
    if (!state.server) return;
    if (statusHost) {
      statusHost.innerHTML = `<span class="app-status-text">${esc(t('offline.retrying'))}</span>`;
    }
    const alive = await connection.retry();
    if (alive) {
      render();
      return;
    }
    toast(t('offline.error'), 'error');
    renderConnectionBanner();
  }

  /** Poll the server until it answers again, then bring online features back. */
  function scheduleReconnect() {
    connection.schedule();
  }

  /**
   * Guard for online-only actions. Returns false (and tells the user) when the
   * server cannot be reached, so buttons never spin for the whole timeout.
   */
  async function ensureServer({ timeout = 3000 } = {}) {
    if (!state.server) {
      toast(t('api.noServer'), 'error');
      return false;
    }
    if (state.online === true) return true;
    if (state.online === false) {
      toast(t('offline.error'), 'error');
      scheduleReconnect();
      return false;
    }
    const alive = await connection.ensure(timeout);
    state.online = connection.online;
    if (!alive) {
      toast(t('offline.error'), 'error');
      scheduleReconnect();
      return false;
    }
    return true;
  }

  /** Pull the account state from the server. Safe to call while offline. */
  async function syncSession() {
    if (!state.server || !state.token) return;
    try {
      const data = await api('/api/me', { timeout: 8000 });
      setOnline(true);
      state.user = await hydrateClientProfile(data.user);
      cacheUser(state.user);
      render();
    } catch (error) {
      if (error.status === 401) {
        clearToken();
        render();
        return;
      }
      // Offline or server error: keep the cached session and local data.
      if (error.code === 'network' || error.code === 'timeout') {
        setOnline(false);
        scheduleReconnect();
      }
    }
  }

  // ---- shared markup ------------------------------------------------------

  const brand = `
    <div class="brand">
      <img class="seal" src="logo.png" alt="${t('brand.alt')}" />
      <div class="brand-text">
        <span class="brand-cn">${t('brand.big')}</span>
      </div>
    </div>`;

  function topbar({ title = '', back = false, backAction = 'back', right = '' } = {}) {
    return `
      <header class="topbar">
        ${back ? `<button class="icon-btn" data-action="${backAction}" aria-label="${t('common.back')}">←</button>` : '<span class="topbar-lead"></span>'}
        <span class="topbar-title">${esc(title)}</span>
        <div class="topbar-right">${right}</div>
      </header>`;
  }

  function loadingScreen() {
    return `
      <div class="screen center-screen">
        <div class="loading">
          <img class="seal seal-lg pulse" src="logo.png" alt="${t('brand.alt')}" />
          <p class="muted">${t('loading')}</p>
        </div>
      </div>`;
  }

  // ---- rendering ----------------------------------------------------------

  function render({ animate = true } = {}) {
    document.documentElement.classList.toggle('is-locale-switching', !animate);
    if (!state.ready) {
      app.innerHTML = loadingScreen();
      renderNavBar();
      renderDraftOverlay();
      return;
    }

    const route = parseRoute();

    // Entering "create journey" from another page always starts a fresh plan,
    // unless the user picked one of the cached drafts.
    if (route.name === 'new') {
      if (pendingDraft) {
        const draft = pendingDraft;
        pendingDraft = null;
        resetPlanState();
        planState.text = draft.text || '';
        planState.items = Array.isArray(draft.items) ? draft.items : [];
        planState.locked = true;
        planState.draftId = draft.id || '';
        planState.draftCreatedAt = draft.createdAt || '';
      } else if (currentRouteName !== 'new') {
        resetPlanState();
      }
    }
    currentRouteName = route.name;

    if (!state.server) {
      renderSetup();
      renderDraftOverlay();
      return;
    }
    // Password reset links work whether or not someone is signed in.
    if (route.name === 'reset-password') {
      renderResetPassword(route.query);
      renderDraftOverlay();
      return;
    }
    // Arriving from a verification or reset email should show the signed-out screen.
    if (route.name === 'login' && (route.query.verified || route.query.verify || route.query.reset)) {
      clearToken();
    }
    if (!state.token) {
      renderNavBar();
      switch (route.name) {
        case 'settings':
          renderSettings({ publicView: true });
          break;
        case 'register':
          renderAuth('register');
          break;
        case 'pending':
          renderPending(route.query);
          break;
        case 'forgot':
          renderForgot();
          break;
        default:
          renderAuth('login');
          break;
      }
      renderDraftOverlay();
      return;
    }
    if (!state.user) {
      // We could not verify the cached session (for example offline on first
      // launch after upgrading). Fall back to the login screen instead of an
      // error page; the token is kept and will be re-checked on next launch.
      renderNavBar();
      renderAuth('login');
      renderDraftOverlay();
      return;
    }

    switch (route.name) {
      case 'home':
        renderTrip();
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
      case 'memories':
        if (route.id) renderMemoryDetail(route.id);
        else renderMemories();
        break;
      case 'me':
        renderMe();
        break;
      case 'settings':
        renderSettings();
        break;
      case 'database':
        renderDatabase();
        break;
      case 'discover':
        renderDiscover();
        break;
      case 'login':
        history.replaceState(null, '', '#/');
        renderTrip();
        break;
      default:
        history.replaceState(null, '', '#/');
        renderTrip();
        break;
    }
    renderNavBar();
    // 草稿浮层浮在页面之上，每次重绘都要跟着刷新（语言切换、页面切换等）。
    renderDraftOverlay();
    // 离线提示条独立于页面内容，重新渲染时保持显示状态。
    renderConnectionBanner();
  }

  function renderSetup() {
    app.innerHTML = `
      <div class="screen setup-screen">
        ${languageSwitcher()}
        <div class="auth-hero">
          <img class="seal seal-lg" src="logo.png" alt="${t('brand.alt')}" />
          <h1 class="auth-title">${t('brand.big')}</h1>
        </div>
        <div class="card auth-card">
          <h2 class="setup-title">${t('setup.title')}</h2>
          <p class="setup-sub">${t('setup.sub')}</p>
          <form id="setup-form" class="form" novalidate>
            <label class="field">
              <span>${t('setup.serverLabel')}</span>
              <input id="setup-url" value="${esc(defaultServer() || 'http://127.0.0.1:8787')}"
                placeholder="http://192.168.1.10:8787" inputmode="url"
                autocapitalize="off" spellcheck="false" />
            </label>
            <p class="form-error" id="setup-error" hidden></p>
            <button class="btn primary block" type="submit">${t('setup.submit')}</button>
          </form>
          <p class="hint">${t('setup.hint')}</p>
        </div>
      </div>`;

    const form = document.getElementById('setup-form');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      hideError('setup-error');
      const button = form.querySelector('button[type="submit"]');
      const server = normalizeServer(document.getElementById('setup-url').value);
      if (!server) {
        showError('setup-error', t('setup.urlError'));
        return;
      }
      setBusy(button, true, t('setup.connecting'));
      try {
        const health = await pingServer(server);
        localStorage.setItem(STORAGE.server, server);
        state.server = server;
        toast(t('setup.connectedToast', { name: health.name || t('brand.name'), version: health.version || '' }));
        state.authTab = 'login';
        location.hash = '#/login';
        await init();
      } catch (error) {
        showError('setup-error', t('setup.connectFailed', { message: error.message }));
        setBusy(button, false);
      }
    });
  }

  function authCardHTML(active, notice = '') {
    return `
          <div class="tabs" role="tablist">
            <button class="tab ${active === 'login' ? 'active' : ''}" data-tab="login" role="tab">${t('auth.tabLogin')}</button>
            <button class="tab ${active === 'register' ? 'active' : ''}" data-tab="register" role="tab">${t('auth.tabRegister')}</button>
          </div>
          <form id="auth-form" class="form" novalidate>
            <label class="field">
              <span>${t('auth.emailLabel')}</span>
              <input name="email" type="email" autocomplete="username" inputmode="email"
                maxlength="254" placeholder="you@example.com" autocapitalize="off" spellcheck="false" required />
            </label>
            <label class="field">
              <span>${t('auth.passwordLabel')}</span>
              <div class="password-field">
                <input name="password" type="password" maxlength="128"
                  autocomplete="${active === 'login' ? 'current-password' : 'new-password'}"
                  placeholder="${active === 'login' ? t('auth.passwordPlaceholderLogin') : t('auth.passwordPlaceholderRegister')}" required />
                ${
                  active === 'login'
                    ? `<button type="button" class="password-toggle" data-toggle-password
                         aria-label="${t('auth.showPassword')}" title="${t('auth.showPassword')}">
                        <svg class="eye-open" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                          stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                          <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
                          <circle cx="12" cy="12" r="2.6" />
                        </svg>
                        <svg class="eye-off" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                          stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                          <path d="M2.5 12s3.5-6 9.5-6c2 0 3.8.6 5.3 1.5M21.5 12s-3.5 6-9.5 6c-2 0-3.8-.6-5.3-1.5" />
                          <path d="M4 4l16 16" />
                        </svg>
                      </button>`
                    : ''
                }
              </div>
            </label>
            ${
              active === 'register'
                ? `<label class="field">
                    <span>${t('auth.confirmLabel')}</span>
                    <input name="confirm" type="password" maxlength="128" autocomplete="new-password" placeholder="${t('auth.confirmPlaceholder')}" required />
                  </label>`
                : ''
            }
            ${notice}
            <p class="form-error" id="auth-error" hidden></p>
            <button class="btn primary block" type="submit">${active === 'login' ? t('auth.loginSubmit') : t('auth.registerSubmit')}</button>
          </form>
          ${
            active === 'login'
              ? `<p class="auth-foot">
                  <button class="link" data-action="forgot">${t('auth.forgot')}</button>
                </p>`
              : ''
          }
          <p class="auth-foot">
            ${active === 'login' ? t('auth.noAccount') : t('auth.haveAccount')}
            <button class="link" data-tab-switch="${active === 'login' ? 'register' : 'login'}">
              ${active === 'login' ? t('auth.registerLink') : t('auth.loginLink')}
            </button>
          </p>`;
  }

  function bindAuthCard() {
    const switchTab = (tab) => {
      const screen = app.querySelector('.screen.auth-screen');
      const card = screen?.querySelector('.auth-card');
      if (!screen || !card) {
        navigate(tab === 'register' ? '#/register' : '#/login');
        return;
      }
      const form = card.querySelector('#auth-form');
      const email = form?.email?.value || '';
      state.authTab = tab;
      replaceHash(tab === 'register' ? '#/register' : '#/login');
      card.innerHTML = authCardHTML(tab);
      const newForm = card.querySelector('#auth-form');
      if (newForm?.email) newForm.email.value = email;
      bindAuthCard();
    };

    app.querySelectorAll('.auth-card [data-tab], .auth-card [data-tab-switch]').forEach((button) => {
      button.addEventListener('click', () => {
        const tab = (button.dataset.tab || button.dataset.tabSwitch) === 'register' ? 'register' : 'login';
        switchTab(tab);
      });
    });

    const form = document.getElementById('auth-form');
    if (!form) return;
    const passwordInput = form.querySelector('input[name="password"]');
    const passwordToggle = form.querySelector('[data-toggle-password]');
    if (passwordToggle && passwordInput) {
      passwordToggle.addEventListener('click', () => {
        const show = passwordInput.type === 'password';
        passwordInput.type = show ? 'text' : 'password';
        passwordToggle.classList.toggle('is-visible', show);
        passwordToggle.setAttribute('aria-label', show ? t('auth.hidePassword') : t('auth.showPassword'));
        passwordToggle.setAttribute('title', show ? t('auth.hidePassword') : t('auth.showPassword'));
        passwordInput.focus({ preventScroll: true });
      });
    }
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      hideError('auth-error');
      const email = form.email.value.trim();
      const password = form.password.value;
      const current = state.authTab === 'register' ? 'register' : 'login';
      if (!email) return showError('auth-error', t('auth.errEmail'));
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showError('auth-error', t('auth.errEmailInvalid'));
      if (!password) return showError('auth-error', t('auth.errPassword'));
      if (current === 'register') {
        if (password.length < 8) return showError('auth-error', t('auth.errPasswordLength'));
        if (password !== form.confirm.value) return showError('auth-error', t('auth.errConfirm'));
      }

      const button = form.querySelector('button[type="submit"]');
      setBusy(button, true, current === 'login' ? t('auth.busyLogin') : t('auth.busyRegister'));
      try {
        // 登录与注册都要连服务器，离线时直接提示，不要干等网络超时。
        if (!(await ensureServer())) {
          setBusy(button, false);
          return;
        }
        if (current === 'register') {
          const data = await api('/api/auth/register', {
            method: 'POST',
            auth: false,
            body: { email, password, locale: getLocale() },
          });
          toast(data.message || t('auth.mailSentToast'));
          navigate(`#/pending?email=${encodeURIComponent(data.email || email)}`);
          return;
        }
        const data = await api('/api/auth/login', {
          method: 'POST',
          auth: false,
          body: { email, password, locale: getLocale() },
        });
        state.token = data.token;
        state.user = data.user;
        state.user = await hydrateClientProfile(data.user);
        localStorage.setItem(STORAGE.token, data.token);
        cacheUser(state.user);
        toast(t('auth.welcome'));
        // 登录后回到默认的行程页，并且不留下多余的历史记录。
        historyDepth = 0;
        history.replaceState(null, '', '#/');
        render();
      } catch (error) {
        if (error.code === 'email_not_verified') {
          toast(t('auth.verifyFirst'));
          navigate(`#/pending?email=${encodeURIComponent(email)}`);
          return;
        }
        showError('auth-error', error.message);
        setBusy(button, false);
      }
    });
  }

  function renderAuth(tab = 'login') {
    state.authTab = tab === 'register' ? 'register' : 'login';
    const active = state.authTab;
    const route = parseRoute();
    let notice = '';
    if (active === 'login') {
      if (route.query.verified === '1') {
        notice = `<p class="form-ok">${t('auth.noticeVerified')}</p>`;
      } else if (route.query.verify === 'invalid') {
        notice = `<p class="form-error">${t('auth.noticeInvalidLink')}</p>`;
      } else if (route.query.reset === '1') {
        notice = `<p class="form-ok">${t('auth.noticeResetDone')}</p>`;
      }
    }

    app.innerHTML = `
      <div class="screen auth-screen auth-login-screen">
        <div class="auth-hero">
          <img class="seal seal-lg" src="logo.png" alt="${t('brand.alt')}" />
          <h1 class="auth-title">${t('brand.big')}</h1>
          <p class="auth-tag">${t('auth.tagline')}</p>
        </div>

        <div class="card auth-card">${authCardHTML(active, notice)}</div>
        ${authLanguageSwitcher()}
      </div>`;

    bindAuthCard();
  }

  function renderPending(query = {}) {
    const email = query.email || '';
    app.innerHTML = `
      <div class="screen auth-screen">
        ${languageSwitcher()}
        <div class="auth-hero">
          <img class="seal seal-lg" src="logo.png" alt="${t('brand.alt')}" />
          <h1 class="auth-title">${t('brand.big')}</h1>
        </div>

        <div class="card auth-card">
          <h2 class="setup-title">${t('pending.title')}</h2>
          <p class="setup-sub">
            ${t('pending.body', { email: email ? `<b>${esc(email)}</b>` : esc(t('pending.yourEmail')) })}
          </p>
          <p class="form-ok" id="pending-ok" hidden></p>
          <p class="form-error" id="pending-error" hidden></p>
          <form id="resend-form" class="form compact" novalidate>
            <label class="field">
              <span>${t('auth.emailLabel')}</span>
              <input name="email" type="email" value="${esc(email)}" inputmode="email"
                maxlength="254" placeholder="you@example.com" autocapitalize="off" spellcheck="false" required />
            </label>
            <button class="btn ghost block" type="submit">${t('pending.resend')}</button>
          </form>
          <button class="btn primary block" data-action="login">${t('pending.backLogin')}</button>
          <p class="hint">${t('pending.hint')}</p>
        </div>
      </div>`;

    const form = document.getElementById('resend-form');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      hideError('pending-error');
      const ok = document.getElementById('pending-ok');
      ok.hidden = true;
      const target = form.email.value.trim();
      if (!target) return showError('pending-error', t('auth.errEmail'));
      const button = form.querySelector('button[type="submit"]');
      setBusy(button, true, t('pending.sending'));
      try {
        if (!(await ensureServer())) { setBusy(button, false); return; }
        const data = await api('/api/auth/resend-verification', {
          method: 'POST',
          auth: false,
          body: { email: target, locale: getLocale() },
        });
        ok.textContent = data.message || t('auth.mailSentToast');
        ok.hidden = false;
      } catch (error) {
        showError('pending-error', error.message);
      } finally {
        setBusy(button, false);
      }
    });
  }

  function renderForgot() {
    app.innerHTML = `
      <div class="screen auth-screen">
        ${languageSwitcher()}
        <div class="auth-hero">
          <img class="seal seal-lg" src="logo.png" alt="${t('brand.alt')}" />
          <h1 class="auth-title">${t('brand.big')}</h1>
        </div>

        <div class="card auth-card">
          <h2 class="setup-title">${t('forgot.title')}</h2>
          <p class="setup-sub">${t('forgot.sub')}</p>
          <form id="forgot-form" class="form" novalidate>
            <label class="field">
              <span>${t('auth.emailLabel')}</span>
              <input name="email" type="email" inputmode="email" maxlength="254"
                placeholder="you@example.com" autocapitalize="off" spellcheck="false" required />
            </label>
            <p class="form-error" id="forgot-error" hidden></p>
            <p class="form-ok" id="forgot-ok" hidden></p>
            <button class="btn primary block" type="submit">${t('forgot.submit')}</button>
          </form>
          <p class="auth-foot">
            <button class="link" data-action="login">${t('pending.backLogin')}</button>
          </p>
        </div>
      </div>`;

    const form = document.getElementById('forgot-form');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      hideError('forgot-error');
      const ok = document.getElementById('forgot-ok');
      ok.hidden = true;
      const email = form.email.value.trim();
      if (!email) return showError('forgot-error', t('auth.errEmail'));
      const button = form.querySelector('button[type="submit"]');
      setBusy(button, true, t('pending.sending'));
      try {
        if (!(await ensureServer())) { setBusy(button, false); return; }
        const data = await api('/api/auth/forgot-password', {
          method: 'POST',
          auth: false,
          body: { email, locale: getLocale() },
        });
        ok.textContent = data.message || t('forgot.sentFallback');
        ok.hidden = false;
      } catch (error) {
        showError('forgot-error', error.message);
      } finally {
        setBusy(button, false);
      }
    });
  }

  function renderResetPassword(query = {}) {
    const token = query.token || '';
    if (!token) {
      app.innerHTML = `
        <div class="screen auth-screen">
          ${languageSwitcher()}
          <div class="auth-hero">
            <img class="seal seal-lg" src="logo.png" alt="${t('brand.alt')}" />
            <h1 class="auth-title">${t('brand.big')}</h1>
            <p class="auth-tag">${t('home.sub')}</p>
          </div>
          <div class="card auth-card">
            <h2 class="setup-title">${t('reset.invalidTitle')}</h2>
            <p class="setup-sub">${t('reset.invalidBody')}</p>
            <button class="btn primary block" data-action="forgot">${t('reset.reapply')}</button>
            <p class="auth-foot"><button class="link" data-action="login">${t('pending.backLogin')}</button></p>
          </div>
        </div>`;
      return;
    }

    app.innerHTML = `
      <div class="screen auth-screen">
        ${languageSwitcher()}
        <div class="auth-hero">
          <img class="seal seal-lg" src="logo.png" alt="${t('brand.alt')}" />
          <h1 class="auth-title">${t('brand.big')}</h1>
        </div>

        <div class="card auth-card">
          <h2 class="setup-title">${t('reset.title')}</h2>
          <p class="setup-sub">${t('reset.sub')}</p>
          <form id="reset-form" class="form" novalidate>
            <label class="field">
              <span>${t('reset.newPasswordLabel')}</span>
              <input name="password" type="password" minlength="8" maxlength="128"
                autocomplete="new-password" placeholder="${t('auth.passwordPlaceholderRegister')}" required />
            </label>
            <label class="field">
              <span>${t('reset.confirmLabel')}</span>
              <input name="confirm" type="password" maxlength="128" autocomplete="new-password" placeholder="${t('auth.confirmPlaceholder')}" required />
            </label>
            <p class="form-error" id="reset-error" hidden></p>
            <button class="btn primary block" type="submit">${t('reset.save')}</button>
          </form>
          <p class="auth-foot"><button class="link" data-action="login">${t('pending.backLogin')}</button></p>
        </div>
      </div>`;

    const form = document.getElementById('reset-form');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      hideError('reset-error');
      const password = form.password.value;
      if (password.length < 8) return showError('reset-error', t('auth.errPasswordLength'));
      if (password !== form.confirm.value) return showError('reset-error', t('auth.errConfirm'));
      const button = form.querySelector('button[type="submit"]');
      setBusy(button, true, t('busy.saving'));
      try {
        await api('/api/auth/reset-password', {
          method: 'POST',
          auth: false,
          body: { token, password },
        });
        clearToken();
        toast(t('reset.savedToast'));
        navigate('#/login?reset=1');
      } catch (error) {
        showError('reset-error', error.message);
        setBusy(button, false);
      }
    });
  }

  /** 行程的时间范围：优先用计划里的时间，没有就用创建时间兜底。 */
  function journeyRange(journey) {
    const plan = journey?.plan?.items?.length ? journey.plan : null;
    const depart = journey?.depart_time || plan?.departTime || journey?.created_at || '';
    const ret = journey?.return_time || plan?.returnTime || '';
    return { depart, ret };
  }

  function journeyDestinations(journey) {
    const items = journey?.plan?.items;
    if (!Array.isArray(items) || !items.length) return '';
    return items
      .map((item) => String(item?.destination ?? '').trim())
      .filter(Boolean)
      .join(' · ');
  }

  /**
   * 行程页默认展示的那一段：
   * 正在进行的 > 接下来最近的 > 最近走过的。
   */
  function pickTrip(journeys) {
    const list = Array.isArray(journeys) ? journeys : [];
    if (!list.length) return { journey: null, status: '' };
    const now = Date.now();
    const stamp = (value) => {
      const time = value ? Date.parse(value) : NaN;
      return Number.isFinite(time) ? time : null;
    };
    let ongoing = null;
    let next = null;
    let nextStart = Infinity;
    let latest = null;
    let latestStart = -Infinity;
    for (const journey of list) {
      const { depart, ret } = journeyRange(journey);
      const start = stamp(depart);
      const end = stamp(ret);
      if (start !== null && start <= now && (end === null || now <= end)) {
        if (!ongoing) ongoing = journey;
      }
      if (start !== null && start > now && start < nextStart) {
        next = journey;
        nextStart = start;
      }
      if (start !== null && start > latestStart) {
        latest = journey;
        latestStart = start;
      }
    }
    if (ongoing) return { journey: ongoing, status: 'ongoing' };
    if (next) return { journey: next, status: 'upcoming' };
    return { journey: latest || list[0], status: 'ended' };
  }

  function tripStatusLabel(status) {
    if (status === 'ongoing') return t('trip.ongoing');
    if (status === 'upcoming') return t('trip.upcoming');
    return t('trip.ended');
  }

  /** 行程页顶部的大卡片：当前 / 接下来的那一段行程。 */
  function tripHeroMarkup(trip) {
    const journey = trip?.journey;
    if (!journey) {
      return `
        <section class="trip-hero is-empty">
          <div class="home-empty">
            <p>${t('trip.emptyTitle')}</p>
            <p class="muted">${t('trip.emptySub')}</p>
          </div>
        </section>`;
    }
    const { depart, ret } = journeyRange(journey);
    const destinations = journeyDestinations(journey);
    return `
      <section class="trip-hero">
        <p class="eyebrow">${esc(tripStatusLabel(trip.status))}</p>
        <h1 class="trip-title">${esc(journey.name)}</h1>
        ${destinations ? `<p class="trip-dest">${esc(destinations)}</p>` : ''}
        <div class="trip-times">
          <div>
            <span>${t('plan.fieldDepart')}</span>
            <b>${esc(fmtDate(depart))}</b>
          </div>
          <div>
            <span>${t('plan.fieldReturn')}</span>
            <b>${esc(ret ? fmtDate(ret) : '—')}</b>
          </div>
        </div>
        <button class="btn ghost block" data-action="trip-open" data-journey-id="${esc(journey.id)}">
          ${t('trip.openDetail')}
        </button>
      </section>`;
  }

  /** 行程页里「暂时还没有」的信息格子。 */
  function soonCell(label) {
    return `
      <div class="info-cell">
        <span>${esc(label)}</span>
        <b class="is-soon">${t('trip.soon')}</b>
      </div>`;
  }

  function otherJourneysMarkup(journeys, currentId) {
    const others = (Array.isArray(journeys) ? journeys : [])
      .filter((journey) => String(journey.id) !== String(currentId))
      .slice(0, 4);
    if (!others.length) return '';
    return `
      <section class="trip-others">
        <h2 class="section-title">${t('trip.otherTitle')}</h2>
        <div class="journey-list">
          ${others.map(journeyCard).join('')}
        </div>
        <button class="link trip-all" data-action="all-journeys">${t('trip.allJourneys')} →</button>
      </section>`;
  }

  /** One draft row; `expanded` turns it into a long pill with preview + delete. */
  function draftRowMarkup(draft, expanded) {
    if (expanded) {
      const items = Array.isArray(draft.items) ? draft.items : [];
      return `
        <div class="draft-expanded" data-draft-id="${esc(draft.id)}">
          <div class="draft-preview">
            <p class="draft-preview-text">${esc(draft.text || '')}</p>
            ${
              items.length
                ? `<ul class="draft-preview-list">${items
                    .map(
                      (item) => `<li>${esc(item.destination)}${
                        item.departTime ? ` · ${esc(fmtDate(item.departTime))}` : ''
                      }</li>`,
                    )
                    .join('')}</ul>`
                : `<p class="draft-preview-empty">${t('draft.previewEmpty')}</p>`
            }
          </div>
          <button class="draft-delete" type="button" data-action="plan-draft-delete" data-draft-id="${esc(draft.id)}">
            ${t('draft.delete')}
          </button>
        </div>`;
    }
    return `
      <div class="draft-row" data-draft-id="${esc(draft.id)}">
        <button class="draft-open" type="button" data-action="plan-draft" data-draft-id="${esc(draft.id)}">
          ${esc(draftTitle(draft))}
        </button>
        <button class="draft-x" type="button" data-action="plan-draft-expand" data-draft-id="${esc(draft.id)}"
          aria-label="${t('draft.expand')}">×</button>
      </div>`;
  }

  /** 行程页：默认页面，展示当前（或接下来）的行程与相关资料。 */
  function renderTrip() {
    const trip = pickTrip(state.journeys);
    app.innerHTML = `
      <div class="screen">
        <main class="page trip-page has-nav">
          <section id="trip-hero">
            ${tripHeroMarkup(trip)}
          </section>

          <section class="card panel">
            <h2 class="panel-title">${t('trip.infoTitle')}</h2>
            <p class="panel-sub">${t('trip.soonHint')}</p>
            <div class="info-grid">
              ${soonCell(t('trip.weather'))}
              ${soonCell(t('trip.traffic'))}
            </div>
          </section>

          <section class="card panel">
            <h2 class="panel-title">${t('trip.filesTitle')}</h2>
            <div class="info-grid">
              ${soonCell(t('trip.ticket'))}
              ${soonCell(t('trip.trainTicket'))}
            </div>
          </section>

          <div id="trip-others">
            ${otherJourneysMarkup(state.journeys, trip.journey?.id)}
          </div>

        </main>
      </div>`;

    const hero = document.getElementById('trip-hero');
    const others = document.getElementById('trip-others');
    const paint = (journeys) => {
      const next = pickTrip(journeys);
      if (hero) hero.innerHTML = tripHeroMarkup(next);
      if (others) {
        others.innerHTML = otherJourneysMarkup(journeys, next.journey?.id);
        bindJourneyCards(others);
      }
    };
    bindJourneyCards(others);

    api('/api/journeys')
      .then(({ journeys }) => {
        state.journeys = journeys;
        paint(journeys);
      })
      .catch(() => {
        paint(state.journeys);
      });
  }

  /** 行程卡片点开详情。 */
  function bindJourneyCards(root) {
    root?.querySelectorAll('[data-journey-id]').forEach((card) => {
      card.addEventListener('click', () => navigate(`#/journey/${card.dataset.journeyId}`));
    });
  }

  /**
   * 倒计时只由 createCooldownUntil 决定，渲染导航栏后重新贴到新按钮上，
   * 避免重建 DOM 时把倒计时状态丢掉。
   */
  function applyCooldownButton() {
    const button = document.querySelector('.nav-create');
    if (!button) return;
    const left = Math.ceil((createCooldownUntil - Date.now()) / 1000);
    if (left > 0) {
      button.disabled = true;
      button.classList.add('is-cooling');
      button.textContent = String(left);
    } else {
      button.disabled = false;
      button.classList.remove('is-cooling');
      button.textContent = '＋';
    }
  }

  /** 有草稿时加号先冷却两秒，避免误触丢下草稿。 */
  function startCreateCooldown() {
    createCooldownUntil = Date.now() + 2000;
    applyCooldownButton();
    if (cooldownTimer) return;
    cooldownTimer = setInterval(() => {
      if (Date.now() >= createCooldownUntil) {
        stopCreateCooldown();
        return;
      }
      applyCooldownButton();
    }, 250);
  }

  /** 收起浮层时立刻停掉倒计时。 */
  function stopCreateCooldown() {
    if (cooldownTimer) {
      clearInterval(cooldownTimer);
      cooldownTimer = null;
    }
    createCooldownUntil = 0;
    applyCooldownButton();
  }

  /** 压入一条历史，让系统返回键先收起草稿而不是退出应用。 */
  function pushOverlayHistory() {
    if (overlayPushed) return;
    try {
      history.pushState({ redPandaOverlay: true }, '', location.href);
      overlayPushed = true;
      historyDepth += 1;
    } catch {
      overlayPushed = false;
    }
  }

  function dropOverlayHistory() {
    if (!overlayPushed) return;
    overlayPushed = false;
    historyDepth = Math.max(0, historyDepth - 1);
    suppressPopCount += 1;
    history.back();
  }

  /**
   * 草稿浮层：悬浮在任意页面之上（不随页面重绘消失），
   * 所以四个标签页点加号都能就地浮出草稿列表。
   */
  function renderDraftOverlay() {
    if (!overlayHost) return;
    const drafts = sortedDrafts();
    overlayHost.innerHTML = `
      <div class="draft-layer" id="draft-layer"${draftOverlayOpen ? '' : ' hidden'}>
        <div class="draft-list" id="draft-list">
          ${
            drafts.length
              ? drafts.map((draft) => draftRowMarkup(draft, expandedDraftId === draft.id)).join('')
              : `<p class="draft-none">${t('draft.none')}</p>`
          }
        </div>
      </div>`;
    positionDraftLayer();
  }

  function openDraftOverlay() {
    draftOverlayOpen = true;
    createCooldownUntil = Date.now() + 2000;
    renderDraftOverlay();
    startCreateCooldown();
    pushOverlayHistory();
  }

  function closeDraftOverlay() {
    draftOverlayOpen = false;
    expandedDraftId = null;
    stopCreateCooldown();
    const veil = document.getElementById('draft-layer');
    if (veil) veil.hidden = true;
    dropOverlayHistory();
  }

  /** 展开的草稿收回成列表（浮层保持打开）。 */
  function collapseExpanded() {
    if (!expandedDraftId) return;
    expandedDraftId = null;
    refreshDraftList();
  }

  /**
   * 从浮层跳到别的路由。
   * 跳到主页面时退回主页面那条历史记录（返回键仍然是直接退出应用），
   * 跳到子页面时把浮层那条记录改写成目标页面。
   */
  function leaveOverlayTo(hash) {
    draftOverlayOpen = false;
    expandedDraftId = null;
    stopCreateCooldown();
    const veil = document.getElementById('draft-layer');
    if (veil) veil.hidden = true;
    if (isTabHash(hash)) {
      overlayPushed = false;
      pendingTabHash = hash;
      suppressPopCount += 1;
      history.go(-historyDepth);
      return;
    }
    if (overlayPushed) {
      overlayPushed = false;
      try {
        history.replaceState({ redPandaOverlay: false }, '', hash);
      } catch {
        // 忽略：仍然按普通跳转处理
      }
    }
    if (location.hash === hash) {
      render();
    } else {
      location.hash = hash;
    }
  }

  /** 草稿列表紧贴加号上方（留一点间隙），内容向上生长。 */
  function positionDraftLayer() {
    const layer = document.getElementById('draft-layer');
    const nav = document.querySelector('.nav-bar');
    if (!layer || !nav) return;
    const navRect = nav.getBoundingClientRect();
    // 离线提示条贴在导航栏上边，草稿浮层要再往上让一让。
    const banner = document.getElementById('app-status');
    const bannerHeight = banner && !banner.hidden ? banner.getBoundingClientRect().height : 0;
    layer.style.top = 'auto';
    layer.style.bottom = `${Math.round(window.innerHeight - navRect.top + 10 + bannerHeight)}px`;
  }

  function refreshDraftList() {
    const list = document.getElementById('draft-list');
    if (!list) return;
    const drafts = sortedDrafts();
    list.innerHTML = drafts.length
      ? drafts.map((draft) => draftRowMarkup(draft, expandedDraftId === draft.id)).join('')
      : `<p class="draft-none">${t('draft.none')}</p>`;
    if (!drafts.length) closeDraftOverlay();
  }

  // ---- journey plan: prompt → AI plan → editable table ---------------------

  const PLAN_PERIODS = {
    zh: [
      { label: '上午', hour: 9 },
      { label: '下午', hour: 14 },
      { label: '傍晚', hour: 19 },
    ],
    en: [
      { label: 'Morning', hour: 9 },
      { label: 'Afternoon', hour: 14 },
      { label: 'Evening', hour: 19 },
    ],
    de: [
      { label: 'Morgen', hour: 9 },
      { label: 'Vormittag', hour: 14 },
      { label: 'Abend', hour: 19 },
    ],
  };

  const planState = {
    text: '',
    locked: false,
    editing: false,
    editingItem: null,
    busy: false,
    error: '',
    items: [],
    suggestion: '',
    artIndex: -1,
    draftId: '',
    draftCreatedAt: '',
  };

  /** Impressionist painting for each suggestion, in the same order. */
  const PLAN_ART = ['paintings/athens.jpg', 'paintings/louvre.jpg', 'paintings/neuschwanstein.jpg'];

  function resetPlanState() {
    planState.text = '';
    planState.locked = false;
    planState.editing = false;
    planState.editingItem = null;
    planState.busy = false;
    planState.error = '';
    planState.items = [];
    planState.suggestion = '';
    planState.artIndex = -1;
    planState.draftId = '';
    planState.draftCreatedAt = '';
  }

  let currentRouteName = '';
  let pendingDraft = null;
  let draftOverlayOpen = false;
  let expandedDraftId = null;
  let createCooldownUntil = 0;
  let cooldownTimer = null;
  let overlayPushed = false;
  let suppressPopCount = 0;

  function periodIndexForHour(periods, hour) {
    const hours = periods.map((p) => p.hour);
    let index = 0;
    for (let i = 1; i < hours.length; i += 1) {
      if (hour >= hours[i]) index = i;
    }
    if (hour < hours[0]) index = 0;
    return index;
  }

  /** The hint inside the input box changes on every visit. */
  function randomPlanPlaceholder() {
    const pool = planPlaceholders();
    return pool[Math.floor(Math.random() * pool.length)];
  }

  function planPlaceholders() {
    const dict = I18N[getLocale()] || I18N.zh;
    const list = Array.isArray(dict.plan?.placeholders) ? dict.plan.placeholders : [];
    return list.length ? list : I18N.zh.plan.placeholders;
  }

  function planArtAlts() {
    const dict = I18N[getLocale()] || I18N.zh;
    const list = Array.isArray(dict.plan?.artAlt) ? dict.plan.artAlt : [];
    return list.length ? list : I18N.zh.plan.artAlt;
  }

  /** Local drafts keep a plan alive when the user leaves the page. */
  function loadDrafts() {
    try {
      const raw = localStorage.getItem(STORAGE.drafts);
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  function saveDrafts(list) {
    try {
      localStorage.setItem(STORAGE.drafts, JSON.stringify(list.slice(0, 20)));
    } catch {
      // Private mode or a full quota should not break the page.
    }
  }

  function draftTitle(draft) {
    const time = draft.departTime ? fmtDate(draft.departTime) : t('draft.untimed');
    const destination = draft.destination || t('draft.undestined');
    const created = draft.createdAt ? fmtDate(draft.createdAt) : '';
    return t('draft.title', { time, destination, created });
  }

  /** Cache the solidified input and the extracted table on this device. */
  function storeDraft() {
    const items = Array.isArray(planState.items) ? planState.items : [];
    const depart = items
      .map((item) => item?.departTime)
      .filter(Boolean)
      .sort()[0] || '';
    const destination = items.find((item) => item?.destination)?.destination || '';
    if (!planState.draftId) {
      planState.draftId = `d${Date.now()}${Math.floor(Math.random() * 1000)}`;
      planState.draftCreatedAt = new Date().toISOString();
    }
    const draft = {
      id: planState.draftId,
      text: planState.text,
      items,
      departTime: depart,
      destination,
      createdAt: planState.draftCreatedAt || new Date().toISOString(),
    };
    const list = loadDrafts().filter((entry) => entry.id !== draft.id);
    list.unshift(draft);
    saveDrafts(list);
    return draft;
  }

  function removeDraft(id) {
    if (!id) return;
    saveDrafts(loadDrafts().filter((entry) => entry.id !== id));
  }

  /** 草稿按创建时间排序，最新的紧挨着加号、依次向上排列。 */
  function sortedDrafts() {
    return loadDrafts()
      .slice()
      .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  }

  function renderNewJourney() {
    const plan = planState;

    if (plan.editingItem !== null && plan.items[plan.editingItem] == null) {
      plan.editingItem = null;
    }

    const placeholder = esc(plan.suggestion || (plan.suggestion = randomPlanPlaceholder()));
    plan.artIndex = planPlaceholders().indexOf(plan.suggestion);
    const artFile = plan.artIndex >= 0 ? PLAN_ART[plan.artIndex] : null;
    const artAlt = plan.artIndex >= 0 ? (planArtAlts()[plan.artIndex] || '') : '';

    /** The painting above the card; `fading` plays the fade-out after confirming. */
    const art = (fading) =>
      artFile
        ? `
        <figure class="plan-art${fading ? ' is-out' : ''}">
          <img src="${artFile}" alt="${esc(artAlt)}" />
        </figure>`
        : '';

    const tools = (withResend) => `
      <div class="plan-tools">
        <button class="icon-btn" data-action="plan-edit" aria-label="${t('plan.edit')}">✎</button>
        ${
          withResend
            ? `<button class="icon-btn" data-action="plan-resend" aria-label="${t('plan.resend')}">↻</button>`
            : ''
        }
      </div>`;

    let body;
    if (plan.editing) {
      body = `
        <form id="plan-form" novalidate>
          <div class="plan-card">
            <div class="plan-card-top">
              <input id="plan-input" maxlength="300" placeholder="${placeholder}" value="${esc(plan.text)}" />
            </div>
            <div class="plan-card-bottom">
              <button class="plan-card-btn" type="submit">${t('plan.confirm')}</button>
            </div>
          </div>
          <p class="plan-tip">${t('plan.editTip')}</p>
        </form>`;
    } else if (plan.editingItem !== null) {
      const item = plan.items[plan.editingItem];
      const periods = PLAN_PERIODS[getLocale()] || PLAN_PERIODS.zh;
      const departIndex = periodIndexForHour(periods, Number(localPlanTime(item?.departTime).slice(11, 13) || 9));
      const returnIndex = periodIndexForHour(periods, Number(localPlanTime(item?.returnTime).slice(11, 13) || 9));
      const periodOptions = periods
        .map((p, i) => `<option value="${i}" ${i === departIndex ? 'selected' : ''}>${esc(p.label)}</option>`)
        .join('');
      const periodOptionsReturn = periods
        .map((p, i) => `<option value="${i}" ${i === returnIndex ? 'selected' : ''}>${esc(p.label)}</option>`)
        .join('');
      body = `
        <section class="card panel">
          <h2 class="panel-title">${t('plan.editItem')}</h2>
          <p class="panel-sub">${t('plan.editItemSub')}</p>
          <div class="form">
            <label class="field">
              <span>${t('plan.fieldDestination')}</span>
              <input id="plan-item-destination" maxlength="80" value="${esc(item?.destination ?? '')}" />
            </label>
            <label class="field">
              <span>${t('plan.fieldDepart')}</span>
              <input type="datetime-local" id="plan-item-depart" value="${esc(localPlanTime(item?.departTime))}" />
              <select class="plan-period" id="plan-item-depart-period">${periodOptions}</select>
            </label>
            <label class="field">
              <span>${t('plan.fieldReturn')}</span>
              <input type="datetime-local" id="plan-item-return" value="${esc(localPlanTime(item?.returnTime))}" />
              <select class="plan-period" id="plan-item-return-period">${periodOptionsReturn}</select>
            </label>
          </div>
          <button class="btn primary block" type="button" id="plan-item-save">${t('plan.saveItem')}</button>
        </section>`;
    } else if (plan.busy) {
      body = `
        <div class="plan-card">
          <div class="plan-card-top">
            <p class="plan-card-text">${esc(plan.text)}</p>
            ${tools(true)}
          </div>
          <div class="plan-card-bottom">
            <button class="plan-card-btn" type="button" disabled>
              <span>${t('plan.thinking')}</span>
              <span class="plan-spin" aria-hidden="true"></span>
            </button>
          </div>
        </div>
        ${plan.error ? `<p class="form-error">${esc(plan.error)}</p>` : ''}`;
    } else if (plan.items.length > 0) {
      body = `
        <div class="plan-card">
          <div class="plan-card-top">
            <p class="plan-card-text">${esc(plan.text)}</p>
            ${tools(true)}
          </div>
        </div>
        <section class="card panel is-rising">
          <h2 class="panel-title">${t('plan.title')}</h2>
          <p class="panel-sub">${t('plan.sub')}</p>
          <table class="plan-table">
            <thead>
              <tr>
                <th>${t('plan.fieldDestination')}</th>
                <th>${t('plan.fieldDepart')}</th>
                <th>${t('plan.fieldReturn')}</th>
              </tr>
            </thead>
            <tbody>
              ${plan.items
                .map(
                  (item, index) => `
                <tr class="plan-row" data-action="plan-item-edit" data-plan-index="${index}">
                  <td>${esc(item.destination)}</td>
                  <td>${esc(fmtDate(item.departTime))}</td>
                  <td>${esc(fmtDate(item.returnTime))}</td>
                </tr>`,
                )
                .join('')}
            </tbody>
          </table>
        </section>
        ${plan.error ? `<p class="form-error">${esc(plan.error)}</p>` : ''}`;
    } else if (plan.locked) {
      body = `
        <div class="plan-card">
          <div class="plan-card-top">
            <p class="plan-card-text">${esc(plan.text)}</p>
            ${tools(false)}
          </div>
          <div class="plan-card-bottom">
            <button class="plan-card-btn" type="button" data-action="plan-resend">${t('plan.resend')}</button>
          </div>
        </div>
        ${plan.error ? `<p class="form-error">${esc(plan.error)}</p>` : ''}`;
    } else {
      body = `
        ${art(false)}
        <div class="plan-card">
          <div class="plan-card-top">
            <input id="plan-input" maxlength="300" placeholder="${placeholder}" value="${esc(plan.text)}" />
          </div>
          <div class="plan-card-bottom">
            <button class="plan-card-btn" type="button" data-action="plan-confirm">${t('plan.confirm')}</button>
          </div>
        </div>`;
    }

    app.innerHTML = `
      <div class="screen">
        ${topbar({
          title: '',
          back: true,
          right: plan.items.length > 0
            ? `<button class="topbar-text-btn" type="button" data-action="plan-save">${t('plan.save')}</button>`
            : '',
        })}
        <main class="page">
          ${body}
        </main>
      </div>`;

    const form = document.getElementById('plan-form');
    const input = document.getElementById('plan-input');
    const itemSaveButton = document.getElementById('plan-item-save');
    const itemDestination = document.getElementById('plan-item-destination');
    const itemDepart = document.getElementById('plan-item-depart');
    const itemDepartPeriod = document.getElementById('plan-item-depart-period');
    const itemReturn = document.getElementById('plan-item-return');
    const itemReturnPeriod = document.getElementById('plan-item-return-period');

    if (form) {
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        confirmPlanInput();
      });
    }
    if (input) input.addEventListener('input', () => {
      planState.text = input.value;
    });

    const bindTimeField = (inputEl, periodEl, key) => {
      if (!inputEl || !periodEl) return;
      const saveValue = (value) => {
        const itemIndex = planState.editingItem;
        const item = itemIndex !== null ? planState.items[itemIndex] : null;
        if (item) planState.items[itemIndex] = { ...item, [key]: value };
      };
      inputEl.addEventListener('change', () => {
        const value = inputEl.value;
        const hour = value ? Number(value.slice(11, 13) || 9) : 9;
        const periods = PLAN_PERIODS[getLocale()] || PLAN_PERIODS.zh;
        periodEl.value = String(periodIndexForHour(periods, hour));
        saveValue(value);
      });
      periodEl.addEventListener('change', () => {
        const value = inputEl.value;
        if (!value) return;
        const period = PLAN_PERIODS[getLocale()] || PLAN_PERIODS.zh;
        const periodDef = period[Number(periodEl.value)];
        if (!periodDef) return;
        const next = `${value.slice(0, 10)}T${String(periodDef.hour).padStart(2, '0')}:${value.slice(14, 16) || '00'}`;
        inputEl.value = next;
        saveValue(next);
      });
    };

    if (itemSaveButton) itemSaveButton.addEventListener('click', () => {
      planState.editingItem = null;
      renderNewJourney();
    });
    if (itemDestination) itemDestination.addEventListener('change', () => {
      const itemIndex = planState.editingItem;
      const item = itemIndex !== null ? planState.items[itemIndex] : null;
      if (item) planState.items[itemIndex] = { ...item, destination: itemDestination.value };
    });
    bindTimeField(itemDepart, itemDepartPeriod, 'departTime');
    bindTimeField(itemReturn, itemReturnPeriod, 'returnTime');
  }

  function localPlanTime(value) {
    const text = String(value ?? '');
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text) ? text.slice(0, 16) : '';
  }

  function confirmPlanInput() {
    // An empty input falls back to the suggestion shown in the placeholder.
    const text = (planState.text || planState.suggestion || '').trim();
    if (!text) return;

    // 原地过渡：油画淡出并收起，输入框就地变成固化文字，按钮变成「我想想」
    const art = document.querySelector('.plan-art');
    if (art) art.classList.add('is-out');
    const input = document.getElementById('plan-input');
    if (input) {
      const frozen = document.createElement('p');
      frozen.className = 'plan-card-text is-rising';
      frozen.textContent = text;
      input.replaceWith(frozen);
    }
    const button = document.querySelector('.plan-card-btn');
    if (button) {
      button.innerHTML = `<span>${t('plan.thinking')}</span><span class="plan-spin" aria-hidden="true"></span>`;
      button.disabled = true;
      button.removeAttribute('data-action');
    }

    planState.text = text;
    planState.locked = true;
    planState.editing = false;
    planState.editingItem = null;
    planState.error = '';
    planState.items = [];
    storeDraft();

    // 等过渡走完再发请求，避免画面跳动
    setTimeout(() => runPlan(text), 360);
  }

  async function runPlan(text) {
    const prompt = String(text ?? '').trim();
    if (!prompt) return;
    // AI needs the server; check first so the button does not spin for 90s.
    if (!(await ensureServer())) {
      planState.busy = false;
      planState.error = t('offline.error');
      renderNewJourney();
      return;
    }
    planState.busy = true;
    planState.error = '';
    renderNewJourney();
    let items = [];
    try {
      const data = await api('/api/ai/journey-plan', {
        method: 'POST',
        body: { prompt },
        timeout: 90000,
      });
      items = Array.isArray(data?.items) ? data.items : [];
    } catch (error) {
      items = [];
      planState.error = error.message;
    }
    planState.items = items;
    planState.busy = false;
    if (items.length > 0) storeDraft();
    renderNewJourney();
  }

  /** Save the extracted plan as a real journey in this device's IndexedDB. */
  async function savePlanAsJourney() {
    const items = Array.isArray(planState.items) ? planState.items : [];
    if (!items.length) return;
    const name = (items[0]?.destination || planState.text || '').trim().slice(0, 80);
    if (!name) {
      toast(t('new.errName'), 'error');
      return;
    }
    const description = items
      .map((item) => [item?.destination, item?.departTime, item?.returnTime].filter(Boolean).join(' · '))
      .filter(Boolean)
      .join('；');
    const button = document.querySelector('[data-action="plan-save"]');
    setBusy(button, true, t('busy.sending'));
    try {
      const { journey } = await api('/api/journeys', {
        method: 'POST',
        body: { name, description: description || planState.text, plan: { items } },
      });
      removeDraft(planState.draftId);
      toast(t('plan.savedToast'));
      navigate(`#/journey/${journey.id}`);
    } catch (error) {
      toast(error.message, 'error');
      setBusy(button, false);
    }
  }

  async function runAI(name, textarea, button, errorId) {
    if (!String(name).trim()) {
      showError(errorId, t('new.errName'));
      return;
    }
    hideError(errorId);
    button.disabled = true;
    const idle = button.textContent;
    button.textContent = t('ai.busy');
    try {
      if (!(await ensureServer())) return;
      const data = await api('/api/ai/journey-description', {
        method: 'POST',
        body: { name: String(name).trim() },
        timeout: 90000,
      });
      textarea.value = data.description;
      toast(data.mock ? t('ai.mock') : t('ai.done'));
    } catch (error) {
      showError(errorId, error.message);
    } finally {
      button.disabled = false;
      button.textContent = idle;
    }
  }

  /**
   * 常驻底部导航：渲染在 #app-nav 宿主里（不随页面内容重绘），
   * fixed 定位 + 高 z-index，永远悬浮在底部且不被任何页面遮盖。
   */
  function renderNavBar() {
    if (!navHost) return;
    if (['database', 'settings'].includes(parseRoute().name)) {
      navHost.innerHTML = '';
      navHost.hidden = true;
    } else {
      // 只要已登录就常驻显示：任何页面（含等待服务器时）都不会缺失。
      const show = Boolean(state.user);
      navHost.hidden = !show;
      navHost.innerHTML = show ? navBar() : '';
      // 导航栏是重建的，重新贴一次倒计时状态。
      applyCooldownButton();
    }
    updateNavHeight();
  }

  /** 实测底部导航栏高度，离线提示条要正好贴在它上边。 */
  function updateNavHeight() {
    const bar = navHost?.querySelector('.nav-bar');
    const height = bar ? Math.round(bar.getBoundingClientRect().height) : 0;
    document.documentElement.style.setProperty('--nav-h', `${height}px`);
  }

  /**
   * 离线提示条：贴在底部导航栏上边，缩成一行，说明本机数据可用、在线功能稍后恢复。
   * 元素独立于 #app，重新渲染页面时不会被清掉。
   */
  function renderConnectionBanner() {
    if (!statusHost) return;
    const offline = state.online === false;
    statusHost.hidden = !offline;
    if (!offline) {
      statusHost.innerHTML = '';
      document.documentElement.style.setProperty('--offline-h', '0px');
      return;
    }
    statusHost.innerHTML = `
      <span class="app-status-text">${esc(t('offline.banner'))}</span>
      <button type="button" data-action="retry-server">${esc(t('offline.action'))}</button>`;
    // 量出实际高度，让页面底部和浮层给它让位。
    const height = Math.round(statusHost.getBoundingClientRect().height);
    document.documentElement.style.setProperty('--offline-h', `${height}px`);
    // 草稿浮层是 JS 定位的，横幅出现后要重新让位。
    positionDraftLayer();
  }

  function navBar() {
    const active = currentRouteName;
    const isActive = (name) => (active === name ? ' is-active' : '');
    return `
      <nav class="nav-bar">
        <button class="nav-btn nav-journeys${isActive('home')}" data-action="current-journey">${t('nav.current')}</button>
        <button class="nav-btn nav-memories${isActive('memories')}" data-action="memories">${t('nav.memories')}</button>
        <button class="nav-btn nav-create" data-action="new" aria-label="${t('new.title')}">＋</button>
        <button class="nav-btn nav-discover${isActive('discover')}" data-action="discover">${t('nav.discover')}</button>
        <button class="nav-btn nav-me${isActive('me')}" data-action="me">${t('nav.me')}</button>
      </nav>`;
  }

  /**
   * 发现页：展示当前或最近行程目的地里的有趣去处。
   * 想法还没定下来，先留白。
   */
  function renderDiscover() {
    app.innerHTML = `
      <div class="screen">
        <main class="page has-nav">
          <h1 class="page-title">${t('nav.discover')}</h1>
          <div class="empty">
            <span class="empty-mark">远</span>
            <p>${t('nav.discoverSoon')}</p>
          </div>
        </main>
      </div>`;
  }

  function renderJourneys() {
    app.innerHTML = `
      <div class="screen">
        ${topbar({ title: t('journeys.title'), back: true })}
        <main class="page has-nav">
          <h1 class="page-title">${t('journeys.title')}</h1>
          <p class="page-sub" id="journey-summary">${t('journeys.loading')}</p>

          <button class="btn primary block" data-action="new">＋ ${t('home.createTitle')}</button>

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
        if (summary) summary.textContent = t('journeys.count', { n: journeys.length });
        if (journeys.length === 0) {
          list.innerHTML = `
            <div class="empty">
              <span class="empty-mark">山</span>
              <p>${t('journeys.emptyTitle')}</p>
              <p class="muted">${t('journeys.emptySub')}</p>
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
        if (summary) summary.textContent = t('journeys.loadFailed');
        if (list) {
          list.innerHTML = `
            <div class="empty">
              <p>${esc(error.message)}</p>
              <button class="btn ghost" data-action="retry-journeys">${t('common.retry')}</button>
            </div>`;
        }
      });
  }

  function journeyCard(journey) {
    const plan = journey.plan?.items?.length ? journey.plan : null;
    const excerpt = journey.description ? esc(journey.description).replace(/\s+/g, ' ') : t('journeys.noDesc');
    const destinations = plan
      ? plan.items.map((item) => item.destination).join(' · ')
      : '';
    const when = journey.depart_time ? fmtDate(journey.depart_time) : fmtDay(journey.updated_at);
    return `
      <button class="journey-card" data-journey-id="${journey.id}">
        <span class="journey-top">
          <span class="journey-name">${esc(journey.name)}</span>
          <span class="journey-date">${esc(when)}</span>
        </span>
        ${
          destinations
            ? `<span class="journey-plan">${esc(destinations)}</span>`
            : ''
        }
        <span class="journey-excerpt">${excerpt}</span>
      </button>`;
  }

  // ---- 回忆 -----------------------------------------------------------------

  /** 回忆列表里的一段行程：名字、时间、已经攒下的回忆。 */
  function memoryJourneyCard(journey, count, thumbs) {
    const { depart, ret } = journeyRange(journey);
    const when = depart ? fmtDay(depart) : fmtDay(journey.updated_at);
    const range = ret ? `${fmtDay(depart)} – ${fmtDay(ret)}` : when;
    const preview = thumbs.length
      ? `<span class="memory-thumbs">${thumbs
          .map(
            (media) =>
              `<img src="${esc(mediaUrl(media))}" alt="" loading="lazy" />`,
          )
          .join('')}</span>`
      : '';
    return `
      <button class="memory-card" data-memory-journey="${esc(journey.id)}">
        <span class="memory-card-top">
          <span class="memory-card-name">${esc(journey.name)}</span>
          <span class="memory-card-date">${esc(range)}</span>
        </span>
        ${preview}
        <span class="memory-card-count">${
          count ? t('memories.count', { n: count }) : t('memories.noCount')
        }</span>
      </button>`;
  }

  function mediaUrl(media) {
    if (!media?.url) return '';
    return media.url;
  }

  /** 回忆页：挑一段走过的行程，给它添上照片、视频和文字。 */
  function renderMemories() {
    app.innerHTML = `
      <div class="screen">
        <main class="page has-nav">
          <h1 class="page-title">${t('memories.title')}</h1>
          <p class="page-sub">${t('memories.sub')}</p>
          <div class="memory-list" id="memory-list">
            <div class="skeleton-card"></div>
            <div class="skeleton-card"></div>
          </div>
        </main>
      </div>`;

    Promise.all([api('/api/journeys'), api('/api/memories')])
      .then(([{ journeys }, { memories, counts }]) => {
        state.journeys = journeys;
        const list = document.getElementById('memory-list');
        if (!list) return;
        if (!journeys.length) {
          list.innerHTML = `
            <div class="empty">
              <span class="empty-mark">忆</span>
              <p>${t('memories.noJourney')}</p>
              <p class="muted">${t('memories.emptySub')}</p>
            </div>`;
          return;
        }
        const thumbsByJourney = new Map();
        for (const memory of memories) {
          if (!memory.journeyId) continue;
          const key = String(memory.journeyId);
          if (!thumbsByJourney.has(key)) thumbsByJourney.set(key, []);
          const bucket = thumbsByJourney.get(key);
          for (const media of memory.media || []) {
            if (media.kind === 'image' && bucket.length < 3) bucket.push(media);
          }
        }
        // 已经走过的行程排在前面，还在路上的行程放在后面。
        const now = Date.now();
        const sorted = journeys.slice().sort((a, b) => {
          const end = (journey) => {
            const { ret } = journeyRange(journey);
            const time = ret ? Date.parse(ret) : NaN;
            return Number.isFinite(time) ? time : now;
          };
          return end(a) - end(b);
        });
        list.innerHTML = sorted
          .map((journey) =>
            memoryJourneyCard(
              journey,
              counts?.[journey.id] ?? 0,
              thumbsByJourney.get(String(journey.id)) ?? [],
            ),
          )
          .join('');
        list.querySelectorAll('[data-memory-journey]').forEach((card) => {
          card.addEventListener('click', () => navigate(`#/memories/${card.dataset.memoryJourney}`));
        });
      })
      .catch((error) => {
        const list = document.getElementById('memory-list');
        if (list) {
          list.innerHTML = `
            <div class="empty">
              <p>${esc(error.message)}</p>
              <button class="btn ghost" data-action="retry-memories">${t('common.retry')}</button>
            </div>`;
        }
      });
  }

  /** 一条回忆：文字 + 照片 / 视频。 */
  function memoryItemMarkup(memory) {
    const photos = (memory.media || []).filter((media) => media.kind === 'image');
    const videos = (memory.media || []).filter((media) => media.kind === 'video');
    return `
      <article class="memory-item">
        ${memory.note ? `<p class="memory-note">${esc(memory.note)}</p>` : ''}
        ${
          photos.length
            ? `<div class="memory-grid">${photos
                .map(
                  (media) =>
                    `<img src="${esc(mediaUrl(media))}" alt="" loading="lazy" />`,
                )
                .join('')}</div>`
            : ''
        }
        ${
          videos.length
            ? `<div class="memory-videos">${videos
                .map(
                  (media) =>
                    `<video src="${esc(mediaUrl(media))}" controls preload="metadata" playsinline></video>`,
                )
                .join('')}</div>`
            : ''
        }
        <div class="memory-item-foot">
          <span class="memory-time">${esc(fmtDate(memory.createdAt))}</span>
          <button class="link subtle" data-action="memory-delete" data-memory-id="${esc(memory.id)}">
            ${t('detail.delete')}
          </button>
        </div>
      </article>`;
  }

  /** 某段行程的回忆详情：写回忆、放照片、生成旅行回忆。 */
  function renderMemoryDetail(id) {
    state.memoryJourneyId = id;
    app.innerHTML = `
      <div class="screen">
        ${topbar({ title: t('memories.title'), back: true })}
        <main class="page has-nav" id="memory-detail">
          <div class="skeleton-block"></div>
        </main>
      </div>`;

    Promise.all([api(`/api/journeys/${id}`), api(`/api/memories?journeyId=${id}`)])
      .then(([{ journey }, { memories }]) => {
        const page = document.getElementById('memory-detail');
        if (!page) return;
        page.innerHTML = `
          <p class="eyebrow">${esc(journeyRange(journey).depart ? fmtDay(journeyRange(journey).depart) : '')}</p>
          <h1 class="page-title">${esc(journey.name)}</h1>
          ${
            journeyDestinations(journey)
              ? `<p class="page-sub">${esc(journeyDestinations(journey))}</p>`
              : ''
          }

          <section class="card panel" id="memory-composer">
            <h2 class="panel-title">${t('memories.addTitle')}</h2>
            <textarea id="memory-note" class="memory-input" rows="3"
              placeholder="${esc(t('memories.notePlaceholder'))}"></textarea>
            <div class="memory-actions">
              <label class="btn ghost" for="memory-files">${t('memories.pick')}</label>
              <input type="file" id="memory-files" accept="image/*,video/*" multiple hidden />
              <button class="btn primary" type="button" data-action="memory-save">${t('memories.save')}</button>
            </div>
            <p class="memory-files" id="memory-files-list"></p>
          </section>

          <div class="memory-actions-row">
            <button class="btn ghost block" type="button" data-action="memory-recap">${t('memories.generate')}</button>
          </div>

          <section class="memory-recap" id="memory-recap" hidden>
            <div class="card panel">
              <h2 class="panel-title">${t('memories.recapTitle')}</h2>
              <p class="memory-recap-text" id="memory-recap-text"></p>
              <button class="btn ghost block" type="button" disabled>${t('memories.share')} · ${t('memories.shareSoon')}</button>
            </div>
          </section>

          <div class="memory-items" id="memory-items">
            ${
              memories.length
                ? memories.map(memoryItemMarkup).join('')
                : `<div class="empty">
                    <span class="empty-mark">忆</span>
                    <p>${t('memories.emptyTitle')}</p>
                    <p class="muted">${t('memories.emptySub')}</p>
                  </div>`
            }
          </div>`;

        const fileInput = document.getElementById('memory-files');
        const fileList = document.getElementById('memory-files-list');
        fileInput?.addEventListener('change', () => {
          const files = [...(fileInput.files || [])];
          if (!fileList) return;
          fileList.textContent = files.length
            ? files.map((file) => file.name).join('、')
            : '';
        });
      })
      .catch((error) => {
        const page = document.getElementById('memory-detail');
        if (page) {
          page.innerHTML = `
            <div class="empty">
              <p>${esc(error.message)}</p>
              <button class="btn ghost" data-action="retry-memories">${t('common.retry')}</button>
            </div>`;
        }
      });
  }

  /** 保存一条回忆：先建文字，再一张一张上传照片 / 视频。 */
  async function saveMemory() {
    const journeyId = state.memoryJourneyId;
    const noteInput = document.getElementById('memory-note');
    const fileInput = document.getElementById('memory-files');
    const button = document.querySelector('[data-action="memory-save"]');
    const note = noteInput ? noteInput.value.trim() : '';
    const files = fileInput ? [...(fileInput.files || [])] : [];
    if (!journeyId) return;
    if (!note && !files.length) {
      toast(t('memories.needContent'), 'error');
      return;
    }
    setBusy(button, true, t('busy.saving'));
    try {
      const { memory } = await api('/api/memories', {
        method: 'POST',
        body: { journeyId: Number(journeyId), note },
      });
      let failed = 0;
      for (const file of files) {
        try {
          await api(`/api/memories/${memory.id}/media`, {
            method: 'POST',
            raw: true,
            contentType: file.type || 'application/octet-stream',
            body: file,
            timeout: 120000,
          });
        } catch {
          failed += 1;
        }
      }
      toast(failed ? t('memories.uploadFailed') : t('memories.savedToast'), failed ? 'error' : 'info');
      renderMemoryDetail(journeyId);
    } catch (error) {
      toast(error.message, 'error');
      setBusy(button, false);
    }
  }

  /** 让 AI 把这段行程的回忆写成一段话。 */
  async function generateRecap() {
    const journeyId = state.memoryJourneyId;
    const button = document.querySelector('[data-action="memory-recap"]');
    if (!journeyId) return;
    setBusy(button, true, t('memories.generating'));
    try {
      const journey = (await storeAll('journeys')).find(item=>String(item.id)===String(journeyId));
      const memories = (await storeAll('memories')).filter(item=>String(item.journeyId)===String(journeyId));
      const media = memories.flatMap(item=>item.media||[]);
      if (!(await ensureServer())) return;
      const data = await api('/api/ai/memory-recap', {
        method: 'POST',
        body: { journeyId: Number(journeyId), context: { journeyName:journey?.name||'', destination:journeyDestinations(journey||{}), departTime:journeyRange(journey||{}).depart||'', returnTime:journeyRange(journey||{}).ret||'', photos:media.filter(x=>x.kind==='image').length, videos:media.filter(x=>x.kind==='video').length, notes:memories.map(x=>x.note).filter(Boolean) } },
        timeout: 90000,
      });
      const section = document.getElementById('memory-recap');
      const text = document.getElementById('memory-recap-text');
      if (text) text.textContent = data.recap || '';
      if (section) section.hidden = false;
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      setBusy(button, false);
    }
  }

  async function deleteMemory(id) {
    if (!confirm(t('memories.deleteConfirm'))) return;
    try {
      await api(`/api/memories/${id}`, { method: 'DELETE' });
      toast(t('memories.deletedToast'));
      renderMemoryDetail(state.memoryJourneyId);
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  function renderJourneyDetail(id) {
    state.currentJourneyId = id;
    app.innerHTML = `
      <div class="screen">
        ${topbar({ title: t('detail.topbar'), back: true })}
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
            ${topbar({ title: t('detail.topbar'), back: true })}
            <main class="page">
              <div class="empty">
                <p>${esc(error.message)}</p>
                <button class="btn ghost" data-action="retry-detail">${t('common.retry')}</button>
              </div>
            </main>
          </div>`;
      });
  }

  function renderJourneyView(journey) {
    const plan = journey.plan?.items?.length ? journey.plan : null;
    app.innerHTML = `
      <div class="screen">
        ${topbar({
          title: t('detail.topbar'),
          back: true,
          right: `<button class="icon-btn" data-action="edit" aria-label="${t('detail.editAria')}">✎</button>`,
        })}
        <main class="page has-nav detail">
          <p class="eyebrow">${esc(fmtDay(journey.updated_at))}</p>
          <h1 class="detail-title">${esc(journey.name)}</h1>
          ${
            plan
              ? `
          <table class="plan-table">
            <thead>
              <tr>
                <th>${t('plan.fieldDestination')}</th>
                <th>${t('plan.fieldDepart')}</th>
                <th>${t('plan.fieldReturn')}</th>
              </tr>
            </thead>
            <tbody>
              ${plan.items
                .map(
                  (item) => `
                <tr>
                  <td>${esc(item.destination)}</td>
                  <td>${esc(fmtDate(item.departTime))}</td>
                  <td>${esc(fmtDate(item.returnTime))}</td>
                </tr>`,
                )
                .join('')}
            </tbody>
          </table>`
              : ''
          }
          <div class="detail-body">
            ${
              journey.description
                ? esc(journey.description).replace(/\n/g, '<br />')
                : `<p class="muted">${t('detail.noDesc')}</p>`
            }
          </div>
          <div class="detail-actions">
            <button class="btn ghost" data-action="edit">${t('detail.edit')}</button>
            <button class="btn danger" data-action="delete">${t('detail.delete')}</button>
          </div>
        </main>
      </div>`;
  }

  function renderJourneyEdit(journey) {
    app.innerHTML = `
      <div class="screen">
        ${topbar({ title: t('edit.title'), back: true })}
        <main class="page">
          <h1 class="page-title">${t('edit.title')}</h1>
          <p class="page-sub">${t('edit.sub')}</p>

          <form id="edit-form" class="form" novalidate>
            <label class="field">
              <span>${t('field.name')}</span>
              <input id="edit-name" maxlength="80" value="${esc(journey.name)}" required />
            </label>
            <label class="field">
              <span>${t('field.desc')}</span>
              <textarea id="edit-desc" maxlength="5000" rows="7">${esc(journey.description)}</textarea>
            </label>

            <div class="ai-row">
              <button type="button" class="btn ghost" id="edit-ai">${t('ai.rewrite')}</button>
              <span class="ai-hint">${t('ai.rewriteHint')}</span>
            </div>

            <p class="form-error" id="edit-error" hidden></p>
            <div class="row">
              <button class="btn ghost" type="button" data-action="cancel-edit">${t('edit.cancel')}</button>
              <button class="btn primary" type="submit">${t('edit.save')}</button>
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
      if (!name) return showError('edit-error', t('edit.errName'));

      const button = form.querySelector('button[type="submit"]');
      setBusy(button, true, t('busy.saving'));
      try {
        const { journey: updated } = await api(`/api/journeys/${journey.id}`, {
          method: 'PUT',
          body: { name, description: descInput.value.trim() },
        });
        state.currentJourney = updated;
        toast(t('journey.savedToast'));
        renderJourneyView(updated);
      } catch (error) {
        showError('edit-error', error.message);
        setBusy(button, false);
      }
    });
  }

  function renderMe() {
    const places = (state.journeys || []).filter((journey) => journey.destination || journey.name);
    const pins = places.slice(0, 12).map((journey, index) => `<span class="footprint-pin pin-${index % 6}" title="${esc(journey.destination || journey.name)}">•</span>`).join('');
    const displayName = state.user?.displayName || state.user?.email?.split('@')[0] || t('nav.me');
    app.innerHTML = `<div class="screen me-screen"><header class="me-head"><button type="button" class="me-name-edit" id="me-name-edit">${esc(displayName)}</button><button class="gear-btn" data-action="settings" aria-label="${t('settings.title')}">⚙</button></header><main class="page me-page"><button class="footprint-card" data-action="journeys"><div class="footprint-copy"><strong>${t('me.footprints')}</strong><span id="footprint-count">${places.length} ${t('me.destinations', { n: places.length })}</span></div><div class="footprint-map" aria-label="${t('me.worldFootprints')}"><svg viewBox="0 0 720 330" role="img"><path d="M45 90 82 50 154 38 194 62 220 51 250 80 225 111 195 117 177 151 144 158 129 194 92 190 74 156 48 142ZM230 188 266 176 299 193 309 229 289 267 265 292 245 259 232 230ZM320 80 362 58 404 63 418 79 451 65 495 79 530 100 573 96 622 130 606 155 565 145 538 171 499 162 469 189 439 179 424 151 396 144 373 163 346 145 318 130ZM433 193 461 184 490 204 496 239 474 266 449 243Z"/></svg><span id="footprint-pins">${pins}</span></div><p>${t('me.footprintsSub')}</p></button></main></div>`;

    const nameButton = document.getElementById('me-name-edit');
    nameButton?.addEventListener('click', () => {
      const originalName = state.user?.displayName || state.user?.email?.split('@')[0] || t('nav.me');
      const input = document.createElement('input');
      input.className = 'me-name-input';
      input.type = 'text';
      input.maxLength = 40;
      input.autocomplete = 'nickname';
      input.setAttribute('aria-label', t('me.editNickname'));
      input.value = originalName;
      nameButton.hidden = true;
      nameButton.parentElement.insertBefore(input, nameButton.nextSibling);
      input.focus();
      input.select();

      let saving = false;
      const restoreName = (name) => {
        if (input.isConnected) input.remove();
        nameButton.textContent = name;
        nameButton.hidden = false;
      };
      const saveName = async () => {
        if (saving || !input.isConnected) return;
        const nextName = input.value.trim();
        if (!nextName) {
          toast(t('me.nicknameEmpty'), 'error');
          input.focus();
          return;
        }
        if (nextName === originalName) {
          restoreName(originalName);
          return;
        }
        saving = true;
        input.disabled = true;
        try {
          const result = await api('/api/me/profile', { method: 'PUT', body: { displayName: nextName } });
          state.user = { ...state.user, displayName: result.displayName };
          cacheUser(state.user);
          restoreName(result.displayName);
          toast(t('me.nicknameSaved'));
        } catch (error) {
          saving = false;
          input.disabled = false;
          toast(error.message, 'error');
          input.focus();
          input.select();
        }
      };
      input.addEventListener('blur', saveName);
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') { event.preventDefault(); input.blur(); }
        if (event.key === 'Escape') { event.preventDefault(); restoreName(originalName); }
      });
    });

    api('/api/journeys').then(({ journeys }) => {
      state.journeys = journeys;
      if (parseRoute().name !== 'me') return;
      const count = document.getElementById('footprint-count');
      const markers = document.getElementById('footprint-pins');
      if (count) count.textContent = `${journeys.length} ${t('me.destinations', { n: journeys.length })}`;
      if (markers) markers.innerHTML = journeys.filter((journey) => journey.destination || journey.name).slice(0, 12).map((journey, index) => `<span class="footprint-pin pin-${index % 6}" title="${esc(journey.destination || journey.name)}">•</span>`).join('');
    }).catch(() => {});
  }

  async function refreshAccountSettings({ notify = false } = {}) {
    if (!state.token || !state.server) throw new Error(t('api.noServer'));
    const { user: serverUser } = await api('/api/me');
    const user = await hydrateClientProfile(serverUser);
    const previous = state.user || {};
    const changed = ['email', 'pendingEmail', 'pendingEmailExpiresAt', 'pendingResetExpiresAt', 'displayName'].some((key) => (previous[key] || null) !== (user[key] || null));
    state.user = user;
    cacheUser(user);
    const route = parseRoute();
    if (changed && route.name === 'settings' && route.section === 'account-security') renderSettings({ refreshProfile: false });
    if (notify) toast(changed ? t('account.updated') : t('account.upToDate'));
    return changed;
  }

  function bindAccountPullRefresh() {
    const page = document.querySelector('.account-security-page');
    const status = document.getElementById('account-refresh-status');
    if (!page || !status) return;
    let startY = null;
    let armed = false;
    const atTop = () => window.scrollY <= 0 && document.documentElement.scrollTop <= 0;
    page.addEventListener('touchstart', (event) => {
      if (!atTop() || event.target.closest('input,button,textarea,select')) { startY = null; return; }
      startY = event.touches[0]?.clientY ?? null;
      armed = false;
    }, { passive: true });
    page.addEventListener('touchmove', (event) => {
      if (startY === null || !atTop()) return;
      const distance = (event.touches[0]?.clientY ?? startY) - startY;
      if (distance < 0) return;
      if (distance >= 58) {
        armed = true;
        status.hidden = false;
        status.textContent = t('account.pullRefresh');
        if (event.cancelable) event.preventDefault();
      }
    }, { passive: false });
    const finish = async () => {
      if (startY === null) return;
      startY = null;
      if (!armed) { status.hidden = true; return; }
      status.hidden = false;
      status.textContent = t('account.refreshing');
      try { await refreshAccountSettings({ notify: true }); }
      catch (error) { toast(error.message, 'error'); }
      if (status.isConnected) { status.textContent = t('account.refreshed'); setTimeout(() => { if (status.isConnected) status.hidden = true; }, 900); }
    };
    page.addEventListener('touchend', finish, { passive: true });
    page.addEventListener('touchcancel', finish, { passive: true });
  }

  function renderSettings({ publicView = false, refreshProfile = true } = {}) {
    const route = parseRoute();
    const section = route.section || '';
    if (section === 'data') { navigate('#/database'); return; }
    if (publicView) {
      const emailChanged = route.query.emailChanged === '1';
      app.innerHTML = `<div class="screen settings-screen"><main class="page settings-page email-result-page"><section class="email-verified-result" role="status"><span class="email-result-check" aria-hidden="true">✓</span><h1>${emailChanged ? t('settings.emailUpdated') : t('settings.title')}</h1><p>${emailChanged ? t('settings.emailUpdatedBody') : t('settings.publicSub')}</p>${emailChanged ? `<p class="email-result-note">${t('settings.returnToApp')}</p>` : ''}<button class="btn primary block" data-action="login">${emailChanged ? t('settings.goSignIn') : t('settings.goLogin')}</button></section></main></div>`;
      return;
    }
    if (!publicView && !section) {
      const entries = [['language',t('settings.languageTitle'),'globe'],['account-security',t('settings.accountSecurity'),'person'],['origin',t('settings.originTitle'),'origin'],['data',t('settings.dataBackup'),'data'],['about',t('settings.aboutTitle'),'about']];
      const iconSvg = (icon) => {
        if (icon === 'globe') return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/></svg>';
        if (icon === 'person') return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.5"/><path d="M4.5 20c.6-4 3.2-6 7.5-6s6.9 2 7.5 6"/></svg>';
        if (icon === 'origin') return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 3v4M12 17v4M3 12h4M17 12h4"/></svg>';
        if (icon === 'data') return '<svg viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></svg>';
        if (icon === 'about') return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 10v6M12 7h.01"/></svg>';
        return icon;
      };
      app.innerHTML = `<div class="screen settings-screen"><main class="page settings-page"><div class="settings-group">${entries.map(([id,label,icon])=>`<button class="system-row" data-action="settings-section" data-section="${id}"><span class="system-icon">${iconSvg(icon)}</span><span>${label}</span><b>›</b></button>`).join('')}</div></main></div>`;
      return;
    }
    const sectionTitles = {
      language: t('settings.languageTitle'),
      'account-security': t('settings.accountSecurity'),
      origin: t('settings.originTitle'),
      data: t('settings.dataBackup'),
      about: t('settings.aboutTitle'),
    };
    const panel = (id, html) => (section === id || (publicView && id === 'language')) ? html : '';
    const pendingEmailActive = Boolean(state.user?.pendingEmail && Date.parse(state.user.pendingEmailExpiresAt || '') > Date.now());
    const pendingResetActive = Boolean(state.user?.pendingResetExpiresAt && Date.parse(state.user.pendingResetExpiresAt) > Date.now());
    const emailChangedNotice = section === 'account-security' && route.query.emailChanged === '1';
    app.innerHTML = `
      <div class="screen settings-screen">
        <main class="page settings-page settings-detail${section === 'account-security' ? ' account-security-page' : ''}">
          ${emailChangedNotice ? `<div class="email-updated-banner" role="status"><strong>${t('settings.emailUpdated')}</strong><span>${t('settings.emailUpdatedShort')}</span></div>` : ''}
          ${section === 'account-security' ? `<div class="account-refresh-status" id="account-refresh-status" role="status" hidden></div>` : ''}
          ${panel('language', `<section class="card panel"><div class="lang-panel">${languageSwitcher()}</div></section>`)}
          ${panel('origin', `<section class="card panel origin-panel">
            <div id="origin-list" class="origin-address-list"></div>
            <button class="btn primary block" type="button" id="origin-add">＋ ${esc(t('settings.originAdd') || '新增地点')}</button>
            <p class="form-error" id="origin-error" hidden></p>
          </section>
          <div id="origin-picker" class="origin-picker" hidden>
            <div class="origin-picker-head">
              <button type="button" class="btn ghost" id="origin-picker-back">取消</button>
              <button type="button" class="btn primary" id="origin-picker-confirm" disabled>确定</button>
            </div>
            <div id="origin-picker-body" class="origin-picker-body">
              <div class="origin-picker-map-wrap">
                <div id="origin-picker-map" class="origin-picker-map"></div>
                <div class="origin-picker-center-pin" aria-hidden="true"></div>
                <button type="button" class="origin-picker-locate" id="origin-picker-locate" aria-label="回到当前位置">◎</button>
              </div>
              <div id="origin-picker-drag" class="origin-picker-drag" role="separator" aria-label="拖动调整"><span></span></div>
              <div class="origin-picker-list-panel">
                <div class="origin-picker-search"><input id="origin-picker-query" type="search" placeholder="搜索地点" /></div>
                <div class="origin-picker-list-body">
                  <div id="origin-picker-pois" class="origin-picker-pois"></div>
                  <div id="origin-picker-search-results" class="origin-picker-search-results" hidden></div>
                </div>
              </div>
            </div>
          </div>`)}
          ${publicView ? `<section class="card panel"><p class="panel-sub">${t('settings.publicSub')}</p><button class="btn primary block" data-action="login">${t('settings.goLogin')}</button></section>` : ''}
          ${panel('account-security', `<section class="account-settings-group account-profile-group"><h2 class="settings-group-heading">${t('settings.accountInfo')}</h2><div class="current-email-block"><span class="account-field-title">${t('settings.email')}</span><strong>${esc(state.user.email || '—')}</strong></div><form id="email-form" class="account-edit-form" novalidate><label class="account-edit-field"><span>${t('settings.newEmail')}</span><input name="email" type="email" maxlength="254" inputmode="email" autocomplete="email" placeholder="${t('settings.newEmailPlaceholder')}" required /></label><p class="form-error" id="email-error" hidden></p><button class="btn primary account-action" type="submit">${t('settings.sendVerificationEmail')}</button></form><div id="pending-email-status" class="pending-email-status" ${pendingEmailActive?'':'hidden'}><button class="status-close-btn" type="button" data-dismiss-status="pending-email-status" aria-label="${t('settings.close')}">×</button><strong>${t('settings.verificationSentTo')} ${esc(pendingEmailActive ? state.user.pendingEmail : '')}</strong><p>${t('settings.verificationHint', { date: pendingEmailActive ? fmtDate(state.user.pendingEmailExpiresAt) : '' })}</p><small>${t('settings.verificationNote')}</small><p>${t('pending.resendHint')}</p><button class="btn ghost block account-action" id="resend-email-btn" type="button">${t('pending.resend')}</button></div></section><section class="account-settings-group"><h2 class="settings-group-heading">${t('settings.passwordTitle')}</h2><p class="panel-sub">${t('settings.passwordSub')}</p><form id="password-form" class="form compact" novalidate><label class="field"><span>${t('settings.currentPassword')}</span><input name="currentPassword" type="password" maxlength="128" autocomplete="current-password" placeholder="${t('settings.currentPlaceholder')}" required /></label><label class="field"><span>${t('reset.newPasswordLabel')}</span><input name="newPassword" type="password" minlength="8" maxlength="128" autocomplete="new-password" placeholder="${t('auth.passwordPlaceholderRegister')}" required /></label><label class="field"><span>${t('reset.confirmLabel')}</span><input name="confirm" type="password" maxlength="128" autocomplete="new-password" placeholder="${t('auth.confirmPlaceholder')}" required /></label><p class="form-error" id="password-error" hidden></p><p class="form-ok" id="password-ok" hidden></p><button class="btn primary block account-action" type="submit">${t('settings.updatePassword')}</button></form></section><section class="account-settings-group"><h2 class="settings-group-heading">${t('settings.resetPassword')}</h2><p class="panel-sub">${t('settings.resetPasswordSub')}</p><div id="pending-reset-status" class="pending-email-status pending-reset-status" ${pendingResetActive?'':'hidden'}><button class="status-close-btn" type="button" data-dismiss-status="pending-reset-status" aria-label="${t('settings.close')}">×</button><strong>${t('forgot.sentTo',{email:state.user.email || ''})}</strong><p>${t('forgot.expires',{date:fmtDate(state.user.pendingResetExpiresAt)})}</p><small>${t('forgot.notReceived')}</small><button class="btn ghost block account-action" id="resend-reset-btn" type="button">${t('forgot.resend')}</button></div><button class="btn ghost block account-action" id="reset-password-btn" type="button">${t('forgot.submit')}</button></section><section class="account-settings-group account-logout-group"><button class="btn account-logout block" data-action="logout">${t('home.logout')}</button></section>`) }
          ${panel('data', `<section class="card panel"><p class="panel-sub">${t('settings.dataSub')}</p><button class="btn ghost block" data-action="database-open">${t('settings.openDatabase')}</button></section>`)}
          ${panel('about', `<section class="card panel about-panel"><img class="about-icon" src="logo.png" alt="${esc(t('settings.aboutTitle'))}" /><h2 class="about-name">小熊猫 · Red Panda</h2><p class="about-tagline">出门带只小熊猫</p><p class="about-meta">v${esc(window.REDPANDA_CONFIG?.version || '1.0.0')}</p><a class="about-email" href="mailto:jianghang2020@gmail.com">jianghang2020@gmail.com</a></section>`)}
        </main>
      </div>`;

    app.querySelectorAll('[data-dismiss-status]').forEach((button) => {
      button.addEventListener('click', () => {
        const target = document.getElementById(button.dataset.dismissStatus);
        if (target) target.hidden = true;
      });
    });

    if (!publicView && section === 'account-security') {
      if (refreshProfile && state.token) refreshAccountSettings().catch(() => {});
      bindAccountPullRefresh();
    }

    const emailForm = document.getElementById('email-form');
    emailForm?.addEventListener('submit', async (event) => {
      event.preventDefault(); hideError('email-error');
      const email = emailForm.elements.email.value.trim();
      if (!email) { showError('email-error', t('settings.errEmailEmpty')); return; }
      const button = emailForm.querySelector('button[type="submit"]'); setBusy(button, true, t('busy.sending'));
      try {
        if (!(await ensureServer())) return;
        const result = await api('/api/me/email', { method: 'PUT', body: { email, locale: getLocale() } });
        state.user = { ...state.user, pendingEmail: result.pendingEmail || null, pendingEmailExpiresAt: result.pendingEmailExpiresAt || null };
        cacheUser(state.user); emailForm.reset();
        if (result.pendingEmail) { toast(t('settings.emailSentToast')); renderSettings(); }
        else { toast(t('settings.emailCancelledToast')); renderSettings(); }
      } catch (error) { showError('email-error', error.message); }
      finally { if (button.isConnected) setBusy(button, false); }
    });

    const resendEmailButton = document.getElementById('resend-email-btn');
    resendEmailButton?.addEventListener('click', async () => {
      const email = state.user?.pendingEmail;
      if (!email) return;
      const scrollY = window.scrollY;
      setBusy(resendEmailButton, true, t('pending.sending'));
      try {
        if (!(await ensureServer())) return;
        const result = await api('/api/me/email', { method: 'PUT', body: { email, locale: getLocale() } });
        state.user = { ...state.user, pendingEmail: result.pendingEmail || null, pendingEmailExpiresAt: result.pendingEmailExpiresAt || null };
        cacheUser(state.user);
        toast(t('settings.emailResentToast'));
        renderSettings();
        window.scrollTo(0, scrollY);
      } catch (error) {
        toast(error.message, 'error');
      } finally {
        if (resendEmailButton.isConnected) setBusy(resendEmailButton, false);
      }
    });

    if (pendingEmailActive) {
      const pendingEmail = state.user.pendingEmail;
      const pendingExpiresAt = Date.parse(state.user.pendingEmailExpiresAt);
      setTimeout(() => {
        if (state.user?.pendingEmail !== pendingEmail || Date.now() < pendingExpiresAt) return;
        state.user = { ...state.user, pendingEmail: null, pendingEmailExpiresAt: null };
        cacheUser(state.user);
        if (parseRoute().name === 'settings' && parseRoute().section === 'account-security') renderSettings();
      }, Math.max(1, pendingExpiresAt - Date.now() + 50));
    }

    if (pendingResetActive) {
      const resetExpiry = state.user.pendingResetExpiresAt;
      const resetExpiresAt = Date.parse(resetExpiry);
      setTimeout(() => {
        if (state.user?.pendingResetExpiresAt !== resetExpiry || Date.now() < resetExpiresAt) return;
        state.user = { ...state.user, pendingResetExpiresAt: null };
        cacheUser(state.user);
        if (parseRoute().name === 'settings' && parseRoute().section === 'account-security') renderSettings();
      }, Math.max(1, resetExpiresAt - Date.now() + 50));
    }

    const passwordForm = document.getElementById('password-form');
    // 常用地址：列表 + 腾讯地图选点（仿微信发送位置）
    const currentOrigins = () => Array.isArray(state.user.usualOrigin) ? [...state.user.usualOrigin] : [];
    const saveOrigins = async (origins) => {
      const result = await api('/api/me/usual-origin', { method: 'PUT', body: { origins } });
      state.user.usualOrigin = result.usualOrigin || origins;
      localStorage.setItem(STORAGE.user, JSON.stringify(state.user));
      renderOrigins();
    };
    const renderOrigins = () => {
      const list = document.getElementById('origin-list');
      if (!list) return;
      const origins = currentOrigins();
      list.innerHTML = origins.map((o, i) => `<div class="origin-item"><div class="origin-item-main"><strong>${esc(o.name || o.address || '—')}</strong><small>${esc(o.address || [o.district,o.city,o.province].filter(Boolean).join('') || '')}</small></div><button type="button" class="origin-delete" data-origin-delete="${i}" aria-label="删除">×</button></div>`).join('')
        || `<p class="origin-empty">${esc(t('settings.originEmpty') || '还没有常用地址')}</p>`;
    };
    renderOrigins();
    document.getElementById('origin-list')?.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-origin-delete]');
      if (!btn) return;
      const idx = Number(btn.dataset.originDelete);
      const origins = currentOrigins();
      origins.splice(idx, 1);
      try { await saveOrigins(origins); } catch (err) { showError('origin-error', err.message); }
    });

    let tmap = null, tmapReady = null, pickerMapRatio = 0.55, myLocationMarker = null, currentPos = null;
    async function ensureTencentMap() {
      if (window.TMap) return window.TMap;
      if (tmapReady) return tmapReady;
      tmapReady = (async () => {
        const cfg = await api('/api/map/config').catch(() => ({}));
        const key = cfg.tencentKey;
        if (!key) throw new Error('未配置腾讯地图 Key，请在服务器设置 TENCENT_MAP_KEY');
        await new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = `https://map.qq.com/api/gljs?v=1.exp&key=${encodeURIComponent(key)}`;
          s.onload = resolve; s.onerror = () => reject(new Error('腾讯地图加载失败'));
          document.head.appendChild(s);
        });
        return window.TMap;
      })();
      return tmapReady;
    }

    const picker = document.getElementById('origin-picker');
    const pickerBody = document.getElementById('origin-picker-body');
    const poisEl = document.getElementById('origin-picker-pois');
    const mapEl = document.getElementById('origin-picker-map');
    const mapWrap = mapEl?.parentElement;
    const listPanel = document.querySelector('.origin-picker-list-panel');
    const dragEl = document.getElementById('origin-picker-drag');
    const confirmBtn = document.getElementById('origin-picker-confirm');
    const searchInput = document.getElementById('origin-picker-query');
    const searchResults = document.getElementById('origin-picker-search-results');
    const locateBtn = document.getElementById('origin-picker-locate');
    let selectedPoi = null, nearbyPois = [], suppressMove = false, moveTimer = null, searchSeq = 0;

    function applyPickerRatio() {
      if (!pickerBody || !mapWrap || !listPanel) return;
      const h = pickerBody.clientHeight || 400;
      const dragH = dragEl ? dragEl.offsetHeight : 18;
      const mapH = Math.max(140, Math.min(h - 160 - dragH, Math.round((h - dragH) * pickerMapRatio)));
      mapWrap.style.height = mapH + 'px';
      listPanel.style.height = (h - mapH - dragH) + 'px';
      if (tmap && typeof tmap.resize === 'function') setTimeout(() => { try { tmap.resize(); } catch {} }, 0);
    }
    dragEl?.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const startY = e.clientY, startRatio = pickerMapRatio;
      const onMove = (ev) => {
        const h = pickerBody.clientHeight || 400;
        const dy = ev.clientY - startY;
        pickerMapRatio = Math.max(0.2, Math.min(0.8, startRatio + dy / h));
        applyPickerRatio();
      };
      const onUp = () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });

    function setMyLocation(lat, lng) {
      if (!tmap || !window.TMap || !Number.isFinite(lat) || !Number.isFinite(lng)) return;
      currentPos = { lat, lng };
      const pos = new TMap.LatLng(lat, lng);
      if (!myLocationMarker) {
        myLocationMarker = new TMap.MultiMarker({
          map: tmap,
          styles: { dot: new TMap.MarkerStyle({ width: 18, height: 18, anchor: { x: 9, y: 9 }, src: 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18"><circle cx="9" cy="9" r="7" fill="#2f7cff" stroke="white" stroke-width="3"/></svg>') }) },
          geometries: [{ id: 'me', styleId: 'dot', position: pos }],
        });
      } else {
        myLocationMarker.updateGeometries([{ id: 'me', styleId: 'dot', position: pos }]);
      }
    }

    function renderPois(pois, selectedId) {
      nearbyPois = pois || [];
      if (!poisEl) return;
      poisEl.innerHTML = nearbyPois.map((p, i) => {
        const active = (selectedId != null ? (p.id && p.id === selectedId) || (!p.id && selectedId === i) : i === 0) ? ' active' : '';
        const dist = p.distance != null ? `<span class="poi-dist">${p.distance < 1000 ? Math.round(p.distance) + 'm' : (p.distance/1000).toFixed(1)+'km'}</span>` : '';
        return `<button type="button" class="origin-poi${active}" data-poi-index="${i}"><div class="poi-main"><strong>${esc(p.name || '位置')}</strong><small>${esc(p.address || '')}</small></div>${dist}<span class="poi-check">✓</span></button>`;
      }).join('') || `<p class="origin-empty">附近没有找到地点</p>`;
      if (nearbyPois.length) {
        let idx = 0;
        if (selectedId != null) {
          idx = nearbyPois.findIndex((p, i) => (p.id && p.id === selectedId) || (!p.id && selectedId === i));
          if (idx < 0) idx = 0;
        }
        selectedPoi = nearbyPois[idx] || null;
        confirmBtn.disabled = !selectedPoi;
      } else { selectedPoi = null; confirmBtn.disabled = true; }
    }
    poisEl?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-poi-index]');
      if (!btn) return;
      const poi = nearbyPois[Number(btn.dataset.poiIndex)];
      if (!poi) return;
      selectedPoi = poi; confirmBtn.disabled = false;
      renderPois(nearbyPois, poi.id || Number(btn.dataset.poiIndex));
    });

    async function fetchNearby(lat, lng) {
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
      try {
        const data = await api('/api/me/usual-origin/nearby', { method: 'POST', body: { lat, lng } });
        const pois = Array.isArray(data.pois) ? data.pois : [];
        pois.sort((a,b) => (a.distance ?? 1e9) - (b.distance ?? 1e9));
        renderPois(pois, selectedPoi?.id);
      } catch (err) { if (poisEl) poisEl.innerHTML = `<p class="form-error">${esc(err.message || '获取附近地点失败')}</p>`; }
    }

    function locateTo(lat, lng, zoom = 17) {
      if (!tmap || !window.TMap) return;
      const c = new TMap.LatLng(lat, lng);
      suppressMove = true;
      tmap.setCenter(c);
      if (zoom) tmap.setZoom(zoom);
      setTimeout(() => { suppressMove = false; fetchNearby(lat, lng); }, 0);
    }
    function locateCurrent() {
      if (!navigator.geolocation) { const c = tmap?.getCenter(); if (c) fetchNearby(c.getLat(), c.getLng()); return; }
      navigator.geolocation.getCurrentPosition((pos) => {
        setMyLocation(pos.coords.latitude, pos.coords.longitude);
        locateTo(pos.coords.latitude, pos.coords.longitude, 17);
      }, () => { const c = tmap?.getCenter(); if (c) fetchNearby(c.getLat(), c.getLng()); }, { enableHighAccuracy: true, timeout: 8000 });
    }

    async function openPicker() {
      if (!picker) return;
      hideError('origin-error');
      try { await ensureTencentMap(); } catch (err) { showError('origin-error', err.message); return; }
      picker.hidden = false;
      applyPickerRatio();
      selectedPoi = null; nearbyPois = []; confirmBtn.disabled = true;
      if (searchInput) searchInput.value = '';
      if (searchResults) searchResults.hidden = true;
      if (poisEl) poisEl.innerHTML = '<p class="origin-empty">正在获取附近地点…</p>';
      if (!tmap) {
        const center = new TMap.LatLng(39.908823, 116.397470);
        tmap = new TMap.Map(mapEl, { center, zoom: 16, viewMode: '2D' });
        tmap.on('idle', () => {
          if (suppressMove) return;
          clearTimeout(moveTimer);
          moveTimer = setTimeout(() => {
            const c = tmap.getCenter();
            if (c) fetchNearby(c.getLat(), c.getLng());
          }, 300);
        });
      }
      setTimeout(() => applyPickerRatio(), 0);
      locateCurrent();
    }

    function closePicker() { if (picker) picker.hidden = true; if (searchResults) searchResults.hidden = true; }
    document.getElementById('origin-add')?.addEventListener('click', openPicker);
    document.getElementById('origin-picker-back')?.addEventListener('click', closePicker);
    locateBtn?.addEventListener('click', locateCurrent);
    confirmBtn?.addEventListener('click', async () => {
      if (!selectedPoi) return;
      const origin = { name: selectedPoi.name || '', address: selectedPoi.address || '', lat: selectedPoi.lat, lng: selectedPoi.lng, province: selectedPoi.province || '', city: selectedPoi.city || '', district: selectedPoi.district || '' };
      try {
        await saveOrigins([...currentOrigins(), origin]);
        toast(t('settings.originSaved') || '常用地址已保存');
        closePicker();
      } catch (err) { toast(err.message, 'error'); }
    });

    searchInput?.addEventListener('input', () => {
      const q = (searchInput.value || '').trim();
      const seq = ++searchSeq;
      clearTimeout(searchInput._timer);
      if (!q) { if (searchResults) searchResults.hidden = true; return; }
      searchInput._timer = setTimeout(async () => {
        try {
          const c = tmap?.getCenter();
          const body = { keyword: q };
          if (c) { body.lat = c.getLat(); body.lng = c.getLng(); }
          const data = await api('/api/me/usual-origin/search', { method: 'POST', body });
          if (seq !== searchSeq) return;
          const pois = Array.isArray(data.pois) ? data.pois : [];
          if (!searchResults) return;
          searchResults.innerHTML = pois.map((p, i) => `<button type="button" class="origin-poi" data-search-index="${i}"><div class="poi-main"><strong>${esc(p.name||'')}</strong><small>${esc(p.address||'')}</small></div></button>`).join('') || '<p class="origin-empty">没有找到地点</p>';
          searchResults._pois = pois;
          searchResults.hidden = false;
        } catch {}
      }, 350);
    });
    searchResults?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-search-index]');
      if (!btn) return;
      const poi = (searchResults._pois || [])[Number(btn.dataset.searchIndex)];
      if (!poi || !tmap) return;
      if (searchResults) searchResults.hidden = true;
      if (searchInput) searchInput.value = poi.name || '';
      if (Number.isFinite(poi.lat) && Number.isFinite(poi.lng)) {
        locateTo(poi.lat, poi.lng, 17);
        selectedPoi = poi;
      }
    });


    if (passwordForm) {
      passwordForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        hideError('password-error');
        const ok = document.getElementById('password-ok');
        ok.hidden = true;

        const currentPassword = passwordForm.currentPassword.value;
        const newPassword = passwordForm.newPassword.value;
        if (!currentPassword) return showError('password-error', t('settings.errCurrent'));
        if (newPassword.length < 8) return showError('password-error', t('settings.errNewLength'));
        if (newPassword !== passwordForm.confirm.value) {
          return showError('password-error', t('settings.errNewConfirm'));
        }

        const button = passwordForm.querySelector('button[type="submit"]');
        setBusy(button, true, t('busy.updating'));
        try {
          await api('/api/me/password', {
            method: 'PUT',
            body: { currentPassword, newPassword },
          });
          passwordForm.reset();
          ok.textContent = t('settings.updatedOk');
          ok.hidden = false;
          toast(t('settings.updatedToast'));
        } catch (error) {
          showError('password-error', error.message);
        } finally {
          setBusy(button, false);
        }
      });
    }

    const resetPasswordButtons = [
      document.getElementById('reset-password-btn'),
      document.getElementById('resend-reset-btn'),
    ].filter(Boolean);
    resetPasswordButtons.forEach((resetPasswordButton) => {
      resetPasswordButton.addEventListener('click', async () => {
        const email = state.user?.email;
        if (!email) return;
        const scrollY = window.scrollY;
        setBusy(resetPasswordButton, true, t('forgot.sending'));
        try {
          if (!(await ensureServer())) { setBusy(button, false); return; }
          const result = await api('/api/me/password-reset', {
            method: 'POST',
            body: { locale: getLocale() },
          });
          state.user = { ...state.user, pendingResetExpiresAt: result.pendingResetExpiresAt };
          cacheUser(state.user);
          toast(t('forgot.sent'));
          renderSettings();
          window.scrollTo(0, scrollY);
        } catch (error) {
          toast(error.message, 'error');
        } finally {
          if (resetPasswordButton.isConnected) setBusy(resetPasswordButton, false);
        }
      });
    });
  }

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
    toast(t('logout.toast'));
    historyDepth = 0;
    history.replaceState(null, '', '#/login');
    render();
  }

  async function deleteCurrentJourney() {
    const journey = state.currentJourney;
    if (!journey) return;
    if (!confirm(t('journey.deleteConfirm', { name: journey.name }))) return;
    try {
      await api(`/api/journeys/${journey.id}`, { method: 'DELETE' });
      toast(t('journey.deletedToast'));
      state.currentJourney = null;
      navigate('#/journeys');
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  function handleAction(event) {
    const langTarget = event.target.closest('[data-lang]');
    if (langTarget) {
      setLocale(langTarget.dataset.lang);
      return;
    }
    const target = event.target.closest('[data-action]');
    if (!target) return;
    switch (target.dataset.action) {
      case 'retry-server':
        retryServer();
        break;
      case 'backup-export':
        exportBackup().catch(error=>{backupStatus(`${t('backup.exportFailed')}: ${error.message}`,null,'error');toast(error.message,'error');});
        break;
      case 'database-open':
        navigate('#/database');
        break;
      case 'database-sort-count':
        databaseSort='count'; drawDatabaseTypes(); break;
      case 'database-sort-size':
        databaseSort='size'; drawDatabaseTypes(); break;
      case 'settings-section':
        if (target.dataset.section === 'data') { navigate('#/database'); break; }
        replaceHash(`#/settings/${target.dataset.section}`);
        render();
        break;
      case 'settings-home':
        replaceHash('#/settings');
        render();
        break;
      case 'settings':
        navigate('#/settings');
        break;
      case 'me':
        navigateTab('#/me');
        break;
      case 'new': {
        const drafts = sortedDrafts();
        if (drafts.length > 0 && !draftOverlayOpen) {
          // 有草稿：就地在当前页面浮出草稿列表，加号冷却两秒，不切换页面。
          openDraftOverlay();
          break;
        }
        if (draftOverlayOpen) {
          if (Date.now() < createCooldownUntil) break;
          // 冷却结束：创建全新旅程。
          resetPlanState();
          leaveOverlayTo('#/new');
          break;
        }
        resetPlanState();
        navigate('#/new');
        break;
      }
      case 'journeys':
        if (draftOverlayOpen) leaveOverlayTo('#/journeys');
        else navigate('#/journeys');
        break;
      case 'memories':
        if (draftOverlayOpen) leaveOverlayTo('#/memories');
        else navigateTab('#/memories');
        break;
      case 'discover':
        if (draftOverlayOpen) leaveOverlayTo('#/discover');
        else navigateTab('#/discover');
        break;
      case 'current-journey':
        // 行程页就是默认页面，和加号浮出草稿时的背景是同一页。
        if (draftOverlayOpen) leaveOverlayTo('#/');
        else navigateTab('#/');
        break;
      case 'trip-open': {
        const id = target.dataset.journeyId;
        if (id) navigate(`#/journey/${id}`);
        break;
      }
      case 'all-journeys':
        navigate('#/journeys');
        break;
      case 'memory-save':
        saveMemory();
        break;
      case 'memory-recap':
        generateRecap();
        break;
      case 'memory-delete':
        deleteMemory(target.dataset.memoryId);
        break;
      case 'home':
        navigateTab('#/');
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
      case 'register':
        navigate('#/register');
        break;
      case 'forgot':
        navigate('#/forgot');
        break;
      case 'retry':
        init();
        break;
      case 'retry-journeys':
        renderJourneys();
        break;
      case 'retry-memories':
        if (state.memoryJourneyId) renderMemoryDetail(state.memoryJourneyId);
        else renderMemories();
        break;
      case 'retry-detail':
        if (state.currentJourneyId) renderJourneyDetail(state.currentJourneyId);
        break;
      case 'edit':
        if (state.currentJourney) renderJourneyEdit(state.currentJourney);
        break;
      case 'plan-confirm':
        confirmPlanInput();
        break;
      case 'plan-save':
        savePlanAsJourney();
        break;
      case 'plan-draft': {
        const draft = loadDrafts().find((entry) => entry.id === target.dataset.draftId);
        if (!draft) break;
        pendingDraft = draft;
        leaveOverlayTo('#/new');
        break;
      }
      case 'plan-draft-expand': {
        const id = target.dataset.draftId;
        expandedDraftId = expandedDraftId === id ? null : id;
        refreshDraftList();
        break;
      }
      case 'plan-draft-delete': {
        removeDraft(target.dataset.draftId);
        expandedDraftId = null;
        refreshDraftList();
        break;
      }
      case 'plan-edit':
        planState.editing = true;
        planState.editingItem = null;
        planState.error = '';
        renderNewJourney();
        break;
      case 'plan-resend':
        runPlan(planState.text);
        break;
      case 'plan-item-edit':
        planState.editingItem = Number(target.dataset.planIndex || 0);
        planState.error = '';
        renderNewJourney();
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
  }

  app.addEventListener('click', handleAction);
  app.addEventListener('change', async event => {
    if (event.target.id !== 'backup-file' || !event.target.files?.[0]) return;
    try { backupStatus(`${t('backup.selectedFile')}: ${event.target.files[0].name}`); const imported=await importBackup(event.target.files[0]); if(imported)toast(t('backup.imported')); else backupStatus(t('backup.importCancelled')); }
    catch (error) { backupStatus(`${t('backup.importFailed')}: ${error.message}`,null,'error'); toast(`${t('backup.importFailed')}: ${error.message}`,'error'); }
    event.target.value='';
  });
  navHost?.addEventListener('click', handleAction);
  // 离线提示条在 #app 之外，它的「重试」按钮也要能触发动作。
  statusHost?.addEventListener('click', handleAction);

  /**
   * 点空白处收起草稿浮层：展开的草稿先收回列表，否则收起整个浮层。
   * 浮层浮在任意页面之上，所以这里监听整个文档。
   */
  document.addEventListener('click', (event) => {
    if (!draftOverlayOpen) return;
    if (event.target.closest('.draft-list')) return;
    if (event.target.closest('.nav-bar')) return;
    if (expandedDraftId) {
      collapseExpanded();
      return;
    }
    closeDraftOverlay();
  });

  window.__redPandaSystemBack = () => {
    const route = parseRoute();
    if (route.name === 'settings') {
      if (route.section) replaceHash('#/settings');
      else replaceHash('#/me');
      render();
      return true;
    }
    return false;
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !state.server) return;
    // Coming back to the foreground is a good moment to check the server:
    // the network may have changed while the app was in the background.
    if (state.online !== true) {
      connection.retry().then(async (alive) => {
        if (!alive) {
          setOnline(false);
          scheduleReconnect();
          return;
        }
        setOnline(true);
        await syncSession();
        render();
      });
      return;
    }
    if (!state.token) return;
    refreshAccountSettings().catch(() => {});
  });

  window.addEventListener('hashchange', render);
  window.addEventListener('resize', () => {
    positionDraftLayer();
    updateNavHeight();
  });

  /**
   * 系统返回：
   * - 草稿浮层展开时先收回列表，浮层打开时收起草稿列表，都不会退出应用；
   * - 主页面（行程 / 回忆 / 发现 / 我）没有多余的历史记录，返回即退出应用。
   */
  window.addEventListener('popstate', () => {
    if (suppressPopCount > 0) {
      suppressPopCount -= 1;
      if (pendingTabHash) {
        const hash = pendingTabHash;
        pendingTabHash = '';
        historyDepth = 0;
        replaceHash(hash);
        render();
        runPendingTabAfter();
      }
      return;
    }
    // 用户自己按了返回：历史浅了一层。
    if (historyDepth > 0) historyDepth -= 1;
    if (!draftOverlayOpen) return;
    overlayPushed = false; // 系统已经弹出了我们压入的那条历史
    if (expandedDraftId) {
      expandedDraftId = null;
      refreshDraftList();
      pushOverlayHistory(); // 继续把返回留在应用内
      return;
    }
    draftOverlayOpen = false;
    stopCreateCooldown();
    const veil = document.getElementById('draft-layer');
    if (veil) veil.hidden = true;
  });

  // ---- boot ---------------------------------------------------------------

  async function init() {
    state.server = currentServer();
    state.token = localStorage.getItem(STORAGE.token) || '';
    state.user = state.token ? readCachedUser() : null;

    // The profile lives in IndexedDB, so it is available without the server.
    try {
      if (state.user) state.user = await hydrateClientProfile(state.user);
    } catch { /* IndexedDB can be unavailable in restricted browser modes. */ }

    // Draw the first screen from local data right away. Waiting for the
    // server here is what used to leave the app on a blank screen offline.
    state.ready = true;
    render();

    // Then talk to the server in the background and layer the online
    // features on top once it answers.
    if (state.server) {
      connection.start();
      const alive = await connection.probe(4000);
      setOnline(alive);
      if (alive) {
        await syncSession();
      } else {
        scheduleReconnect();
      }
    }
  }

  applyDocumentLocale();
  init();
})();
