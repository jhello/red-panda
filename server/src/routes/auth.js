import { hashPasswordAsync, hashToken, newSessionToken, verifyPasswordAsync } from '../auth.js';
import { emailChangeVerificationEmail, resetEmail, verificationEmail } from '../emails.js';
import {
  HttpError,
  getClientIp,
  localeForUser,
  normalizeEmail,
  publicUser,
  requiredString,
  validatePassword,
} from '../http-utils.js';

export function registerAuthRoutes({
  route,
  db,
  config,
  mailer,
  publicBaseUrl,
  loginLimiter,
  emailLimiter,
}) {
  function issueSession(userId) {
    const token = newSessionToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + config.sessionDays * 24 * 60 * 60 * 1000);
    db.createSession({
      tokenHash: hashToken(token),
      userId,
      now: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });
    return { token, expiresAt: expiresAt.toISOString() };
  }

  function consumeLoginRate(ip) {
    if (!loginLimiter.consume(ip)) {
      throw new HttpError(429, '尝试次数过多，请十分钟后再试', 'rate_limited');
    }
  }

  function checkEmailRate(ip) {
    if (!emailLimiter.consume(ip)) {
      throw new HttpError(429, '操作过于频繁，请十分钟后再试', 'rate_limited');
    }
  }

  async function sendVerificationEmail(user, context = {}) {
    const token = newSessionToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + config.verificationHours * 60 * 60 * 1000);
    db.createEmailVerification({
      tokenHash: hashToken(token),
      userId: user.id,
      now: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });
    const link = `${publicBaseUrl()}/api/auth/verify?token=${encodeURIComponent(token)}`;
    const mail = verificationEmail({
      link,
      email: user.email,
      hours: config.verificationHours,
      locale: localeForUser(context.body, context.req),
    });
    await mailer.send({ to: user.email, ...mail });
    return link;
  }

  async function sendEmailChangeVerification(user, email, context = {}) {
    const token = newSessionToken();
    const now = new Date();
    const hours = 24;
    const expiresAt = new Date(now.getTime() + hours * 60 * 60 * 1000);
    db.createEmailVerification({
      tokenHash: hashToken(token),
      userId: user.id,
      now: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      targetEmail: email,
    });
    const link = `${publicBaseUrl()}/api/auth/verify?token=${encodeURIComponent(token)}`;
    const mail = emailChangeVerificationEmail({
      link,
      email,
      hours,
      locale: localeForUser(context.body, context.req),
    });
    try {
      await mailer.send({ to: email, ...mail });
    } catch (error) {
      db.deletePendingEmailChange(user.id);
      throw error;
    }
    return { pendingEmail: email, pendingEmailExpiresAt: expiresAt.toISOString() };
  }

  async function sendResetEmail(user, context = {}) {
    const token = newSessionToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + config.resetMinutes * 60 * 1000);
    db.deleteResetsForUser(user.id);
    db.createPasswordReset({
      tokenHash: hashToken(token),
      userId: user.id,
      now: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });
    const link = `${publicBaseUrl()}/app/#/reset-password?token=${encodeURIComponent(token)}`;
    const mail = resetEmail({
      link,
      email: user.email,
      hours: Math.ceil(config.resetMinutes / 60),
      locale: localeForUser(context.body, context.req),
    });
    try {
      await mailer.send({ to: user.email, ...mail });
    } catch (error) {
      db.deleteResetsForUser(user.id);
      throw error;
    }
    return { pendingResetExpiresAt: expiresAt.toISOString() };
  }

  route('POST', /^\/api\/auth\/register$/, async ({ body, req }) => {
    const ip = getClientIp(req, config);
    checkEmailRate(ip);
    const email = normalizeEmail(body.email);
    const password = validatePassword(body.password);
    const now = new Date().toISOString();

    const existing = db.findUserByEmail(email);
    if (existing) {
      if (existing.email_verified) {
        throw new HttpError(409, '这个邮箱已经注册过了', 'email_taken');
      }
      // Unverified accounts may re-register: update the password and resend.
      db.setPassword(existing.id, await hashPasswordAsync(password));
      try {
        await sendVerificationEmail(db.findUserById(existing.id), { body, req });
      } catch (error) {
        console.error('[red-panda] 验证邮件发送失败:', error);
        throw new HttpError(502, '账户已存在，但验证邮件发送失败，请稍后重试', 'mail_failed');
      }
      return {
        status: 200,
        body: {
          status: 'pending_verification',
          email,
          message: '验证邮件已重新发送，请查收',
        },
      };
    }

    let userId;
    const passwordHash = await hashPasswordAsync(password);
    try {
      userId = db.createUser({ email, passwordHash, now });
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) {
        throw new HttpError(409, '这个邮箱已经注册过了', 'email_taken');
      }
      throw error;
    }

    const user = db.findUserById(userId);
    try {
      await sendVerificationEmail(user, { body, req });
    } catch (error) {
      console.error('[red-panda] 验证邮件发送失败:', error);
      throw new HttpError(502, '账户已创建，但验证邮件发送失败，请稍后重试', 'mail_failed');
    }

    return {
      status: 201,
      body: {
        status: 'pending_verification',
        email,
        message: '验证邮件已发送，请查收并点击链接激活账户',
      },
    };
  });

  route('POST', /^\/api\/auth\/login$/, async ({ body, req }) => {
    const ip = getClientIp(req, config);
    const identifier = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!identifier) throw new HttpError(400, '请输入邮箱', 'validation_error');
    if (!password) throw new HttpError(400, '请输入密码', 'validation_error');
    // Consume the slot before awaiting scrypt verification. A check/note pair
    // would let concurrent requests all pass the check before any is counted.
    consumeLoginRate(ip);

    // Email is the only login identifier; username-only legacy accounts are
    // removed by database migration and are no longer accepted.
    const user = db.findUserByEmail(identifier);
    if (!user || !(await verifyPasswordAsync(password, user.password_hash))) {
      throw new HttpError(401, '邮箱或密码不正确', 'invalid_credentials');
    }
    if (!user.email_verified) {
      throw new HttpError(403, '邮箱尚未验证，请查收验证邮件并点击激活链接', 'email_not_verified');
    }
    loginLimiter.reset(ip);
    const now = new Date().toISOString();
    db.touchLogin(user.id, now);
    const session = issueSession(user.id);
    return {
      status: 200,
      body: { token: session.token, expiresAt: session.expiresAt, user: publicUser(user) },
    };
  });

  route('GET', /^\/api\/auth\/verify$/, ({ req, res }) => {
    let token = '';
    try {
      token = new URL(req.url ?? '/', 'http://localhost').searchParams.get('token') ?? '';
    } catch {
      token = '';
    }
    let verified = false;
    let emailChanged = false;
    if (token) {
      const row = db.consumeEmailVerification(hashToken(token), new Date().toISOString());
      if (row?.target_email) {
        const existing = db.findUserByEmail(row.target_email);
        if (!existing || existing.id === row.user_id) {
          db.setEmail(row.user_id, row.target_email);
          emailChanged = true;
          verified = true;
        }
      } else if (row) {
        db.markEmailVerified(row.user_id);
        verified = true;
      }
    }
    const location = emailChanged
      ? '/app/#/settings/account-security?emailChanged=1'
      : verified
        ? '/app/#/login?verified=1'
        : '/app/#/login?verify=invalid';
    res.writeHead(302, { Location: location });
    res.end();
    return { status: 302 };
  });

  route('POST', /^\/api\/auth\/resend-verification$/, async ({ body, req }) => {
    const ip = getClientIp(req, config);
    checkEmailRate(ip);
    const email = normalizeEmail(body.email);
    const user = db.findUserByEmail(email);
    if (user && !user.email_verified) {
      try {
        await sendVerificationEmail(user, { body, req });
      } catch (error) {
        console.error('[red-panda] 验证邮件发送失败:', error);
      }
    }
    return {
      status: 200,
      body: {
        status: 'ok',
        message: '如果该邮箱存在且尚未验证，验证邮件已发送',
      },
    };
  });

  route('POST', /^\/api\/auth\/forgot-password$/, async ({ body, req }) => {
    const ip = getClientIp(req, config);
    checkEmailRate(ip);
    const email = normalizeEmail(body.email);
    const user = db.findUserByEmail(email);
    if (!user) {
      return {
        status: 200,
        body: {
          status: 'not_registered',
          email,
          message: '该邮箱尚未注册',
        },
      };
    }
    try {
      if (user.email_verified) {
        const pending = await sendResetEmail(user, { body, req });
        return {
          status: 200,
          body: {
            status: 'ok',
            email,
            pendingResetExpiresAt: pending.pendingResetExpiresAt,
            message: '重置邮件已发送',
          },
        };
      }
      await sendVerificationEmail(user, { body, req });
      return {
        status: 200,
        body: {
          status: 'unverified',
          email,
          message: '该邮箱已注册但尚未验证，验证邮件已发送',
        },
      };
    } catch (error) {
      console.error('[red-panda] 邮件发送失败:', error);
      throw new HttpError(502, '邮件发送失败，请稍后重试', 'mail_failed');
    }
  });

  route('POST', /^\/api\/auth\/reset-password$/, async ({ body, req }) => {
    const ip = getClientIp(req, config);
    checkEmailRate(ip);
    const token = requiredString(body.token, '重置令牌', { min: 10, max: 200 });
    const password = validatePassword(body.password);
    const row = db.consumePasswordReset(hashToken(token), new Date().toISOString());
    if (!row) {
      throw new HttpError(400, '重置链接无效或已过期，请重新申请', 'invalid_reset_token');
    }
    db.setPassword(row.user_id, await hashPasswordAsync(password));
    db.deleteSessionsForUser(row.user_id);
    return { status: 204 };
  });

  route(
    'POST',
    /^\/api\/auth\/logout$/,
    ({ auth }) => {
      db.deleteSession(auth.tokenHash);
      return { status: 204 };
    },
    { auth: true },
  );

  route(
    'GET',
    /^\/api\/me$/,
    ({ auth }) => {
      const pending = db.pendingEmailChange(auth.user.id, new Date().toISOString());
      const pendingReset = db.pendingPasswordReset(auth.user.id, new Date().toISOString());
      return {
        status: 200,
        body: {
          user: {
            ...publicUser(auth.user),
            pendingEmail: pending?.target_email || null,
            pendingEmailExpiresAt: pending?.expires_at || null,
            pendingResetExpiresAt: pendingReset?.expires_at || null,
          },
        },
      };
    },
    { auth: true },
  );

  route(
    'PUT',
    /^\/api\/me\/email$/,
    async ({ auth, body, req }) => {
      const email = normalizeEmail(body.email);
      if (email === String(auth.user.email || '').toLowerCase()) {
        db.deletePendingEmailChange(auth.user.id);
        return { status: 200, body: { pendingEmail: null, pendingEmailExpiresAt: null } };
      }
      const existing = db.findUserByEmail(email);
      if (existing && existing.id !== auth.user.id) {
        throw new HttpError(409, '这个邮箱已经注册过了', 'email_taken');
      }
      checkEmailRate(getClientIp(req, config));
      const pending = await sendEmailChangeVerification(auth.user, email, { body, req });
      return { status: 200, body: pending };
    },
    { auth: true },
  );

  route(
    'POST',
    /^\/api\/me\/password-reset$/,
    async ({ auth, body, req }) => {
      checkEmailRate(getClientIp(req, config));
      const pending = await sendResetEmail(auth.user, { body, req });
      return { status: 200, body: pending };
    },
    { auth: true },
  );

  route(
    'PUT',
    /^\/api\/me\/password$/,
    async ({ auth, body }) => {
      const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
      const newPassword = validatePassword(body.newPassword);
      const row = db.findUserById(auth.user.id);
      if (!row || !(await verifyPasswordAsync(currentPassword, row.password_hash))) {
        throw new HttpError(401, '当前密码不正确', 'invalid_password');
      }
      db.setPassword(auth.user.id, await hashPasswordAsync(newPassword));
      // Keep this session, sign out every other device.
      db.deleteOtherSessions(auth.user.id, auth.tokenHash);
      return { status: 204 };
    },
    { auth: true },
  );
}
