// LLM client: Anthropic Messages API, OpenAI-compatible chat/completions, and a mock provider.
// Runs in the browser (and in node for tests via the mock provider / injected fetch).

const DEFAULT_MODELS = {
  anthropic: 'claude-sonnet-4-5',
  openai: 'gpt-4o-mini',
  mock: 'mock',
};

/**
 * Tolerant JSON extraction: whole text / ```json fence / first {..last} or [..last].
 * Throws an Error if nothing parses.
 */
export function extractJSON(text) {
  if (text && typeof text === 'object') return text;
  const s = String(text ?? '').trim();
  if (!s) throw new Error('LLM returned an empty response (expected JSON).');
  const tries = [];
  tries.push(s);
  const fenceRe = /```(?:json|JSON)?\s*([\s\S]*?)```/g;
  let m;
  while ((m = fenceRe.exec(s))) tries.push(m[1].trim());
  const ob = s.indexOf('{');
  const oe = s.lastIndexOf('}');
  if (ob !== -1 && oe > ob) tries.push(s.slice(ob, oe + 1));
  const ab = s.indexOf('[');
  const ae = s.lastIndexOf(']');
  if (ab !== -1 && ae > ab) tries.push(s.slice(ab, ae + 1));
  for (const t of tries) {
    try { return JSON.parse(t); } catch { /* next */ }
    // tolerate trailing commas
    try { return JSON.parse(t.replace(/,\s*([}\]])/g, '$1')); } catch { /* next */ }
  }
  const preview = s.length > 200 ? s.slice(0, 200) + '…' : s;
  throw new Error('Could not parse JSON from LLM response: ' + preview);
}

async function httpError(res, providerLabel) {
  let body = '';
  try { body = await res.text(); } catch { /* ignore */ }
  let detail = '';
  try {
    const j = JSON.parse(body);
    detail = j?.error?.message || j?.message || '';
  } catch { detail = body.slice(0, 300); }
  let msg;
  if (res.status === 401 || res.status === 403) {
    msg = `API key rejected by ${providerLabel} (HTTP ${res.status}). Check the key in Settings.`;
  } else if (res.status === 429) {
    msg = `Rate limit reached at ${providerLabel} (HTTP 429). Wait a moment and try again.`;
  } else if (res.status === 529 || res.status === 503) {
    msg = `${providerLabel} is overloaded (HTTP ${res.status}). Try again shortly.`;
  } else {
    msg = `${providerLabel} request failed (HTTP ${res.status})`;
  }
  if (detail) msg += ` — ${detail}`;
  const err = new Error(msg);
  err.status = res.status;
  return err;
}

async function doFetch(fetchImpl, url, init, providerLabel) {
  try {
    return await fetchImpl(url, init);
  } catch (e) {
    const err = new Error(
      `Network error calling ${providerLabel}: ${e?.message || e}. ` +
      'This is usually a CORS or network problem (the endpoint must allow browser requests), ' +
      'or you are offline.'
    );
    err.cause = e;
    throw err;
  }
}

/**
 * createLLM({ provider, apiKey, model, baseUrl, mockHandler, fetchImpl }) -> LLM
 */
export function createLLM({ provider = 'anthropic', apiKey, model, baseUrl, mockHandler, fetchImpl } = {}) {
  const prov = provider || 'anthropic';
  if (!['anthropic', 'openai', 'mock'].includes(prov)) {
    throw new Error(`Unknown LLM provider "${prov}" (use anthropic, openai or mock).`);
  }
  const usedModel = model || DEFAULT_MODELS[prov];
  const getFetch = () => fetchImpl || globalThis.fetch.bind(globalThis);

  async function complete({ system = '', messages = [], maxTokens = 2000 } = {}) {
    if (prov === 'mock') {
      if (typeof mockHandler !== 'function') throw new Error('Mock LLM requires a mockHandler function.');
      const out = await mockHandler({ system, messages });
      return typeof out === 'string' ? out : JSON.stringify(out);
    }
    if (!apiKey) throw new Error('Add an API key in Settings to use the AI agents.');

    if (prov === 'anthropic') {
      const url = (baseUrl ? baseUrl.replace(/\/+$/, '') : 'https://api.anthropic.com/v1') + '/messages';
      const res = await doFetch(getFetch(), url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({ model: usedModel, max_tokens: maxTokens, system, messages }),
      }, 'Anthropic');
      if (!res.ok) throw await httpError(res, 'Anthropic');
      const j = await res.json();
      const text = (j.content || []).filter((c) => c && c.type === 'text').map((c) => c.text).join('');
      if (!text) throw new Error('Anthropic returned no text content.');
      return text;
    }

    // openai-compatible
    const url = (baseUrl ? baseUrl.replace(/\/+$/, '') : 'https://api.openai.com/v1') + '/chat/completions';
    const msgs = [];
    if (system) msgs.push({ role: 'system', content: system });
    for (const m of messages) msgs.push({ role: m.role, content: m.content });
    const res = await doFetch(getFetch(), url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: usedModel, max_tokens: maxTokens, messages: msgs }),
    }, 'OpenAI-compatible API');
    if (!res.ok) throw await httpError(res, 'OpenAI-compatible API');
    const j = await res.json();
    const text = j?.choices?.[0]?.message?.content;
    if (!text) throw new Error('OpenAI-compatible API returned no message content.');
    return text;
  }

  async function completeJSON(args) {
    const text = await complete(args);
    return extractJSON(text);
  }

  return { provider: prov, model: usedModel, complete, completeJSON };
}
