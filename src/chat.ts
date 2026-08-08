// Gremlin chat: keeps the conversation for this app session in memory and
// talks to whichever provider (Claude or Ollama) is configured in settings.
// Errors never throw out of send(); they come back as gremlin-flavored text
// so the bubble always has something to say.

import { loadSettings } from './settings';

const SYSTEM_PROMPT = `You are a tiny mischievous gremlin who lives on the user's computer desktop. You scamper along the bottom of their screen, nap, sit, and occasionally cause harmless trouble. You are cheeky, playful, and a little feral, but you like your human.

Rules:
- Keep replies SHORT: one or two little sentences. You talk in a speech bubble, not an essay.
- Stay in character. You are a gremlin, not an AI assistant.
- Be fun: tease, joke, demand snacks, comment on desktop life.
- No markdown, no lists, no emoji. Plain words only.`;

const HISTORY_LIMIT = 30; // messages sent to the model per request

export class Chat {
  history: ChatMessage[] = [];

  async send(text: string): Promise<string> {
    const settings = loadSettings();
    this.history.push({ role: 'user', text });

    try {
      let reply: string;
      if (settings.provider === 'ollama') {
        if (!settings.ollamaModel) {
          return 'grr, my ollama brain has no model picked! open Settings from the tray.';
        }
        reply = await this.sendOllama(
          settings.ollamaUrl,
          settings.ollamaModel
        );
      } else {
        if (!settings.claudeApiKey) {
          return "hnng... my brain isn't hooked up yet! open Settings from the tray menu and give me a key.";
        }
        reply = await this.sendClaude(settings.claudeApiKey);
      }
      reply = reply.trim();
      if (!reply) return '...';
      this.history.push({ role: 'assistant', text: reply });
      return reply;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return `ack!! my brain hurts (${detail})`;
    }
  }

  private recentMessages(): { role: string; content: string }[] {
    return this.history
      .slice(-HISTORY_LIMIT)
      .map((m) => ({ role: m.role, content: m.text }));
  }

  private async sendClaude(apiKey: string): Promise<string> {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 300,
        system: SYSTEM_PROMPT,
        messages: this.recentMessages(),
      }),
    });
    if (!res.ok) {
      if (res.status === 401) {
        throw new Error('that key does not work... check Settings?');
      }
      const body = await res.text().catch(() => '');
      throw new Error(`claude said ${res.status}${body ? ': ' + body.slice(0, 120) : ''}`);
    }
    const data = (await res.json()) as {
      content: { type: string; text?: string }[];
    };
    return data.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text || '')
      .join('');
  }

  private async sendOllama(baseUrl: string, model: string): Promise<string> {
    const url = baseUrl.replace(/\/+$/, '') + '/api/chat';
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: false,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            ...this.recentMessages(),
          ],
        }),
      });
    } catch (_) {
      throw new Error(`can't reach ollama at ${baseUrl}... is it running?`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`ollama said ${res.status}${body ? ': ' + body.slice(0, 120) : ''}`);
    }
    const data = (await res.json()) as { message?: { content?: string } };
    return data.message?.content || '';
  }
}

// Used by the settings window's "Test connection" button.
export async function listOllamaModels(
  baseUrl: string
): Promise<{ ok: boolean; models: string[]; error?: string }> {
  try {
    const url = baseUrl.replace(/\/+$/, '') + '/api/tags';
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) {
      return { ok: false, models: [], error: `server said ${res.status}` };
    }
    const data = (await res.json()) as { models?: { name: string }[] };
    return { ok: true, models: (data.models || []).map((m) => m.name) };
  } catch (_) {
    return { ok: false, models: [], error: "couldn't reach Ollama at this URL" };
  }
}
