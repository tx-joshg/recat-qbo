import { getInstanceSettings } from '../instanceSettings.js';

interface ChatCompletionResponse {
  choices?: { message?: { content?: string } }[];
}

/** Complete the category-only prompt using the active configured provider. */
export async function completeCategory(prompt: string): Promise<string | null> {
  try {
    const settings = await getInstanceSettings();
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
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers,
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
  } catch {
    return null;
  }
}
