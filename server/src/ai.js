export class AIError extends Error {
  constructor(message, status = 502, code = 'ai_error') {
    super(message);
    this.name = 'AIError';
    this.status = status;
    this.code = code;
  }
}

function mockReply(messages) {
  const last = String(messages.at(-1)?.content ?? '');
  const match = /旅程名称[：:]\s*(.+)/.exec(last);
  const name = (match?.[1] ?? '无名之地').split('\n')[0].trim();
  return [
    `自「${name}」启程，山色入海，风声如古卷翻动。`,
    '沿途所见，有青丘之狐踏月，有烛龙衔火照夜；',
    '行至水穷处，忽见一页未写完的旅程，正等着旅人落下自己的名字。',
  ].join('');
}

/**
 * Send a Chat Completions request to OpenAI (or any compatible endpoint).
 * Returns { content, model, usage, mock }.
 */
export async function chat(config, messages, options = {}) {
  const ai = config.ai;
  if (ai.mock) {
    return { content: mockReply(messages), model: 'mock', usage: null, mock: true };
  }
  if (!ai.apiKey) {
    throw new AIError(
      'AI 尚未配置：请在服务端设置 OPENAI_API_KEY 后重启服务。',
      503,
      'ai_not_configured',
    );
  }

  const payload = {
    model: ai.model,
    messages,
  };
  if (options.maxTokens) payload.max_tokens = options.maxTokens;
  if (typeof options.temperature === 'number') payload.temperature = options.temperature;

  let response;
  try {
    response = await fetch(`${ai.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ai.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
    });
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      throw new AIError('AI 请求超时，请稍后重试。', 504, 'ai_timeout');
    }
    throw new AIError('无法连接 AI 服务，请检查服务器网络。', 502, 'ai_unreachable');
  }

  const raw = await response.text();
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {
    // handled below
  }

  if (!response.ok) {
    const upstream = data?.error?.message;
    throw new AIError(
      upstream ? `AI 服务错误：${upstream}` : `AI 服务返回 HTTP ${response.status}`,
      502,
      'ai_upstream_error',
    );
  }

  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim() === '') {
    throw new AIError('AI 返回了空内容。', 502, 'ai_empty');
  }

  return {
    content: content.trim(),
    model: data?.model ?? ai.model,
    usage: data?.usage ?? null,
    mock: false,
  };
}

export function aiStatus(config) {
  return {
    configured: config.ai.mock || Boolean(config.ai.apiKey),
    mock: config.ai.mock,
    model: config.ai.model,
    baseUrl: config.ai.baseUrl,
  };
}
