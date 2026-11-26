import { AIError, chat, mockPlan, mockRecap } from '../ai.js';
import { HttpError, localeForUser, optionalString, requiredString } from '../http-utils.js';

/** Field aliases a model may use for each field of a journey plan. */
const PLAN_FIELD_ALIASES = {
  destination: ['destination', 'dest', 'place', 'city', 'spot', 'name', '目的地', '地点', '城市', 'Reiseziel'],
  departTime: [
    'departTime', 'departureTime', 'departure_time', 'departureDate', 'departure_date',
    'depart', 'departure', 'start', 'startTime', 'start_time', '出发时间', '出发日期', '出发', 'Abreise',
  ],
  returnTime: [
    'returnTime', 'return_time', 'returnDate', 'return_date', 'return',
    'end', 'endTime', 'end_time', 'finish', 'finishTime', '返回时间', '返回日期', '返回', 'Rückkehr',
  ],
};

function pickPlanField(raw, kind) {
  for (const key of PLAN_FIELD_ALIASES[kind]) {
    const value = raw[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return '';
}

/** Normalize a date/time string to YYYY-MM-DDTHH:mm (empty when unusable). */
function normalizePlanTime(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const dateTime = /^(\d{4})-(\d{1,2})-(\d{1,2})[T\s]+(\d{1,2}):(\d{2})/.exec(text);
  if (dateTime) {
    const [, y, m, d, hh, mm] = dateTime;
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T${String(hh).padStart(2, '0')}:${mm}`;
  }
  const dateOnly = /^(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})日?$/.exec(text);
  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T09:00`;
  }
  return '';
}

/** Today's date, so the model can resolve relative dates like "下个月15号" / "next Friday". */
function todayContext(locale = 'zh') {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  if (locale === 'en') {
    const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return `${date} (${weekdays[now.getDay()]})`;
  }
  if (locale === 'de') {
    const weekdays = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
    return `${date} (${weekdays[now.getDay()]})`;
  }
  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
  return `${date}（星期${weekdays[now.getDay()]}）`;
}

/**
 * Turn an LLM answer into a normalized journey plan:
 * { items: [{ destination, departTime, returnTime }] }.
 * Models answer in slightly different shapes, so accept a single object,
 * an array, or { items: [...] }, and read common field aliases.
 */
export function parseJourneyPlan(content) {
  let text = String(content ?? '').trim();
  const fence = /```(?:json)?/i.exec(text);
  if (fence) {
    const start = text.indexOf(fence[0]);
    const end = text.indexOf('```', start + fence[0].length);
    if (start !== -1 && end > start) text = text.slice(start + fence[0].length, end);
  }

  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (parsed === null) {
    const arrayStart = text.indexOf('[');
    const arrayEnd = text.lastIndexOf(']');
    if (arrayStart !== -1 && arrayEnd > arrayStart) {
      try {
        parsed = JSON.parse(text.slice(arrayStart, arrayEnd + 1));
      } catch {
        parsed = null;
      }
    }
  }
  if (parsed === null) {
    const objectStart = text.indexOf('{');
    const objectEnd = text.lastIndexOf('}');
    if (objectStart !== -1 && objectEnd > objectStart) {
      try {
        parsed = JSON.parse(text.slice(objectStart, objectEnd + 1));
      } catch {
        parsed = null;
      }
    }
  }
  if (parsed === null) {
    throw new AIError('AI 返回内容格式不正确', 502, 'ai_invalid_json');
  }

  let rawItems;
  if (Array.isArray(parsed)) rawItems = parsed;
  else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.items)) rawItems = parsed.items;
  else if (parsed && typeof parsed === 'object') rawItems = [parsed];
  else rawItems = [];

  const items = [];
  for (const raw of rawItems) {
    if (!raw || typeof raw !== 'object') continue;
    const departTime = normalizePlanTime(pickPlanField(raw, 'departTime'));
    const returnTime = normalizePlanTime(pickPlanField(raw, 'returnTime'));
    const destination = pickPlanField(raw, 'destination');
    // Some models put several stops into one array field.
    const destinations = Array.isArray(destination) ? destination : [destination];
    for (const one of destinations) {
      const name = String(one ?? '').trim();
      if (!name) continue;
      items.push({ destination: name.slice(0, 80), departTime, returnTime });
    }
  }
  if (items.length === 0) throw new AIError('AI 没有返回可用的旅程计划', 502, 'ai_empty');
  return { items };
}

export function buildMemoryRecapMessages(context, locale = 'zh') {
  if (locale === 'en') {
    return [
      {
        role: 'system',
        content:
          'You are the travel memory writer for Red Panda. ' +
          'Turn the user’s trip photos, videos, and notes into a warm, vivid travel memory paragraph in English. ' +
          'Do not use bullet lists, headings, or explanations. Keep it under 120 words and output only the memory text.',
      },
      {
        role: 'user',
        content:
          `Trip: ${context.journeyName}\n` +
          (context.destination ? `Destination: ${context.destination}\n` : '') +
          (context.departTime ? `Departure: ${context.departTime}\n` : '') +
          (context.returnTime ? `Return: ${context.returnTime}\n` : '') +
          `Photos: ${context.photos}, Videos: ${context.videos}.\n` +
          (context.notes.length
            ? `User notes:\n${context.notes.map((note) => `- ${note}`).join('\n')}\n`
            : 'No written notes yet.\n') +
          'Write a travel memory paragraph in English.',
      },
    ];
  }

  if (locale === 'de') {
    return [
      {
        role: 'system',
        content:
          'Du bist der Erinnerungsautor der Reise-App Red Panda. ' +
          'Schreibe aus den Fotos, Videos und Notizen einer Reise einen warmen, bildhaften Absatz auf Deutsch. ' +
          'Keine Aufzählungen, keine Überschrift, keine Erklärungen, maximal 120 Wörter. Gib nur den Erinnerungstext aus.',
      },
      {
        role: 'user',
        content:
          `Reise: ${context.journeyName}\n` +
          (context.destination ? `Reiseziel: ${context.destination}\n` : '') +
          (context.departTime ? `Abreise: ${context.departTime}\n` : '') +
          (context.returnTime ? `Rückkehr: ${context.returnTime}\n` : '') +
          `Fotos: ${context.photos}, Videos: ${context.videos}.\n` +
          (context.notes.length
            ? `Notizen:\n${context.notes.map((note) => `- ${note}`).join('\n')}\n`
            : 'Noch keine Notizen vorhanden.\n') +
          'Formuliere daraus eine kurze Reiseerinnerung auf Deutsch.',
      },
    ];
  }

  return [
    {
      role: 'system',
      content:
        '你是「小熊猫」旅程应用里的回忆作者。' +
        '根据用户给某段行程添加的照片、视频和文字，写一段温柔、有画面感的旅行回忆。' +
        '不要罗列清单，不要标题，不要解释，控制在 200 字以内，只输出回忆正文。',
    },
    {
      role: 'user',
      content:
        `行程：${context.journeyName}\n` +
        (context.destination ? `目的地：${context.destination}\n` : '') +
        (context.departTime ? `出发：${context.departTime}\n` : '') +
        (context.returnTime ? `返回：${context.returnTime}\n` : '') +
        `照片 ${context.photos} 张，视频 ${context.videos} 段。\n` +
        (context.notes.length
          ? `用户写下的片段：\n${context.notes.map((note) => `- ${note}`).join('\n')}\n`
          : '用户还没有写下文字。\n') +
        '请写成一段旅行回忆。',
    },
  ];
}

export function buildJourneyDescriptionMessages(name, hint, locale = 'zh') {
  if (locale === 'en') {
    return [
      {
        role: 'system',
        content:
          'You are the travel guide for Red Panda. Write a concise, vivid English summary for the journey. ' +
          'Output only the summary body without title or quotes, within 80 words.',
      },
      {
        role: 'user',
        content: `Journey name: ${name}\n${hint ? `Additional hint: ${hint}\n` : ''}Please write a short journey summary in English.`,
      },
    ];
  }

  if (locale === 'de') {
    return [
      {
        role: 'system',
        content:
          'Du bist der Reisebegleiter von Red Panda. Schreibe eine knappe, bildhafte Beschreibung für die Reise auf Deutsch. ' +
          'Gib nur den Beschreibungstext ohne Überschrift und Anführungszeichen aus, maximal 80 Wörter.',
      },
      {
        role: 'user',
        content: `Reisename: ${name}\n${hint ? `Hinweis: ${hint}\n` : ''}Bitte schreibe eine kurze Reisebeschreibung auf Deutsch.`,
      },
    ];
  }

  return [
    {
      role: 'system',
      content:
        '你是「小熊猫」旅程应用的向导，擅长用简洁、富有画面感的中文为旅程写简介。' +
        '只输出简介正文，不要标题、不要引号，控制在 120 字以内。',
    },
    {
      role: 'user',
      content: `旅程名称：${name}\n${hint ? `补充线索：${hint}\n` : ''}请为这段旅程写一段简介。`,
    },
  ];
}

export function buildJourneyPlanMessages(prompt, locale = 'zh', today = todayContext(locale)) {
  if (locale === 'en') {
    return [
      {
        role: 'system',
        content:
          'You are the trip planner for Red Panda. Extract destinations and departure/return times from the user’s travel idea. ' +
          'Output strictly a single JSON object with no Markdown fences, no explanation, and no extra text. ' +
          'Exact format: {"items":[{"destination":"Place name","departTime":"YYYY-MM-DDTHH:mm","returnTime":"YYYY-MM-DDTHH:mm"}]}. ' +
          'Use 24-hour YYYY-MM-DDTHH:mm format; leave empty string when unknown. ' +
          'Only fill times when the user mentions dates, weekdays, relative dates (e.g. "tomorrow", "next week", "3 days"), or clock times; otherwise both time fields must be empty strings.',
      },
      {
        role: 'user',
        content:
          `Today is ${today}.\nTravel idea: ${prompt}\n` +
          'Use today’s date only to resolve relative times actually mentioned by the user. ' +
          'If no time is mentioned, output empty strings for both departTime and returnTime. Output the JSON plan now.',
      },
    ];
  }

  if (locale === 'de') {
    return [
      {
        role: 'system',
        content:
          'Du bist der Reiseplaner von Red Panda. Extrahiere Reiseziele sowie Abreise- und Rückkehrzeiten aus der Reiseidee. ' +
          'Gib ausschließlich ein einzelnes JSON-Objekt ohne Markdown-Codeblock, ohne Erklärung und ohne Zusatztext aus. ' +
          'Exaktes Format: {"items":[{"destination":"Reiseziel","departTime":"YYYY-MM-DDTHH:mm","returnTime":"YYYY-MM-DDTHH:mm"}]}. ' +
          'Nutze 24-Stunden-Format YYYY-MM-DDTHH:mm oder leere Zeichenketten, wenn unbekannt. ' +
          'Fülle Zeiten nur aus, wenn Datum, Wochentag, relative Zeitangabe (z. B. „morgen“, „nächste Woche“, „3 Tage“) oder Uhrzeit genannt wird; sonst müssen beide Zeitfelder leer bleiben.',
      },
      {
        role: 'user',
        content:
          `Heute ist ${today}.\nReiseidee: ${prompt}\n` +
          'Verwende das heutige Datum nur für tatsächlich genannte relative Zeitangaben. ' +
          'Wenn keine Zeit genannt wird, lasse departTime und returnTime leer. Gib jetzt das JSON aus.',
      },
    ];
  }

  return [
    {
      role: 'system',
      content:
        '你是「小熊猫」旅程应用的向导，擅长把旅行想法整理成可出发的旅程计划。' +
        '从用户描述里分析提取目的地（地点）和出发/返回时间。' +
        '只输出一个 JSON 对象，不要 Markdown 代码块，不要解释，不要多余文字。' +
        '格式必须严格为：{"items":[{"destination":"目的地名称","departTime":"出发时间","returnTime":"返回时间"}]}；' +
        '每个目的地占一项；时间为 24 小时制 YYYY-MM-DDTHH:mm，无法确定的写空字符串。' +
        '时间提取规则：用户写了具体日期、时刻、星期或相对说法（如“今天”“下周”“下个月15号”“玩三天”“下午三点”）时，' +
        '必须换算并填入；用户完全没有提到任何时间时，两个时间字段都必须是空字符串，不要推测或编造。',
    },
    {
      role: 'user',
      content:
        `今天是 ${today}。\n用户想去的地方：${prompt}\n` +
        '今天日期用于换算用户确实写出的相对时间，例如「今天」「明天」「下周」「下个月15号」「玩三天」。' +
        '如果用户完全没有提到任何时间，两个时间字段都必须输出空字符串，不要推测。' +
        '并按上述格式输出旅程计划 JSON。',
    },
  ];
}

export function registerAiRoutes({ route, config, state, aiLimiter }) {
  function checkAiRate(auth) {
    if (!aiLimiter.consume(String(auth.user.id))) {
      throw new HttpError(429, 'AI 调用过于频繁，请十分钟后再试', 'rate_limited');
    }
  }

  route(
    'POST',
    /^\/api\/ai\/memory-recap$/,
    async ({ auth, body, req }) => {
      checkAiRate(auth);
      const supplied = body.context && typeof body.context === 'object' ? body.context : {};
      const context = {
        journeyName: optionalString(supplied.journeyName, '旅程名称', 80),
        destination: optionalString(supplied.destination, '目的地', 500),
        departTime: optionalString(supplied.departTime, '出发时间', 40),
        returnTime: optionalString(supplied.returnTime, '返回时间', 40),
        photos: Math.max(0, Math.min(10000, Number(supplied.photos) || 0)),
        videos: Math.max(0, Math.min(10000, Number(supplied.videos) || 0)),
        notes: Array.isArray(supplied.notes)
          ? supplied.notes
              .slice(0, 100)
              .map((note) => optionalString(note, '回忆文字', 2000))
              .filter(Boolean)
          : [],
      };
      const locale = localeForUser(body, req);
      if (config.ai.mock) {
        state.metrics.aiCalls += 1;
        return {
          status: 200,
          body: { recap: mockRecap(context, locale), model: 'mock', mock: true },
        };
      }
      const result = await chat(config, buildMemoryRecapMessages(context, locale), {
        maxTokens: 600,
        temperature: 0.9,
      });
      state.metrics.aiCalls += 1;
      return {
        status: 200,
        body: { recap: result.content, model: result.model, mock: result.mock },
      };
    },
    { auth: true },
  );

  route(
    'POST',
    /^\/api\/ai\/journey-description$/,
    async ({ auth, body, req }) => {
      checkAiRate(auth);
      const name = requiredString(body.name, '旅程名称', { min: 1, max: 80 });
      const hint = optionalString(body.hint, '补充线索', 300);
      const locale = localeForUser(body, req);
      const result = await chat(config, buildJourneyDescriptionMessages(name, hint, locale), {
        maxTokens: 400,
        temperature: 0.9,
      });
      state.metrics.aiCalls += 1;
      return {
        status: 200,
        body: { description: result.content, model: result.model, mock: result.mock },
      };
    },
    { auth: true },
  );

  route(
    'POST',
    /^\/api\/ai\/journey-plan$/,
    async ({ auth, body, req }) => {
      checkAiRate(auth);
      const prompt = requiredString(body.prompt, '旅行想法', { min: 1, max: 500 });
      const locale = localeForUser(body, req);
      if (config.ai.mock) {
        state.metrics.aiCalls += 1;
        const plan = mockPlan(prompt);
        return { status: 200, body: { items: plan.items, model: 'mock', mock: true } };
      }
      const result = await chat(config, buildJourneyPlanMessages(prompt, locale), {
        maxTokens: 900,
        temperature: 0.3,
      });
      state.metrics.aiCalls += 1;
      const plan = parseJourneyPlan(result.content);
      return {
        status: 200,
        body: { items: plan.items, model: result.model, mock: result.mock },
      };
    },
    { auth: true },
  );

  route(
    'POST',
    /^\/api\/ai\/chat$/,
    async ({ auth, body }) => {
      checkAiRate(auth);
      const messages = Array.isArray(body.messages) ? body.messages : null;
      if (!messages || messages.length === 0 || messages.length > 20) {
        throw new HttpError(400, 'messages 需为 1–20 条消息', 'validation_error');
      }
      const cleaned = messages.map((message) => {
        if (!message || typeof message !== 'object') {
          throw new HttpError(400, '消息格式不正确', 'validation_error');
        }
        if (!['system', 'user', 'assistant'].includes(message.role)) {
          throw new HttpError(400, '消息角色不正确', 'validation_error');
        }
        if (typeof message.content !== 'string' || message.content.length === 0) {
          throw new HttpError(400, '消息内容不能为空', 'validation_error');
        }
        if (message.content.length > 4000) {
          throw new HttpError(400, '单条消息不能超过 4000 个字符', 'validation_error');
        }
        return { role: message.role, content: message.content };
      });
      if (typeof body.system === 'string' && body.system.trim()) {
        cleaned.unshift({ role: 'system', content: body.system.trim().slice(0, 2000) });
      }
      const result = await chat(config, cleaned, { maxTokens: 800, temperature: 0.7 });
      state.metrics.aiCalls += 1;
      return {
        status: 200,
        body: { content: result.content, model: result.model, usage: result.usage, mock: result.mock },
      };
    },
    { auth: true },
  );
}
