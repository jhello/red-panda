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
  };

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
      },

      pending: {
        title: '验证你的邮箱',
        yourEmail: '你的邮箱',
        body: '我们已向 {email} 发送了一封验证邮件。请点击邮件里的链接激活账户，链接在 24 小时内有效。',
        resend: '重新发送验证邮件',
        backLogin: '返回登录',
        hint: '没有收到邮件？请检查垃圾邮件目录，或确认邮箱地址是否正确。',
        sending: '正在发送…',
      },

      forgot: {
        title: '重置密码',
        sub: '输入注册邮箱，我们会发送一封重置密码的邮件。',
        submit: '发送重置邮件',
        sentFallback: '如果该邮箱已注册，重置邮件已发送',
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
        sending: '正在发送…',
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
        originTitle: '常用出发地',
        originName: '名称',
        originCountry: '国家 / 地区',
        originProvince: '省 / 州',
        originCity: '市',
        originDistrict: '区 / 县',
        originTownship: '乡 / 镇 / 街道办',
        originStreet: '街道',
        originStreetNumber: '门牌号码',
        originSave: '保存出发地',
        originSaved: '常用出发地已保存',
        originInput: '输入地点，如“上海市浦东新区张江路 88 号”',
        originMap: '地图选点', originMapHint: '点击地图或拖动图钉选择位置', originMapUse: '使用此地点', originEmpty: '还没有常用地点',
        resetPassword: '重置密码',
        resetPasswordSub: '忘记密码时，输入邮箱后我们会发送重置邮件。',
        aboutTitle: '关于',
        aboutBody: '小熊猫 · Red Panda {version}',
        aboutData: '数据保存在你自己的服务器上。',
        connectedOk: '连接成功 · {name} v{version}',
        serverChangedToast: '服务器已切换，请重新登录',
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
      },

      pending: {
        title: 'Verify your email',
        yourEmail: 'your inbox',
        body: "We've sent a verification email to {email}. Tap the link in the email to activate your account; the link is valid for 24 hours.",
        resend: 'Resend verification email',
        backLogin: 'Back to login',
        hint: "No email? Check the spam folder, or double-check the address.",
        sending: 'Sending…',
      },

      forgot: {
        title: 'Reset password',
        sub: "Enter your registered email and we'll send you a reset link.",
        submit: 'Send reset email',
        sentFallback: 'If that address is registered, the reset email is on its way',
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
        originMap: 'Pick on map', originMapHint: 'Click the map or drag the pin to choose a place', originMapUse: 'Use this place', originEmpty: 'No saved places yet',
        resetPassword: 'Reset password',
        resetPasswordSub: 'Forgot your password? We will send you a reset link.',
        aboutTitle: 'About',
        aboutBody: 'Red Panda · 小熊猫 {version}',
        aboutData: 'Your data lives on your own server.',
        connectedOk: 'Connected · {name} v{version}',
        serverChangedToast: 'Server changed — please log in again',
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
      },

      pending: {
        title: 'E-Mail bestätigen',
        yourEmail: 'dein Postfach',
        body: 'Wir haben eine Bestätigungs-E-Mail an {email} geschickt. Tippe in der E-Mail auf den Link, um dein Konto zu aktivieren. Er ist 24 Stunden gültig.',
        resend: 'Bestätigungs-E-Mail erneut senden',
        backLogin: 'Zur Anmeldung',
        hint: 'Keine E-Mail erhalten? Prüfe den Spam-Ordner und die Adresse.',
        sending: 'Sende…',
      },

      forgot: {
        title: 'Passwort zurücksetzen',
        sub: 'Gib deine registrierte E-Mail-Adresse ein und wir senden dir einen Reset-Link.',
        submit: 'Reset-E-Mail senden',
        sentFallback: 'Falls die Adresse registriert ist, ist die Reset-E-Mail unterwegs',
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
        originMap: 'Auf Karte wählen', originMapHint: 'Karte anklicken oder Markierung ziehen', originMapUse: 'Diesen Ort verwenden', originEmpty: 'Noch keine gespeicherten Orte',
        resetPassword: 'Passwort zurücksetzen',
        resetPasswordSub: 'Passwort vergessen? Wir senden dir einen Reset-Link.',
        aboutTitle: 'Über',
        aboutBody: 'Red Panda · 小熊猫 {version}',
        aboutData: 'Deine Daten liegen auf deinem eigenen Server.',
        connectedOk: 'Verbunden · {name} v{version}',
        serverChangedToast: 'Server gewechselt – bitte neu anmelden',
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
    currentLocale = locale;
    localStorage.setItem(STORAGE.lang, locale);
    applyDocumentLocale();
    // Signed-in users also get their emails in this language.
    if (state.token && state.user) {
      api('/api/me/locale', { method: 'PUT', body: { locale } })
        .then(() => {
          state.user = { ...state.user, locale };
          cacheUser(state.user);
        })
        .catch(() => {
          // Offline is fine: the next successful login syncs it anyway.
        });
    }
    render();
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
      <div class="lang-switch" role="group" aria-label="${t('lang.label')}">
        ${LOCALE_KEYS.map(
          (key) => `
            <button type="button" class="lang-opt ${key === active ? 'active' : ''}"
              data-lang="${key}" aria-pressed="${key === active}">${I18N[key].langName}</button>`,
        ).join('')}
      </div>`;
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

  const TAB_HASHES = ['#/', '#/memories', '#/discover', '#/settings'];

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
    if (!state.server) throw new ApiError(t('api.noServer'), 0, 'no_server');

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
      if (state.ready) {
        if (error.name === 'TimeoutError') {
          toast(t('api.timeout'), 'error');
        } else if (Date.now() - lastNetworkToast > 4000) {
          lastNetworkToast = Date.now();
          toast(t('api.networkToast'), 'error');
        }
      }
      if (error.name === 'TimeoutError') {
        throw new ApiError(t('api.timeout'), 0, 'timeout');
      }
      throw new ApiError(t('api.network'), 0, 'network');
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
        if (state.ready) toast(t('api.sessionExpired'), 'error');
        setTimeout(() => {
          if (state.ready) render();
        }, 0);
      }
      throw new ApiError(localizedApiError(data, response.status), response.status, data?.code);
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
      throw new Error(t('api.pingUnreachable'));
    }
    if (!response.ok) throw new Error(t('api.pingHttp', { status: response.status }));
    const data = await response.json().catch(() => null);
    if (!data || data.ok !== true) throw new Error(t('api.pingNotServer'));
    return data;
  }

  // ---- shared markup ------------------------------------------------------

  const brand = `
    <div class="brand">
      <img class="seal" src="logo.png" alt="${t('brand.alt')}" />
      <div class="brand-text">
        <span class="brand-cn">${t('brand.big')}</span>
      </div>
    </div>`;

  function topbar({ title = '', back = false, right = '' } = {}) {
    return `
      <header class="topbar">
        ${back ? `<button class="icon-btn" data-action="back" aria-label="${t('common.back')}">←</button>` : '<span class="topbar-lead"></span>'}
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

  function render() {
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
      case 'settings':
        renderSettings();
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
      <div class="screen auth-screen">
        ${languageSwitcher()}
        <div class="auth-hero">
          <img class="seal seal-lg" src="logo.png" alt="${t('brand.alt')}" />
          <h1 class="auth-title">${t('brand.big')}</h1>
          <p class="auth-tag">${t('home.sub')}</p>
        </div>

        <div class="card auth-card">
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
          </p>
        </div>

      </div>`;

    app.querySelectorAll('[data-tab]').forEach((button) => {
      button.addEventListener('click', () => {
        navigate(button.dataset.tab === 'register' ? '#/register' : '#/login');
      });
    });
    app.querySelectorAll('[data-tab-switch]').forEach((button) => {
      button.addEventListener('click', () => {
        navigate(button.dataset.tabSwitch === 'register' ? '#/register' : '#/login');
      });
    });

    const form = document.getElementById('auth-form');
    const passwordInput = form.querySelector('input[name="password"]');
    const passwordToggle = form.querySelector('[data-toggle-password]');
    if (passwordToggle) {
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
      if (!email) return showError('auth-error', t('auth.errEmail'));
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showError('auth-error', t('auth.errEmailInvalid'));
      if (!password) return showError('auth-error', t('auth.errPassword'));
      if (active === 'register') {
        if (password.length < 8) return showError('auth-error', t('auth.errPasswordLength'));
        if (password !== form.confirm.value) return showError('auth-error', t('auth.errConfirm'));
      }

      const button = form.querySelector('button[type="submit"]');
      setBusy(button, true, active === 'login' ? t('auth.busyLogin') : t('auth.busyRegister'));
      try {
        if (active === 'register') {
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
        localStorage.setItem(STORAGE.token, data.token);
        cacheUser(data.user);
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
    layer.style.top = 'auto';
    layer.style.bottom = `${Math.round(window.innerHeight - navRect.top + 10)}px`;
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

  /** Save the extracted plan as a real journey on the server. */
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
    // 只要已登录就常驻显示：任何页面（含等待服务器时）都不会缺失。
    const show = Boolean(state.user);
    navHost.hidden = !show;
    navHost.innerHTML = show ? navBar() : '';
    // 导航栏是重建的，重新贴一次倒计时状态。
    applyCooldownButton();
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
        <button class="nav-btn nav-me${isActive('settings')}" data-action="settings">${t('nav.me')}</button>
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
    return `${state.server}${media.url}`;
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
            <input type="file" id="memory-files" accept="image/*,video/*" multiple hidden />
            <div class="memory-actions">
              <button class="btn ghost" type="button" data-action="memory-pick">${t('memories.pick')}</button>
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
      const data = await api('/api/ai/memory-recap', {
        method: 'POST',
        body: { journeyId: Number(journeyId) },
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

  function renderSettings({ publicView = false } = {}) {
    app.innerHTML = `
      <div class="screen">
        <main class="page has-nav">
          <section class="card panel">
            <h2 class="panel-title">${t('settings.languageTitle')}</h2>
            <div class="lang-panel">${languageSwitcher()}</div>
          </section>

          ${!publicView ? `<section class="card panel">
            <h2 class="panel-title">${t('settings.originTitle')}</h2>
            <div id="origin-list" class="origin-list"></div>
            <form id="origin-form" class="origin-entry" novalidate>
              <input name="text" maxlength="1000" placeholder="${esc(t('settings.originInput'))}" aria-label="${esc(t('settings.originInput'))}" />
              <button class="btn origin-map" type="button" id="origin-map" title="${esc(t('settings.originMap'))}" aria-label="${esc(t('settings.originMap'))}">⌖</button>
              <button class="btn primary" type="submit">＋</button>
            </form>
            <p class="form-error" id="origin-error" hidden></p>
            <div id="origin-map-modal" class="origin-map-modal" hidden><div class="origin-map-head"><strong>${esc(t('settings.originMap'))}</strong><button type="button" class="btn" id="origin-map-close">×</button></div><div id="origin-map-canvas"></div><p>${esc(t('settings.originMapHint'))}</p><button class="btn primary block" id="origin-map-use" type="button" disabled>${esc(t('settings.originMapUse'))}</button></div>
          </section>` : ''}

          ${
            publicView
              ? `<section class="card panel">
                  <p class="panel-sub">${t('settings.publicSub')}</p>
                  <button class="btn primary block" data-action="login">${t('settings.goLogin')}</button>
                </section>`
              : `<section class="card panel">
                  <h2 class="panel-title">${t('settings.accountTitle')}</h2>
                  <dl class="kv">
                    <div><dt>${t('settings.email')}</dt><dd>${esc(state.user.email || '—')}</dd></div>
                    <div><dt>${t('settings.displayName')}</dt><dd>${esc(state.user.displayName || state.user.username)}</dd></div>
                    <div><dt>${t('settings.createdAt')}</dt><dd>${esc(fmtDate(state.user.createdAt))}</dd></div>
                  </dl>
                  <button class="btn danger block" data-action="logout">${t('home.logout')}</button>
                </section>

                <section class="card panel">
                  <h2 class="panel-title">${t('settings.passwordTitle')}</h2>
                  <p class="panel-sub">${t('settings.passwordSub')}</p>
                  <form id="password-form" class="form compact" novalidate>
                    <label class="field">
                      <span>${t('settings.currentPassword')}</span>
                      <input name="currentPassword" type="password" maxlength="128"
                        autocomplete="current-password" placeholder="${t('settings.currentPlaceholder')}" required />
                    </label>
                    <label class="field">
                      <span>${t('reset.newPasswordLabel')}</span>
                      <input name="newPassword" type="password" minlength="8" maxlength="128"
                        autocomplete="new-password" placeholder="${t('auth.passwordPlaceholderRegister')}" required />
                    </label>
                    <label class="field">
                      <span>${t('reset.confirmLabel')}</span>
                      <input name="confirm" type="password" maxlength="128"
                        autocomplete="new-password" placeholder="${t('auth.confirmPlaceholder')}" required />
                    </label>
                    <p class="form-error" id="password-error" hidden></p>
                    <p class="form-ok" id="password-ok" hidden></p>
                    <button class="btn primary block" type="submit">${t('settings.updatePassword')}</button>
                  </form>
                </section>

                <section class="card panel">
                  <h2 class="panel-title">${t('settings.resetPassword')}</h2>
                  <p class="panel-sub">${t('settings.resetPasswordSub')}</p>
                  <button class="link subtle" id="reset-password-btn" type="button">${t('forgot.submit')} →</button>
                </section>`
          }

          <section class="card panel">
            <h2 class="panel-title">${t('settings.aboutTitle')}</h2>
            <p class="panel-sub">${t('settings.aboutBody', { version: esc(window.REDPANDA_CONFIG?.version || '1.0.0') })}</p>
          </section>
        </main>
      </div>`;

    const passwordForm = document.getElementById('password-form');
    const originForm = document.getElementById('origin-form');
    const renderOrigins = () => {
      const list = document.getElementById('origin-list');
      if (!list) return;
      const origins = Array.isArray(state.user.usualOrigin) ? state.user.usualOrigin : (state.user.usualOrigin && Object.values(state.user.usualOrigin).some(Boolean) ? [state.user.usualOrigin] : []);
      list.innerHTML = origins.map((origin, index) => `<div class="origin-chip"><span class="origin-pin">⌖</span><span><strong>${esc(origin.name || origin.city || origin.country || '—')}</strong><small>${esc([origin.district, origin.city, origin.province, origin.country].filter(Boolean).join(' · '))}</small></span><button type="button" class="origin-remove" data-origin-remove="${index}" aria-label="×">×</button></div>`).join('') || `<p class="origin-empty">${esc(t('settings.originEmpty'))}</p>`;
    };
    renderOrigins();
    document.getElementById('origin-list')?.addEventListener('click', async (event) => {
      const index = Number(event.target.closest('[data-origin-remove]')?.dataset.originRemove);
      if (!Number.isInteger(index)) return;
      const origins = [...(Array.isArray(state.user.usualOrigin) ? state.user.usualOrigin : (state.user.usualOrigin && Object.values(state.user.usualOrigin).some(Boolean) ? [state.user.usualOrigin] : []))];
      origins.splice(index, 1);
      try { const result = await api('/api/me/usual-origin', { method: 'PUT', body: { origins } }); state.user.usualOrigin = result.usualOrigin; localStorage.setItem(STORAGE.user, JSON.stringify(state.user)); renderOrigins(); }
      catch (error) { showError('origin-error', error.message); }
    });
    if (originForm) originForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      hideError('origin-error');
      const button = originForm.querySelector('button[type="submit"]');
      setBusy(button, true, t('busy.saving'));
      try {
        const parsed = await api('/api/me/usual-origin/parse', { method: 'POST', body: { text: originForm.elements.text.value.trim() } });
        const currentOrigins = Array.isArray(state.user.usualOrigin) ? state.user.usualOrigin : (state.user.usualOrigin && Object.values(state.user.usualOrigin).some(Boolean) ? [state.user.usualOrigin] : []);
        const origins = [...currentOrigins, parsed.origin];
        const result = await api('/api/me/usual-origin', { method: 'PUT', body: { origins } });
        state.user.usualOrigin = result.usualOrigin;
        localStorage.setItem(STORAGE.user, JSON.stringify(state.user));
        originForm.reset(); renderOrigins();
        toast(t('settings.originSaved'));
      } catch (error) {
        showError('origin-error', error.message);
      } finally {
        setBusy(button, false);
      }
    });
    const mapModal = document.getElementById('origin-map-modal');
    let selectedAddress = null;
    document.getElementById('origin-map')?.addEventListener('click', async () => {
      mapModal.hidden = false;
      if (!window.L) { await new Promise((resolve, reject) => { const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'; document.head.append(link); const script = document.createElement('script'); script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'; script.onload = resolve; script.onerror = reject; document.head.append(script); }); }
      if (!window.originMapInstance) {
        const map = window.L.map('origin-map-canvas').setView([35.68, 139.69], 4); window.originMapInstance = map;
        window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap contributors', maxZoom: 19 }).addTo(map);
        const marker = window.L.marker([35.68, 139.69], { draggable: true }).addTo(map);
        const pick = async (latlng) => { marker.setLatLng(latlng); selectedAddress = null; const use = document.getElementById('origin-map-use'); use.disabled = true; try { const response = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${latlng.lat}&lon=${latlng.lng}`); selectedAddress = await response.json(); use.disabled = false; } catch { showError('origin-error', '地图地址解析失败'); } };
        map.on('click', (e) => pick(e.latlng)); marker.on('dragend', (e) => pick(e.target.getLatLng()));
        if (navigator.geolocation) navigator.geolocation.getCurrentPosition(({coords}) => { map.setView([coords.latitude, coords.longitude], 15); pick({lat: coords.latitude, lng: coords.longitude}); });
      }
      window.originMapInstance.invalidateSize();
    });
    document.getElementById('origin-map-close')?.addEventListener('click', () => { mapModal.hidden = true; });
    document.getElementById('origin-map-use')?.addEventListener('click', async () => {
      const a = selectedAddress?.address || {}; const country = a.country || ''; const province = a.state || a.province || ''; const city = a.city || a.town || a.village || a.county || '';
      const origin = { name: [a.road, a.house_number, city].filter(Boolean).join(' ') || selectedAddress?.name || city || country, country, province, city, district: a.city_district || a.suburb || a.county || '', township: a.town || a.village || '', street: a.road || '', streetNumber: a.house_number || '' };
      try { const currentOrigins = Array.isArray(state.user.usualOrigin) ? state.user.usualOrigin : (state.user.usualOrigin && Object.values(state.user.usualOrigin).some(Boolean) ? [state.user.usualOrigin] : []); const origins = [...currentOrigins, origin]; const result = await api('/api/me/usual-origin', { method: 'PUT', body: { origins } }); state.user.usualOrigin = result.usualOrigin; localStorage.setItem(STORAGE.user, JSON.stringify(state.user)); renderOrigins(); mapModal.hidden = true; toast(t('settings.originSaved')); } catch (error) { showError('origin-error', error.message); }
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

    const resetPasswordButton = document.getElementById('reset-password-btn');
    if (resetPasswordButton) {
      resetPasswordButton.addEventListener('click', async () => {
        const email = state.user?.email;
        if (!email) return;
        setBusy(resetPasswordButton, true, t('forgot.submit'));
        try {
          const data = await api('/api/auth/forgot-password', {
            method: 'POST',
            auth: false,
            body: { email, locale: getLocale() },
          });
          toast(data.message || t('forgot.sentFallback'));
        } catch (error) {
          toast(error.message, 'error');
        } finally {
          setBusy(resetPasswordButton, false);
        }
      });
    }
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
      case 'settings':
        if (draftOverlayOpen) leaveOverlayTo('#/settings');
        else navigateTab('#/settings');
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
      case 'memory-pick':
        document.getElementById('memory-files')?.click();
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
  navHost?.addEventListener('click', handleAction);

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

  window.addEventListener('hashchange', render);
  window.addEventListener('resize', positionDraftLayer);

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
    state.ready = false;
    state.server = currentServer();
    state.token = localStorage.getItem(STORAGE.token) || '';
    state.user = state.token ? readCachedUser() : null;

    if (state.token && state.server) {
      try {
        const data = await api('/api/me');
        state.user = data.user;
        cacheUser(data.user);
      } catch (error) {
        if (error.status === 401) {
          clearToken();
        }
        // Network/server errors keep the cached user and token, so the app
        // opens on the same screen it was left on instead of logging out.
      }
    }

    state.ready = true;
    render();
  }

  applyDocumentLocale();
  init();
})();
