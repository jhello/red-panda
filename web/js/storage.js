(function (root) {
  'use strict';

  const LOCAL_DB = 'red-panda-local-v1';

  function localDbNameForUser(user) {
    const owner = user?.id
      ? `u${user.id}`
      : user?.email
        ? `e${String(user.email).toLowerCase()}`
        : 'guest';
    return `${LOCAL_DB}-${owner.replace(/[^a-z0-9._-]+/gi, '_')}`;
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

  function makeId() {
    return Date.now() * 1000 + Math.floor(Math.random() * 1000);
  }

  function buildLocalJourney(body, base = {}, options = {}) {
    const plan = body.plan === undefined ? (base.plan || null) : normalizeLocalPlan(body.plan);
    const now = options.now || new Date().toISOString();
    return {
      ...base,
      id: base.id ?? (options.id ?? makeId()),
      name: body.name ?? base.name ?? '',
      description: body.description ?? base.description ?? '',
      plan,
      depart_time: plan?.departTime || '',
      return_time: plan?.returnTime || '',
      created_at: base.created_at || now,
      updated_at: now,
    };
  }

  /**
   * All personal travel content lives in IndexedDB so Web, Android WebView and
   * future browser shells share one portable storage format. Each account gets
   * its own database so two people sharing a device never see each other's trips.
   */
  function createLocalStorage({ getUser, getLocale, applySavedLocale, t, ApiError }) {
    const localDbCache = new Map();
    const mediaObjectUrls = new Map();

    function localDbName() {
      return localDbNameForUser(getUser());
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
        await writeDbStore(source, 'settings', [
          { id: 'legacy-claimed', by: localDbName(), at: new Date().toISOString() },
        ]);
      } catch {
        // Keep the old database untouched if any part of the copy fails.
      } finally {
        source.close();
      }
    }

    function localDb() {
      const name = localDbName();
      if (!localDbCache.has(name)) {
        localDbCache.set(
          name,
          (async () => {
            const db = await openIndexedDb(name);
            await importLegacyLocalDb(db);
            return db;
          })(),
        );
      }
      return localDbCache.get(name);
    }

    async function storeAll(name) {
      const db = await localDb();
      return readDbStore(db, name);
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

    /** Keep one object URL per stored media item instead of leaking a new one per render. */
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
      if (profile.locale && applySavedLocale) {
        applySavedLocale(profile.locale);
      }
      return {
        ...user,
        displayName: profile.displayName,
        locale: profile.locale || getLocale(),
        usualOrigin: profile.usualOrigin,
      };
    }

    /**
     * Journeys, memories, profile and media are read/written locally. The
     * server only keeps account authentication.
     */
    async function localDataApi(apiPath, options = {}) {
      const method = options.method || 'GET';
      const url = new URL(apiPath, location.origin);
      const p = url.pathname;
      const body = options.body || {};

      if (p === '/api/journeys' && method === 'GET') {
        const journeys = (await storeAll('journeys')).sort((a, b) =>
          String(a.depart_time).localeCompare(String(b.depart_time)),
        );
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

    return {
      localDbName,
      localDb,
      storeAll,
      storePut,
      storeDelete,
      mediaObjectUrl,
      revokeMediaObjectUrl,
      hydrateClientProfile,
      localDataApi,
    };
  }

  const api = {
    LOCAL_DB,
    localDbNameForUser,
    normalizeLocalPlan,
    buildLocalJourney,
    createLocalStorage,
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  root.RedPandaStorage = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
