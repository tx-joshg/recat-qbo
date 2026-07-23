import { getInstanceSettings } from '../instanceSettings.js';
import {
  getCodexAccess,
  markCodexReconnectRequired,
} from './codexAuth.js';
import { completeCodexText } from './codexResponses.js';

interface ChatCompletionResponse {
  choices?: { message?: { content?: string } }[];
}

const COMPLETION_TIMEOUT_MS = 30_000;

async function completeWithCodex(prompt: string, model: string): Promise<string> {
  let credentials = await getCodexAccess();
  try {
    return await completeCodexText({
      ...credentials,
      model,
      messages: [{ role: 'user', content: prompt }],
    });
  } catch (error) {
    if (!(error instanceof Error) || !('status' in error) || error.status !== 401) throw error;
  }

  credentials = await getCodexAccess({
    forceRefresh: { failedAccessToken: credentials.accessToken },
  });
  try {
    return await completeCodexText({
      ...credentials,
      model,
      messages: [{ role: 'user', content: prompt }],
    });
  } catch (error) {
    if (error instanceof Error && 'status' in error && error.status === 401) {
      await markCodexReconnectRequired({
        failedAccessToken: credentials.accessToken,
        failureCode: 'inference_unauthorized',
      });
    }
    throw error;
  }
}

/** Complete the category-only prompt using the active configured provider. */
export async function completeCategory(prompt: string): Promise<string | null> {
  try {
    const settings = await getInstanceSettings();
    if (settings.suggestionProvider === 'codex') {
      const content = await completeWithCodex(prompt, settings.codexModel);
      return content.trim() || null;
    }
    const openrouter = settings.suggestionProvider === 'openrouter';
    const baseUrl = openrouter ? 'https://openrouter.ai/api/v1' : settings.aiEndpoint;
    if (baseUrl === '') return null;

    const apiKey = openrouter ? settings.openrouterApiKey : settings.aiApiKey;
    const headers = {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      ...(openrouter && settings.openrouterReferer ? { 'HTTP-Referer': settings.openrouterReferer } : {}),
      ...(openrouter && settings.openrouterTitle ? { 'X-Title': settings.openrouterTitle } : {}),
    };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), COMPLETION_TIMEOUT_MS);
    try {
      const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          model: settings.suggestionModel,
          temperature: 0,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as ChatCompletionResponse;
      const content = body.choices?.[0]?.message?.content;
      return typeof content === 'string' ? content.trim() : null;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return null;
  }
}

/** Admin-only route helper: fixed prompt contains no company or transaction data. */
export async function testCodexConnection(): Promise<{ ok: true }> {
  const settings = await getInstanceSettings();
  await completeWithCodex('Reply with only the word "ok".', settings.codexModel);
  return { ok: true };
}
