function escapeHtml(value) {
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

/**
 * Email copy per supported UI language. The email a user receives follows the
 * language they picked in the app (users.locale, falling back to zh).
 */
const COPY = {
  zh: {
    lang: 'zh-CN',
    brand: '小熊猫 · RED PANDA',
    signoff: '—— 小熊猫 · Red Panda',
    fallback: '如果按钮无法点击，请复制下面的链接到浏览器打开：',
    verification: {
      subject: '激活你的小熊猫账户',
      title: '激活你的账户',
      intro: (email, hours) =>
        `感谢注册小熊猫 · Red Panda。请点击下面的按钮验证邮箱 ${email} 并激活账户，链接在 ${hours} 小时内有效。`,
      action: '验证并激活',
      hello: '你好，',
      textIntro: (email) => `感谢注册小熊猫 · Red Panda（${email}）。`,
      textCta: (hours) => `请点击下面的链接验证邮箱并激活账户（${hours} 小时内有效）：`,
      note: '如果这不是你本人的操作，请忽略这封邮件，你的账户不会被激活。',
    },
    reset: {
      subject: '重置你的小熊猫密码',
      title: '重置密码',
      intro: (email, minutes) =>
        `我们收到了重置 ${email} 密码的请求。请点击下面的按钮设置新密码，链接在 ${minutes} 分钟内有效。`,
      action: '设置新密码',
      hello: '你好，',
      textIntro: (email) => `我们收到了重置 ${email} 密码的请求。`,
      textCta: (minutes) => `请点击下面的链接设置新密码（${minutes} 分钟内有效）：`,
      note: '如果这不是你本人的操作，请忽略这封邮件，你的密码不会被修改。',
    },
  },
  en: {
    lang: 'en',
    brand: 'Red Panda · 小熊猫',
    signoff: '—— Red Panda · 小熊猫',
    fallback: "If the button doesn't work, copy the link below and open it in your browser:",
    verification: {
      subject: 'Activate your Red Panda account',
      title: 'Activate your account',
      intro: (email, hours) =>
        `Thanks for signing up for Red Panda · 小熊猫. Click the button below to verify ${email} and activate your account. The link is valid for ${hours} hours.`,
      action: 'Verify & activate',
      hello: 'Hello,',
      textIntro: (email) => `thanks for signing up for Red Panda · 小熊猫 (${email}).`,
      textCta: (hours) =>
        `Please open the link below to verify your email and activate your account (valid for ${hours} hours):`,
      note: "If this wasn't you, simply ignore this email and your account won't be activated.",
    },
    reset: {
      subject: 'Reset your Red Panda password',
      title: 'Reset your password',
      intro: (email, minutes) =>
        `We received a request to reset the password for ${email}. Click the button below to choose a new password. The link is valid for ${minutes} minutes.`,
      action: 'Set a new password',
      hello: 'Hello,',
      textIntro: (email) => `we received a request to reset the password for ${email}.`,
      textCta: (minutes) =>
        `Please open the link below to choose a new password (valid for ${minutes} minutes):`,
      note: "If this wasn't you, simply ignore this email and your password won't be changed.",
    },
  },
  de: {
    lang: 'de',
    brand: 'Red Panda · 小熊猫',
    signoff: '—— Red Panda · 小熊猫',
    fallback: 'Falls die Schaltfläche nicht funktioniert, kopiere den Link unten und öffne ihn im Browser:',
    verification: {
      subject: 'Aktiviere dein Red Panda Konto',
      title: 'Aktiviere dein Konto',
      intro: (email, hours) =>
        `Danke für deine Registrierung bei Red Panda · 小熊猫. Klicke auf die Schaltfläche unten, um ${email} zu bestätigen und dein Konto zu aktivieren. Der Link ist ${hours} Stunden gültig.`,
      action: 'Bestätigen & aktivieren',
      hello: 'Hallo,',
      textIntro: (email) => `danke für deine Registrierung bei Red Panda · 小熊猫 (${email}).`,
      textCta: (hours) =>
        `Bitte öffne den Link unten, um deine E-Mail-Adresse zu bestätigen und dein Konto zu aktivieren (gültig für ${hours} Stunden):`,
      note: 'Falls du das nicht warst, ignoriere diese E-Mail einfach – dein Konto wird nicht aktiviert.',
    },
    reset: {
      subject: 'Setze dein Red Panda Passwort zurück',
      title: 'Passwort zurücksetzen',
      intro: (email, minutes) =>
        `Wir haben eine Anfrage zum Zurücksetzen des Passworts für ${email} erhalten. Klicke auf die Schaltfläche unten, um ein neues Passwort festzulegen. Der Link ist ${minutes} Minuten gültig.`,
      action: 'Neues Passwort festlegen',
      hello: 'Hallo,',
      textIntro: (email) => `wir haben eine Anfrage zum Zurücksetzen des Passworts für ${email} erhalten.`,
      textCta: (minutes) =>
        `Bitte öffne den Link unten, um ein neues Passwort festzulegen (gültig für ${minutes} Minuten):`,
      note: 'Falls du das nicht warst, ignoriere diese E-Mail einfach – dein Passwort bleibt unverändert.',
    },
  },
};

function copyFor(locale) {
  return COPY[locale] || COPY.zh;
}

function layout({ lang, brand, title, intro, link, action, fallback, note }) {
  return `<!doctype html>
<html lang="${escapeHtml(lang)}">
  <body style="margin:0;padding:24px;background:#f7f2e8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#2c2a25;">
    <div style="max-width:520px;margin:0 auto;background:#fffdf9;border:1px solid #e6ddcb;border-radius:16px;padding:28px;">
      <div style="font-size:13px;letter-spacing:.24em;color:#a83a2c;font-weight:700;">${escapeHtml(brand)}</div>
      <h1 style="margin:14px 0 10px;font-size:22px;font-weight:600;">${escapeHtml(title)}</h1>
      <p style="margin:0 0 20px;line-height:1.8;color:#5c574c;">${escapeHtml(intro)}</p>
      <p style="margin:0 0 22px;">
        <a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 20px;border-radius:12px;background:#a83a2c;color:#fffdf9;text-decoration:none;font-weight:600;">${escapeHtml(action)}</a>
      </p>
      <p style="margin:0 0 8px;font-size:13px;line-height:1.7;color:#7b7568;">${escapeHtml(fallback)}</p>
      <p style="margin:0 0 20px;font-size:12px;line-height:1.7;word-break:break-all;">
        <a href="${escapeHtml(link)}" style="color:#3e6b5b;text-decoration:underline;">${escapeHtml(link)}</a>
      </p>
      <p style="margin:0;font-size:12px;line-height:1.7;color:#9a9384;">${escapeHtml(note)}</p>
    </div>
  </body>
</html>`;
}

export function verificationEmail({ link, email, hours, locale = 'zh' }) {
  const copy = copyFor(locale);
  const mail = copy.verification;
  return {
    subject: mail.subject,
    text: [
      mail.hello,
      '',
      mail.textIntro(email),
      '',
      mail.textCta(hours),
      link,
      '',
      mail.note,
      '',
      copy.signoff,
    ].join('\n'),
    html: layout({
      lang: copy.lang,
      brand: copy.brand,
      title: mail.title,
      intro: mail.intro(email, hours),
      link,
      action: mail.action,
      fallback: copy.fallback,
      note: mail.note,
    }),
  };
}

export function resetEmail({ link, email, minutes, locale = 'zh' }) {
  const copy = copyFor(locale);
  const mail = copy.reset;
  return {
    subject: mail.subject,
    text: [
      mail.hello,
      '',
      mail.textIntro(email),
      '',
      mail.textCta(minutes),
      link,
      '',
      mail.note,
      '',
      copy.signoff,
    ].join('\n'),
    html: layout({
      lang: copy.lang,
      brand: copy.brand,
      title: mail.title,
      intro: mail.intro(email, minutes),
      link,
      action: mail.action,
      fallback: copy.fallback,
      note: mail.note,
    }),
  };
}
