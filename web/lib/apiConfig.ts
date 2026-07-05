// User-provided image generation API config (BYOK — bring your own key).
// Stored in localStorage only; the key is passed through the /api/generate
// route per-request and never persisted server-side.

export type ApiProvider = 'gemini' | 'openai' | 'xai' | 'openrouter' | 'custom';
export type ApiFormat = 'gemini' | 'openai' | 'openrouter';

export type ApiConfig = {
  provider: ApiProvider;
  apiKey: string;
  model: string;
  baseUrl: string; // only used when provider === 'custom'
  format: ApiFormat; // request/response shape; fixed for presets
};

export const PRESETS: Record<
  ApiProvider,
  { label: string; defaultModel: string; format: ApiFormat; keyHint: string }
> = {
  gemini: {
    label: 'Google Gemini',
    defaultModel: 'gemini-3.1-flash-lite-image',
    format: 'gemini',
    keyHint: 'AQ... / AIza...',
  },
  openai: {
    label: 'OpenAI',
    defaultModel: 'gpt-image-1',
    format: 'openai',
    keyHint: 'sk-...',
  },
  xai: {
    label: 'xAI Grok',
    defaultModel: 'grok-imagine-image-quality',
    format: 'openai',
    keyHint: 'xai-...',
  },
  openrouter: {
    label: 'OpenRouter',
    defaultModel: 'google/gemini-2.5-flash-image',
    format: 'openrouter',
    keyHint: 'sk-or-...',
  },
  custom: {
    label: 'Custom endpoint',
    defaultModel: '',
    format: 'openai',
    keyHint: 'your API key',
  },
};

const STORAGE_KEY = 'vanilla-canvas-api-config';

export function loadApiConfig(): ApiConfig | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const cfg = JSON.parse(raw) as ApiConfig;
    if (!cfg.provider || !PRESETS[cfg.provider]) return null;
    return cfg;
  } catch {
    return null;
  }
}

export function saveApiConfig(cfg: ApiConfig) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
}
