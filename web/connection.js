/**
 * 连接管理：离线优先应用与服务器之间的状态机。
 *
 * 应用的所有个人数据都在本机 IndexedDB 里，所以界面永远不能等服务器：
 * 这个模块只负责「现在能不能连上」，并按指数退避自动重连。
 *
 * 它不碰 DOM，也不认识应用状态，方便单独测试。
 */
(function (global) {
  'use strict';

  const MIN_DELAY_MS = 4000;
  const MAX_DELAY_MS = 30000;
  // 超过这个时间没确认过服务器状态，就重新探测一次，
  // 免得服务器中途挂掉时在线功能干等几十秒。
  const STALE_MS = 8000;

  /**
   * @param {object} options
   * @param {() => string} options.getServer      当前服务器地址
   * @param {(alive: boolean) => void} options.onStatus  连接状态变化时回调
   * @param {(alive: boolean) => void} options.onReconnect 连上后回调（用来同步会话）
   * @param {typeof fetch} [options.fetch]         便于测试注入
   */
  function createConnectionManager(options) {
    const {
      getServer,
      onStatus = () => {},
      onReconnect = () => {},
      fetch: fetchImpl = typeof fetch === 'function' ? fetch.bind(global) : null,
      now = () => Date.now(),
    } = options;

    let online = null; // null = 未知，true = 在线，false = 离线
    let timer = null;
    let delay = MIN_DELAY_MS;
    let probing = false;
    let stopped = false;
    let lastCheck = 0; // 上次探测的时间戳

    /** 探测服务器是否活着；永远不抛异常。 */
    async function probe(timeout = 4000) {
      const server = getServer();
      if (!server || !fetchImpl) return false;
      lastCheck = now();
      try {
        const response = await fetchImpl(`${server}/api/health`, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(timeout),
        });
        if (!response.ok) return false;
        const data = await response.json().catch(() => null);
        return Boolean(data && data.ok === true);
      } catch {
        return false;
      }
    }

    /** 更新状态；只有真正从离线变在线才算「恢复」。 */
    function setStatus(alive) {
      const previous = online;
      online = alive;
      // 变成在线说明刚探测成功，短时间内不用再探。
      if (alive) {
        delay = MIN_DELAY_MS;
        lastCheck = now();
      }
      if (previous !== alive) onStatus(alive, previous);
      return previous !== alive;
    }

    /** 安排下一次重连检查。 */
    function schedule() {
      if (timer || stopped) return;
      timer = setTimeout(async () => {
        timer = null;
        if (stopped || online !== false || probing) return;
        probing = true;
        const alive = await probe(3000);
        probing = false;
        if (alive) {
          setStatus(true);
          await onReconnect(true);
          return;
        }
        delay = Math.min(delay * 2, MAX_DELAY_MS);
        schedule();
      }, delay);
      if (timer && typeof timer.unref === 'function') timer.unref();
    }

    /** 立刻检查一次；连上就恢复在线功能。 */
    async function retry() {
      const alive = await probe(4000);
      if (alive) {
        setStatus(true);
        await onReconnect(true);
        return true;
      }
      setStatus(false);
      schedule();
      return false;
    }

    /** 在线功能的前置检查：连不上就别白等网络超时。 */
    async function ensure(timeout = 3000) {
      // 刚确认过在线就直接放行；太久没确认就重新探测。
      if (online === true && now() - lastCheck < STALE_MS) return true;
      if (online === false) {
        schedule();
        return false;
      }
      const alive = await probe(timeout);
      setStatus(alive);
      if (alive) return true;
      schedule();
      return false;
    }

    /** 启动后台检查：断线时持续重连。 */
    function start() {
      stopped = false;
      schedule();
    }

    function stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    }

    return {
      probe,
      ensure,
      retry,
      start,
      stop,
      schedule,
      setStatus,
      get online() {
        return online;
      },
      get delay() {
        return delay;
      },
    };
  }

  const api = { createConnectionManager, MIN_DELAY_MS, MAX_DELAY_MS, STALE_MS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.RedPandaConnection = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
