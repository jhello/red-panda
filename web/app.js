(() => {
  'use strict';

  const STORAGE = {
    token: 'red-panda.token',
    server: 'red-panda.server',
    user: 'red-panda.user',
    lang: 'red-panda.lang',
  };

  const app = document.getElementById('app');
  const toastEl = document.getElementById('toast');

  const state = {
    ready: false,
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
        sub: '把走过的路，写进属于你的旅程。',
        createTitle: '创建旅程',
        createSub: '记录一段新的山海',
        listTitle: '查看旅程',
        listSub: '翻阅走过的路',
        countText: '已记录 <b id="journey-count">—</b> 段旅程',
        logout: '退出登录',
      },

      new: {
        title: '新的旅程',
        sub: '给它一个名字，再写下你想去的地方。',
        namePlaceholder: '例如：昆仑之丘',
        descPlaceholder: '山是什么颜色，风从哪里来……',
        save: '保存旅程',
        errName: '先给旅程起个名字吧',
      },

      ai: {
        write: '✦ AI 帮我写描述',
        hint: '根据名称生成一段简介',
        rewrite: '✦ AI 重写描述',
        rewriteHint: '会覆盖当前描述',
        busy: '正在落笔…',
        done: 'AI 已写好，你可以继续修改',
        mock: '已生成示例描述（服务端为 mock 模式）',
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
        cancel: '取消',
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
        sub: "Turn the roads you've walked into journeys of your own.",
        createTitle: 'New journey',
        createSub: 'Record a new adventure',
        listTitle: 'My journeys',
        listSub: "Revisit the roads you've walked",
        countText: '<b id="journey-count">—</b> journeys recorded',
        logout: 'Log out',
      },

      new: {
        title: 'A new journey',
        sub: 'Give it a name, then write down where you want to go.',
        namePlaceholder: 'e.g. Kunlun Mountains',
        descPlaceholder: 'What colour are the mountains, where does the wind come from…',
        save: 'Save journey',
        errName: 'Give your journey a name first',
      },

      ai: {
        write: '✦ Let AI draft it',
        hint: 'Generates a short intro from the name',
        rewrite: '✦ Rewrite with AI',
        rewriteHint: 'Replaces the current description',
        busy: 'Writing…',
        done: 'AI wrote a draft — feel free to edit it',
        mock: 'Sample description generated (server is in mock mode)',
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
        cancel: 'Cancel',
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
        sub: 'Halte deine Wege als deine eigenen Reisen fest.',
        createTitle: 'Neue Reise',
        createSub: 'Ein neues Abenteuer festhalten',
        listTitle: 'Meine Reisen',
        listSub: 'Blätter durch deine Wege',
        countText: '<b id="journey-count">—</b> Reisen festgehalten',
        logout: 'Abmelden',
      },

      new: {
        title: 'Eine neue Reise',
        sub: 'Gib ihr einen Namen und schreib auf, wohin es gehen soll.',
        namePlaceholder: 'z. B. Kunlun-Gebirge',
        descPlaceholder: 'Welche Farbe haben die Berge, woher kommt der Wind …',
        save: 'Reise speichern',
        errName: 'Gib der Reise zuerst einen Namen',
      },

      ai: {
        write: '✦ KI schreibt für dich',
        hint: 'Erstellt aus dem Namen eine kurze Einleitung',
        rewrite: '✦ Mit KI neu schreiben',
        rewriteHint: 'Ersetzt die aktuelle Beschreibung',
        busy: 'Schreibt…',
        done: 'Die KI ist fertig – du kannst es anpassen',
        mock: 'Beispieltext erzeugt (Server im Mock-Modus)',
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
        cancel: 'Abbrechen',
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
    return 'zh';
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
    const { method = 'GET', body, auth = true, timeout = 30000 } = options;
    if (!state.server) throw new ApiError(t('api.noServer'), 0, 'no_server');

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
        <span class="brand-cn">小熊猫</span>
        <span class="brand-en">Red Panda</span>
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
      return;
    }

    const route = parseRoute();

    if (!state.server) {
      renderSetup();
      return;
    }
    // Password reset links work whether or not someone is signed in.
    if (route.name === 'reset-password') {
      renderResetPassword(route.query);
      return;
    }
    // Arriving from a verification or reset email should show the signed-out screen.
    if (route.name === 'login' && (route.query.verified || route.query.verify || route.query.reset)) {
      clearToken();
    }
    if (!state.token) {
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
      return;
    }
    if (!state.user) {
      // We could not verify the cached session (for example offline on first
      // launch after upgrading). Fall back to the login screen instead of an
      // error page; the token is kept and will be re-checked on next launch.
      renderAuth('login');
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
        ${languageSwitcher()}
        <div class="auth-hero">
          <img class="seal seal-lg" src="logo.png" alt="${t('brand.alt')}" />
          <h1 class="auth-title">小熊猫</h1>
          <p class="auth-en">RED PANDA</p>
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
          <h1 class="auth-title">小熊猫</h1>
          <p class="auth-en">RED PANDA</p>
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
        navigate('#/');
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
          <h1 class="auth-title">小熊猫</h1>
          <p class="auth-en">RED PANDA</p>
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
          <h1 class="auth-title">小熊猫</h1>
          <p class="auth-en">RED PANDA</p>
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
            <h1 class="auth-title">小熊猫</h1>
            <p class="auth-en">RED PANDA</p>
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
          <h1 class="auth-title">小熊猫</h1>
          <p class="auth-en">RED PANDA</p>
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

  function renderHome() {
    app.innerHTML = `
      <div class="screen">
        <header class="topbar">
          ${brand}
          <div class="topbar-right">
            <button class="icon-btn" data-action="settings" aria-label="${t('settings.title')}">⚙</button>
          </div>
        </header>

        <main class="page home-page">
          <section class="hero">
            <p class="eyebrow">${t('home.greeting', { name: esc(state.user.displayName || state.user.username) })}</p>
            <h1 class="hero-title">${t('home.title')}</h1>
            <p class="hero-sub">${t('home.sub')}</p>
          </section>

          <section class="actions">
            <button class="action-card action-primary" data-action="new">
              <span class="action-mark">＋</span>
              <span class="action-copy">
                <strong>${t('home.createTitle')}</strong>
                <span>${t('home.createSub')}</span>
              </span>
              <span class="action-arrow">→</span>
            </button>
            <button class="action-card" data-action="journeys">
              <span class="action-mark mark-ink">卷</span>
              <span class="action-copy">
                <strong>${t('home.listTitle')}</strong>
                <span>${t('home.listSub')}</span>
              </span>
              <span class="action-arrow">→</span>
            </button>
          </section>

          <footer class="home-foot">
            <span>${t('home.countText')}</span>
            <button class="link" data-action="logout">${t('home.logout')}</button>
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
        ${topbar({ title: t('home.createTitle'), back: true })}
        <main class="page">
          <h1 class="page-title">${t('new.title')}</h1>
          <p class="page-sub">${t('new.sub')}</p>

          <form id="journey-form" class="form" novalidate>
            <label class="field">
              <span>${t('field.name')}</span>
              <input id="journey-name" maxlength="80" placeholder="${t('new.namePlaceholder')}" required />
            </label>
            <label class="field">
              <span>${t('field.desc')}</span>
              <textarea id="journey-desc" maxlength="5000" rows="6" placeholder="${t('new.descPlaceholder')}"></textarea>
            </label>

            <div class="ai-row">
              <button type="button" class="btn ghost" id="ai-write">${t('ai.write')}</button>
              <span class="ai-hint">${t('ai.hint')}</span>
            </div>

            <p class="form-error" id="form-error" hidden></p>
            <button class="btn primary block" type="submit">${t('new.save')}</button>
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
      if (!name) return showError('form-error', t('new.errName'));

      const button = form.querySelector('button[type="submit"]');
      setBusy(button, true, t('busy.saving'));
      try {
        const { journey } = await api('/api/journeys', {
          method: 'POST',
          body: { name, description: descInput.value.trim() },
        });
        toast(t('journey.createdToast'));
        navigate(`#/journey/${journey.id}`);
      } catch (error) {
        showError('form-error', error.message);
        setBusy(button, false);
      }
    });
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

  function renderJourneys() {
    app.innerHTML = `
      <div class="screen">
        ${topbar({ title: t('journeys.title'), back: true })}
        <main class="page">
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
    const excerpt = journey.description ? esc(journey.description).replace(/\s+/g, ' ') : t('journeys.noDesc');
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
    app.innerHTML = `
      <div class="screen">
        ${topbar({
          title: t('detail.topbar'),
          back: true,
          right: `<button class="icon-btn" data-action="edit" aria-label="${t('detail.editAria')}">✎</button>`,
        })}
        <main class="page detail">
          <p class="eyebrow">${esc(fmtDay(journey.updated_at))}</p>
          <h1 class="detail-title">${esc(journey.name)}</h1>
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
        ${topbar({ title: t('settings.title'), back: !publicView })}
        <main class="page">
          <h1 class="page-title">${t('settings.title')}</h1>

          <section class="card panel">
            <h2 class="panel-title">${t('settings.languageTitle')}</h2>
            <div class="lang-panel">${languageSwitcher()}</div>
          </section>

          <section class="card panel">
            <h2 class="panel-title">${t('settings.serverTitle')}</h2>
            <p class="panel-sub">${t('settings.serverSub')}</p>
            <form id="server-form" class="form compact" novalidate>
              <label class="field">
                <span>${t('settings.serverLabel')}</span>
                <input id="server-url" value="${esc(state.server)}" placeholder="http://192.168.1.10:8787"
                  inputmode="url" autocapitalize="off" spellcheck="false" />
              </label>
              <p class="form-error" id="server-error" hidden></p>
              <p class="form-ok" id="server-ok" hidden></p>
              <button class="btn ghost block" type="submit">${t('settings.testSubmit')}</button>
            </form>
          </section>

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
                </section>`
          }

          <section class="card panel">
            <h2 class="panel-title">${t('settings.aboutTitle')}</h2>
            <p class="panel-sub">${t('settings.aboutBody', { version: esc(window.REDPANDA_CONFIG?.version || '1.0.0') })}</p>
            <p class="panel-sub">${t('settings.aboutData')}</p>
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
        showError('server-error', t('setup.urlError'));
        return;
      }

      setBusy(button, true, t('setup.connecting'));
      try {
        const health = await pingServer(next);
        const previous = state.server;
        localStorage.setItem(STORAGE.server, next);
        state.server = next;
        ok.textContent = t('settings.connectedOk', { name: health.name || t('brand.name'), version: health.version || '' });
        ok.hidden = false;

        if (previous && previous !== next) {
          clearToken();
          state.authTab = 'login';
          toast(t('settings.serverChangedToast'));
          setTimeout(() => navigate('#/login'), 700);
        } else if (!state.token) {
          setTimeout(() => navigate('#/login'), 700);
        } else {
          setTimeout(() => navigate('#/'), 700);
        }
      } catch (error) {
        showError('server-error', t('setup.connectFailed', { message: error.message }));
      } finally {
        setBusy(button, false);
      }
    });

    const passwordForm = document.getElementById('password-form');
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
    navigate('#/login');
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

  app.addEventListener('click', (event) => {
    const langTarget = event.target.closest('[data-lang]');
    if (langTarget) {
      setLocale(langTarget.dataset.lang);
      return;
    }
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
