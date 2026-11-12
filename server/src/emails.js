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

function layout({ title, intro, link, action, note }) {
  return `<!doctype html>
<html lang="zh-CN">
  <body style="margin:0;padding:24px;background:#f7f2e8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#2c2a25;">
    <div style="max-width:520px;margin:0 auto;background:#fffdf9;border:1px solid #e6ddcb;border-radius:16px;padding:28px;">
      <div style="font-size:13px;letter-spacing:.24em;color:#a83a2c;font-weight:700;">山海经 · ODYSSEY</div>
      <h1 style="margin:14px 0 10px;font-size:22px;font-weight:600;">${escapeHtml(title)}</h1>
      <p style="margin:0 0 20px;line-height:1.8;color:#5c574c;">${escapeHtml(intro)}</p>
      <p style="margin:0 0 22px;">
        <a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 20px;border-radius:12px;background:#a83a2c;color:#fffdf9;text-decoration:none;font-weight:600;">${escapeHtml(action)}</a>
      </p>
      <p style="margin:0 0 8px;font-size:13px;line-height:1.7;color:#7b7568;">如果按钮无法点击，请复制下面的链接到浏览器打开：</p>
      <p style="margin:0 0 20px;font-size:12px;line-height:1.7;word-break:break-all;color:#3e6b5b;">${escapeHtml(link)}</p>
      <p style="margin:0;font-size:12px;line-height:1.7;color:#9a9384;">${escapeHtml(note)}</p>
    </div>
  </body>
</html>`;
}

export function verificationEmail({ link, email, hours }) {
  const intro = `感谢注册山海经 · Odyssey。请点击下面的按钮验证邮箱 ${email} 并激活账户，链接在 ${hours} 小时内有效。`;
  const note = '如果这不是你本人的操作，请忽略这封邮件，你的账户不会被激活。';
  return {
    subject: '激活你的山海经账户',
    text: [
      '你好，',
      '',
      `感谢注册山海经 · Odyssey（${email}）。`,
      '',
      `请点击下面的链接验证邮箱并激活账户（${hours} 小时内有效）：`,
      link,
      '',
      note,
      '',
      '—— 山海经 · Odyssey',
    ].join('\n'),
    html: layout({ title: '激活你的账户', intro, link, action: '验证并激活', note }),
  };
}

export function resetEmail({ link, email, minutes }) {
  const intro = `我们收到了重置 ${email} 密码的请求。请点击下面的按钮设置新密码，链接在 ${minutes} 分钟内有效。`;
  const note = '如果这不是你本人的操作，请忽略这封邮件，你的密码不会被修改。';
  return {
    subject: '重置你的山海经密码',
    text: [
      '你好，',
      '',
      `我们收到了重置 ${email} 密码的请求。`,
      '',
      `请点击下面的链接设置新密码（${minutes} 分钟内有效）：`,
      link,
      '',
      note,
      '',
      '—— 山海经 · Odyssey',
    ].join('\n'),
    html: layout({ title: '重置密码', intro, link, action: '设置新密码', note }),
  };
}
