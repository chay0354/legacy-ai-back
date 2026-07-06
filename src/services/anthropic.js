export async function callClaude({ system, userMessage, maxTokens = 8192, jsonPrefill = false }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  const messages = jsonPrefill
    ? [
        { role: 'user', content: userMessage },
        { role: 'assistant', content: '{' },
      ]
    : [{ role: 'user', content: userMessage }];

  const res = await fetch(process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': process.env.ANTHROPIC_VERSION || '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || 'claude-opus-4-8',
      max_tokens: maxTokens,
      system,
      messages,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  let text = data.content?.find((b) => b.type === 'text')?.text ?? '';
  if (jsonPrefill) text = `{${text}`;

  return {
    text,
    stopReason: data.stop_reason ?? null,
  };
}

/** @deprecated use callClaude().text */
export async function callClaudeText(opts) {
  const { text } = await callClaude(opts);
  return text;
}

function stripTrailingCommas(json) {
  return json.replace(/,\s*([}\]])/g, '$1');
}

export function parseJsonFromClaude(text) {
  const input = String(text ?? '').trim();
  if (!input) throw new Error('Empty response');

  const attempts = [];

  const fenced = input.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) attempts.push(fenced[1].trim());

  attempts.push(input);

  const start = input.indexOf('{');
  const end = input.lastIndexOf('}');
  if (start >= 0 && end > start) {
    attempts.push(input.slice(start, end + 1));
  }

  let lastError;
  for (const candidate of attempts) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch (e) {
      lastError = e;
      try {
        return JSON.parse(stripTrailingCommas(candidate));
      } catch (e2) {
        lastError = e2;
      }
    }
  }

  throw lastError || new Error('No JSON object found');
}

/** Call Claude and parse JSON from the response. Retries once on parse failure. */
export async function callClaudeJson({ system, userMessage, maxTokens = 8192 }) {
  let { text, stopReason } = await callClaude({ system, userMessage, maxTokens, jsonPrefill: false });

  if (stopReason === 'max_tokens') {
    console.warn('[anthropic] JSON response may be truncated (max_tokens)');
  }

  try {
    return parseJsonFromClaude(text);
  } catch (firstErr) {
    console.warn('[anthropic] JSON parse failed, retrying repair:', firstErr.message);
    console.warn('[anthropic] Raw snippet:', text.slice(0, 800));

    const { text: repaired } = await callClaude({
      system: 'You repair malformed JSON. Return ONLY a valid JSON object — no markdown fences, no commentary.',
      userMessage: `Fix this into valid JSON. Preserve all fields and content exactly where possible:\n\n${text}`,
      maxTokens,
      jsonPrefill: false,
    });

    return parseJsonFromClaude(repaired);
  }
}
