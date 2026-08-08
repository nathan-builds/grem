// Persistent app settings (chat provider config). Stored in userData as JSON;
// the Claude API key is encrypted with safeStorage when available.

import { app, safeStorage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_ACTIVITIES: Record<GremActivity, boolean> = {
  boxes: true,
  fishing: true,
  cooking: true,
  parachute: true,
  digging: true,
};

const DEFAULTS: GremSettingsData = {
  provider: 'claude',
  claudeApiKey: '',
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: '',
  activities: { ...DEFAULT_ACTIVITIES },
};

// On-disk shape: the key is stored either encrypted (base64) or, if OS-level
// encryption is unavailable, as plaintext with a marker so we know which.
interface SettingsFile {
  provider?: 'claude' | 'ollama';
  claudeApiKeyEnc?: string;
  claudeApiKeyPlain?: string;
  ollamaUrl?: string;
  ollamaModel?: string;
  activities?: Partial<Record<GremActivity, boolean>>;
}

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

export function loadSettings(): GremSettingsData {
  let file: SettingsFile = {};
  try {
    file = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch (_) {
    return { ...DEFAULTS };
  }

  let claudeApiKey = '';
  if (file.claudeApiKeyEnc) {
    try {
      claudeApiKey = safeStorage.decryptString(
        Buffer.from(file.claudeApiKeyEnc, 'base64')
      );
    } catch (_) {
      claudeApiKey = '';
    }
  } else if (file.claudeApiKeyPlain) {
    claudeApiKey = file.claudeApiKeyPlain;
  }

  return {
    provider: file.provider === 'ollama' ? 'ollama' : 'claude',
    claudeApiKey,
    ollamaUrl: file.ollamaUrl || DEFAULTS.ollamaUrl,
    ollamaModel: file.ollamaModel || '',
    // Missing keys (e.g. settings saved by an older version) default to on.
    activities: { ...DEFAULT_ACTIVITIES, ...(file.activities || {}) },
  };
}

export function saveSettings(s: GremSettingsData): void {
  const file: SettingsFile = {
    provider: s.provider,
    ollamaUrl: s.ollamaUrl,
    ollamaModel: s.ollamaModel,
    activities: s.activities,
  };
  if (s.claudeApiKey) {
    if (safeStorage.isEncryptionAvailable()) {
      file.claudeApiKeyEnc = safeStorage
        .encryptString(s.claudeApiKey)
        .toString('base64');
    } else {
      console.warn('grem: OS encryption unavailable, storing key as plaintext');
      file.claudeApiKeyPlain = s.claudeApiKey;
    }
  }
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(file, null, 2));
}
