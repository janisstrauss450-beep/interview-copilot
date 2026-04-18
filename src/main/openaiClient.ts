import { getApiKey } from './apiKey.js';

const CHAT_ENDPOINT = 'https://api.openai.com/v1/chat/completions';

export interface ChatCallOptions {
  model: string | string[];
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: 'text' | 'json_object';
  signal?: AbortSignal;
}

function modelCandidates(model: string | string[]): string[] {
  return Array.isArray(model) ? model : [model];
}

function isSkippableModelError(status: number, body: string): boolean {
  if (status !== 400 && status !== 404 && status !== 403) return false;
  const lower = body.toLowerCase();
  return (
    lower.includes('model') &&
    (lower.includes('does not exist') ||
      lower.includes('not found') ||
      lower.includes('not have access') ||
      lower.includes('not supported') ||
      lower.includes('unsupported'))
  );
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });
}

function isTransient5xx(status: number): boolean {
  return status >= 500 && status < 600;
}

function usesNewMaxParam(model: string): boolean {
  // gpt-5.x, o1, o3, o4 families want `max_completion_tokens`.
  // gpt-4o, gpt-4-turbo, gpt-3.5 still accept `max_tokens`.
  return /^(gpt-5|o1|o3|o4)/i.test(model);
}

function buildBody(
  opts: ChatCallOptions,
  stream: boolean,
  model: string,
): string {
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: opts.system },
      { role: 'user', content: opts.user },
    ],
    stream,
  };
  if (typeof opts.temperature === 'number') body.temperature = opts.temperature;
  if (typeof opts.maxTokens === 'number') {
    if (usesNewMaxParam(model)) {
      body.max_completion_tokens = opts.maxTokens;
    } else {
      body.max_tokens = opts.maxTokens;
    }
  }
  if (opts.responseFormat === 'json_object') {
    body.response_format = { type: 'json_object' };
  }
  return JSON.stringify(body);
}

async function authHeaders(): Promise<Record<string, string>> {
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error('No OpenAI API key available. Set one in the setup window.');
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
}

export async function callChatCompletion(opts: ChatCallOptions): Promise<string> {
  const headers = await authHeaders();
  const candidates = modelCandidates(opts.model);
  let lastError = '';

  for (const model of candidates) {
    const body = buildBody(opts, false, model);
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(CHAT_ENDPOINT, {
        method: 'POST',
        headers,
        body,
        signal: opts.signal,
      });
      if (res.ok) {
        const json = (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        return json.choices?.[0]?.message?.content ?? '';
      }
      const errText = await res.text();
      const snippet = errText.slice(0, 400);
      if (isSkippableModelError(res.status, errText)) {
        lastError = `model ${model}: ${snippet}`;
        break; // try next model
      }
      if (isTransient5xx(res.status) && attempt === 0) {
        await delay(600, opts.signal);
        continue;
      }
      throw new Error(`OpenAI HTTP ${res.status}: ${snippet}`);
    }
  }
  throw new Error(`All candidate models rejected. Last: ${lastError || 'none'}`);
}

export async function* callChatCompletionStream(
  opts: ChatCallOptions,
): AsyncGenerator<string, void, void> {
  const headers = await authHeaders();
  const candidates = modelCandidates(opts.model);
  let lastError = '';
  let res: Response | null = null;

  outer: for (const model of candidates) {
    const body = buildBody(opts, true, model);
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await fetch(CHAT_ENDPOINT, {
        method: 'POST',
        headers,
        body,
        signal: opts.signal,
      });
      if (r.ok) {
        res = r;
        break outer;
      }
      const errText = await r.text();
      const snippet = errText.slice(0, 400);
      if (isSkippableModelError(r.status, errText)) {
        lastError = `model ${model}: ${snippet}`;
        break; // try next model
      }
      if (isTransient5xx(r.status) && attempt === 0) {
        await delay(600, opts.signal);
        continue;
      }
      throw new Error(`OpenAI HTTP ${r.status}: ${snippet}`);
    }
  }
  if (!res) throw new Error(`All candidate models rejected. Last: ${lastError || 'none'}`);
  if (!res.body) throw new Error('OpenAI returned no stream body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let carry = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    carry += decoder.decode(value, { stream: true });
    const lines = carry.split('\n');
    carry = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data: ')) continue;
      const payload = trimmed.slice(6).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const event = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string } }>;
        };
        const token = event.choices?.[0]?.delta?.content;
        if (typeof token === 'string' && token) yield token;
      } catch {
        // ignore malformed chunks
      }
    }
  }
}
