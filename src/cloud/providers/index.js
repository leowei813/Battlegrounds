import { SelfHostProvider } from './SelfHostProvider.js';
import { SupabaseProvider } from './SupabaseProvider.js';

/**
 * 依建置時的環境變數建立雲端後端：
 *   VITE_CLOUD_PROVIDER = selfhost（預設）| supabase | none
 *   VITE_CLOUD_URL      自架伺服器網址（預設同網域 /api）
 *   VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
 */
export function createProvider(env = import.meta.env || {}) {
  const kind = (env.VITE_CLOUD_PROVIDER || 'selfhost').toLowerCase();
  if (kind === 'none') return null;
  if (kind === 'supabase') {
    if (!env.VITE_SUPABASE_URL || !env.VITE_SUPABASE_ANON_KEY) {
      console.warn('[cloud] 缺少 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY');
      return null;
    }
    return new SupabaseProvider(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY);
  }
  return new SelfHostProvider(env.VITE_CLOUD_URL || '');
}
