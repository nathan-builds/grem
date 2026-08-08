// Settings window script. Like gremlin.ts, this is a plain script (no
// imports/exports) loaded via a <script> tag.

const providerRadios = document.querySelectorAll<HTMLInputElement>(
  'input[name="provider"]'
);
const claudeSection = document.getElementById('claude-section') as HTMLFieldSetElement;
const ollamaSection = document.getElementById('ollama-section') as HTMLFieldSetElement;
const claudeKeyInput = document.getElementById('claude-key') as HTMLInputElement;
const ollamaUrlInput = document.getElementById('ollama-url') as HTMLInputElement;
const ollamaTestBtn = document.getElementById('ollama-test') as HTMLButtonElement;
const ollamaStatus = document.getElementById('ollama-status') as HTMLSpanElement;
const ollamaModelSelect = document.getElementById('ollama-model') as HTMLSelectElement;
const consoleLink = document.getElementById('console-link') as HTMLAnchorElement;
const saveBtn = document.getElementById('save') as HTMLButtonElement;
const cancelBtn = document.getElementById('cancel') as HTMLButtonElement;

function currentProvider(): 'claude' | 'ollama' {
  for (const r of providerRadios) {
    if (r.checked && r.value === 'ollama') return 'ollama';
  }
  return 'claude';
}

function refreshSections(): void {
  const p = currentProvider();
  claudeSection.classList.toggle('hidden', p !== 'claude');
  ollamaSection.classList.toggle('hidden', p !== 'ollama');
}

function setModelOptions(models: string[], selected: string): void {
  ollamaModelSelect.innerHTML = '';
  if (models.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '(test connection to list models)';
    ollamaModelSelect.appendChild(opt);
    return;
  }
  for (const name of models) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    if (name === selected) opt.selected = true;
    ollamaModelSelect.appendChild(opt);
  }
}

async function testOllama(showStatus: boolean): Promise<void> {
  const url = ollamaUrlInput.value.trim() || 'http://localhost:11434';
  if (showStatus) {
    ollamaStatus.textContent = 'checking...';
    ollamaStatus.className = 'status';
  }
  const result = await window.gremSettings.listOllamaModels(url);
  if (result.ok) {
    setModelOptions(result.models, ollamaModelSelect.value);
    if (showStatus) {
      ollamaStatus.textContent =
        result.models.length > 0
          ? `connected — ${result.models.length} model(s)`
          : 'connected, but no models installed';
      ollamaStatus.className = 'status ok';
    }
  } else if (showStatus) {
    ollamaStatus.textContent = result.error || 'connection failed';
    ollamaStatus.className = 'status bad';
  }
}

async function init(): Promise<void> {
  const s = await window.gremSettings.getSettings();
  for (const r of providerRadios) r.checked = r.value === s.provider;
  claudeKeyInput.value = s.claudeApiKey;
  ollamaUrlInput.value = s.ollamaUrl;
  if (s.ollamaModel) setModelOptions([s.ollamaModel], s.ollamaModel);
  refreshSections();
  // Quietly try to populate the model list from the saved URL.
  testOllama(false).then(() => {
    if (s.ollamaModel) ollamaModelSelect.value = s.ollamaModel;
  });
}

for (const r of providerRadios) r.addEventListener('change', refreshSections);
ollamaTestBtn.addEventListener('click', () => testOllama(true));
consoleLink.addEventListener('click', () =>
  window.gremSettings.openExternal('https://console.anthropic.com')
);
cancelBtn.addEventListener('click', () => window.close());
saveBtn.addEventListener('click', async () => {
  await window.gremSettings.saveSettings({
    provider: currentProvider(),
    claudeApiKey: claudeKeyInput.value.trim(),
    ollamaUrl: ollamaUrlInput.value.trim() || 'http://localhost:11434',
    ollamaModel: ollamaModelSelect.value,
  });
  window.close();
});

init();
