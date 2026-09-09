import { getInstanceSettings, type InstanceSettings } from '../instanceSettings.js';

export type CategoryProviderSettings = Pick<InstanceSettings,
  | 'suggestionProvider'
  | 'suggestionModel'
  | 'aiEndpoint'
  | 'aiApiKey'
  | 'openrouterApiKey'
  | 'openrouterReferer'
  | 'openrouterTitle'
>;

interface ChatCompletionResponse {
  choices?: { message?: { content?: string } }[];
}

const COMPLETION_TIMEOUT_MS = 30_000;

/** Complete the category-only prompt using the active configured provider. */
export async function completeCategory(
  prompt: string,
  providerSettings?: CategoryProviderSettings,
): Promise<string | null> {
  try {
    const settings = providerSettings ?? await getInstanceSettings();
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
