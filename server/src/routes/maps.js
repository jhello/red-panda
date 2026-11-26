import { AIError, chat } from '../ai.js';
import { HttpError } from '../http-utils.js';

const MAP_PROVIDERS = ['amap', 'google'];
const MAP_LABELS = { amap: '高德地图', google: 'Google Maps' };
const GOOGLE_PLACE_FIELDS = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.addressComponents',
  'places.types',
].join(',');

const amapText = (value) => (Array.isArray(value) ? value[0] || '' : value || '');

function amapLocation(value, fallback) {
  const [lng, lat] = String(value || '').split(',').map(Number);
  return {
    lat: Number.isFinite(lat) ? lat : fallback.lat,
    lng: Number.isFinite(lng) ? lng : fallback.lng,
  };
}

function normalizeAmapPoi(poi = {}, fallback = { lat: 0, lng: 0 }) {
  const loc = amapLocation(poi.location, fallback);
  const distance = Number(poi.distance);
  return {
    id: poi.id || '',
    name: poi.name || '',
    address: poi.address || [poi.pname, poi.cityname, poi.adname].map(amapText).filter(Boolean).join(''),
    lat: loc.lat,
    lng: loc.lng,
    distance: Number.isFinite(distance) ? distance : null,
    province: amapText(poi.pname),
    city: amapText(poi.cityname),
    district: amapText(poi.adname),
    category: poi.type || '',
  };
}

function googleComponent(place, type) {
  const item = (place?.addressComponents || []).find((c) => (c.types || []).includes(type));
  return item?.longName || item?.shortName || '';
}

function distanceMeters(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(6371000 * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s)));
}

function normalizeGooglePlace(place = {}, center = null) {
  const loc = place.location || {};
  const point = {
    lat: Number(loc.latitude ?? 0),
    lng: Number(loc.longitude ?? 0),
  };
  return {
    id: place.id || '',
    name: place.displayName?.text || '',
    address: place.formattedAddress || '',
    lat: point.lat,
    lng: point.lng,
    distance:
      center && Number.isFinite(point.lat) && Number.isFinite(point.lng)
        ? distanceMeters(center, point)
        : null,
    province: googleComponent(place, 'administrative_area_level_1'),
    city: googleComponent(place, 'locality'),
    district: googleComponent(place, 'administrative_area_level_2'),
    category: (place.types || [])[0] || '',
  };
}

export function registerMapRoutes({ route, config, state, mapLimiter, aiLimiter }) {
  function checkMapRate(auth) {
    if (!mapLimiter.consume(String(auth.user.id))) {
      throw new HttpError(429, '地点查询过于频繁，请稍后再试', 'rate_limited');
    }
  }

  function mapProviderFrom(body) {
    const raw = body?.provider ?? config.map.defaultProvider;
    const provider = String(raw).toLowerCase();
    if (!MAP_PROVIDERS.includes(provider)) throw new HttpError(400, '不支持的地图服务', 'validation_error');
    return provider;
  }

  function requireServerMapKey(provider) {
    const entry = config.map?.[provider];
    const key = entry?.serverKey || entry?.key || '';
    if (!key) throw new HttpError(503, `未配置${MAP_LABELS[provider]} Key`, `${provider}_map_not_configured`);
    return key;
  }

  function browserMapKey(provider) {
    const entry = config.map?.[provider];
    return entry?.browserKey || entry?.key || '';
  }

  function mapUnavailable(provider) {
    throw new HttpError(502, `${MAP_LABELS[provider]}服务暂时不可用，请稍后重试。`, 'place_search_unavailable');
  }

  async function amapGet(apiPath, params) {
    const key = requireServerMapKey('amap');
    const url = new URL(`https://restapi.amap.com${apiPath}`);
    url.searchParams.set('key', key);
    for (const [k, v] of Object.entries(params || {})) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    let response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    } catch {
      mapUnavailable('amap');
    }
    let data;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (!response.ok || !data || data.status !== '1') {
      throw new HttpError(502, data?.info || '地点服务暂时不可用，请稍后重试。', 'place_search_unavailable');
    }
    return data;
  }

  async function googleFetch(url, { method = 'GET', headers = {}, body } = {}) {
    const key = requireServerMapKey('google');
    let response;
    try {
      response = await fetch(url, {
        method,
        headers: { ...headers, 'X-Goog-Api-Key': key },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      mapUnavailable('google');
    }
    let data;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (!response.ok || !data || data.error || (data.status && data.status !== 'OK')) {
      throw new HttpError(
        502,
        data?.error?.message || data?.error_message || '地点服务暂时不可用，请稍后重试。',
        'place_search_unavailable',
      );
    }
    return data;
  }

  function googlePlaces(action, body) {
    return googleFetch(`https://places.googleapis.com/v1/places:${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-FieldMask': GOOGLE_PLACE_FIELDS },
      body,
    });
  }

  route(
    'POST',
    /^\/api\/me\/usual-origin\/nearby$/,
    async ({ auth, body }) => {
      checkMapRate(auth);
      const provider = mapProviderFrom(body);
      const lat = Number(body.lat);
      const lng = Number(body.lng ?? body.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        throw new HttpError(400, '地图坐标无效', 'validation_error');
      }
      const keyword = typeof body.keyword === 'string' ? body.keyword.trim().slice(0, 80) : '';
      const pageSize = Math.min(20, Math.max(1, Number(body.page_size) || 20));
      const pageIndex = Math.max(1, Number(body.page_index) || 1);
      let pois = [];
      let count = 0;
      if (provider === 'amap') {
        const params = {
          location: `${lng},${lat}`,
          radius: 1000,
          offset: pageSize,
          page: pageIndex,
          extensions: 'base',
          sort: 'distance',
        };
        if (keyword) params.keywords = keyword;
        const data = await amapGet('/v3/place/around', params);
        pois = (Array.isArray(data.pois) ? data.pois : []).map((p) => normalizeAmapPoi(p, { lat, lng }));
        count = Number(data.count) || pois.length;
      } else {
        const locationCircle = { circle: { center: { latitude: lat, longitude: lng }, radius: 1000 } };
        const data = keyword
          ? await googlePlaces('searchText', { textQuery: keyword, locationBias: locationCircle, maxResultCount: pageSize })
          : await googlePlaces('searchNearby', { locationRestriction: locationCircle, maxResultCount: pageSize });
        pois = (Array.isArray(data.places) ? data.places : []).map((p) => normalizeGooglePlace(p, { lat, lng }));
        count = pois.length;
      }
      return { status: 200, body: { pois, count } };
    },
    { auth: true },
  );

  route(
    'POST',
    /^\/api\/me\/usual-origin\/search$/,
    async ({ auth, body }) => {
      checkMapRate(auth);
      const provider = mapProviderFrom(body);
      const keyword =
        typeof body.keyword === 'string'
          ? body.keyword.trim().slice(0, 80)
          : typeof body.query === 'string'
            ? body.query.trim().slice(0, 80)
            : '';
      if (keyword.length < 1) throw new HttpError(400, '请输入搜索关键词', 'validation_error');
      const lat = Number(body.lat);
      const lng = Number(body.lng ?? body.lon);
      const hasCoords = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
      const pageSize = Math.min(20, Math.max(1, Number(body.page_size) || 20));
      const pageIndex = Math.max(1, Number(body.page_index) || 1);
      let pois = [];
      let count = 0;
      if (provider === 'amap') {
        const params = { keywords: keyword, offset: pageSize, page: pageIndex, extensions: 'base' };
        if (hasCoords) {
          params.location = `${lng},${lat}`;
          params.radius = 50000;
        }
        const data = await amapGet('/v3/place/text', params);
        pois = (Array.isArray(data.pois) ? data.pois : []).map((p) =>
          normalizeAmapPoi(p, hasCoords ? { lat, lng } : { lat: 0, lng: 0 }),
        );
        count = Number(data.count) || pois.length;
      } else {
        const request = { textQuery: keyword, maxResultCount: pageSize };
        if (hasCoords) request.locationBias = { circle: { center: { latitude: lat, longitude: lng }, radius: 50000 } };
        const data = await googlePlaces('searchText', request);
        pois = (Array.isArray(data.places) ? data.places : []).map((p) =>
          normalizeGooglePlace(p, hasCoords ? { lat, lng } : null),
        );
        count = pois.length;
      }
      return { status: 200, body: { pois, count } };
    },
    { auth: true },
  );

  route(
    'POST',
    /^\/api\/me\/usual-origin\/reverse$/,
    async ({ auth, body }) => {
      checkMapRate(auth);
      const provider = mapProviderFrom(body);
      const lat = Number(body.lat);
      const lng = Number(body.lng ?? body.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        throw new HttpError(400, '地图坐标无效', 'validation_error');
      }
      let formatted = '';
      let component = {};
      let pois = [];
      if (provider === 'amap') {
        const data = await amapGet('/v3/geocode/regeo', {
          location: `${lng},${lat}`,
          radius: 1000,
          extensions: 'all',
          homeorcorp: 0,
        });
        const result = data.regeocode || {};
        const comp = result.addressComponent || {};
        const streetNumber = comp.streetNumber || {};
        formatted = result.formatted_address || '';
        component = {
          province: amapText(comp.province),
          city: amapText(comp.city),
          district: amapText(comp.district),
          street: amapText(streetNumber.street) || amapText(result.roads?.[0]?.name),
          street_number: amapText(streetNumber.number),
        };
        pois = (Array.isArray(result.pois) ? result.pois : []).slice(0, 20).map((p) =>
          normalizeAmapPoi(
            {
              ...p,
              pname: p.pname || comp.province,
              cityname: p.cityname || comp.city,
              adname: p.adname || comp.district,
            },
            { lat, lng },
          ),
        );
      } else {
        const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
        url.searchParams.set('latlng', `${lat},${lng}`);
        url.searchParams.set('key', requireServerMapKey('google'));
        const geo = await googleFetch(url);
        const result = geo.results?.[0] || {};
        formatted = result.formatted_address || '';
        component = {
          province: googleComponent(result, 'administrative_area_level_1'),
          city: googleComponent(result, 'locality'),
          district: googleComponent(result, 'administrative_area_level_2'),
          street: googleComponent(result, 'route'),
          street_number: googleComponent(result, 'street_number'),
        };
        const data = await googlePlaces('searchNearby', {
          locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius: 1000 } },
          maxResultCount: 20,
        });
        pois = (Array.isArray(data.places) ? data.places : []).map((p) => normalizeGooglePlace(p, { lat, lng }));
      }
      return {
        status: 200,
        body: { address: formatted, component: { ...component }, pois },
      };
    },
    { auth: true },
  );

  route(
    'GET',
    /^\/api\/map\/config$/,
    async () => ({
      status: 200,
      body: {
        providers: [...MAP_PROVIDERS],
        defaultProvider: config.map.defaultProvider,
        amapKey: browserMapKey('amap'),
        googleKey: browserMapKey('google'),
      },
    }),
    { auth: true },
  );

  route(
    'POST',
    /^\/api\/me\/usual-origin\/parse$/,
    async ({ auth, body }) => {
      checkMapRate(auth);
      if (aiLimiter && !aiLimiter.consume(String(auth.user.id))) {
        throw new HttpError(429, 'AI 调用过于频繁，请稍后再试', 'rate_limited');
      }
      const text = typeof body.text === 'string' ? body.text.trim().slice(0, 1000) : '';
      if (!text) throw new HttpError(400, '请输入地点描述', 'validation_error');
      const result = await chat(
        config,
        [
          {
            role: 'system',
            content:
              '将用户给出的常用地址描述解析为 JSON 对象。只返回JSON，键名必须为name,country,province,city,district,township,street,streetNumber；无法确定的值为空字符串。name 用适合显示的简短地点名。',
          },
          { role: 'user', content: text },
        ],
        { maxTokens: 500, temperature: 0 },
      );
      state.metrics.aiCalls += 1;
      let origin;
      try {
        origin = result.mock
          ? { name: text }
          : JSON.parse(result.content.replace(/^```(?:json)?\s*|\s*```$/g, ''));
      } catch {
        throw new AIError('AI 返回的地点格式无法识别，请补充描述后重试。', 502, 'ai_invalid_json');
      }
      const fields = ['name', 'country', 'province', 'city', 'district', 'township', 'street', 'streetNumber'];
      return {
        status: 200,
        body: {
          origin: Object.fromEntries(fields.map((key) => [key, String(origin[key] || '').slice(0, 160)])),
        },
      };
    },
    { auth: true },
  );
}
