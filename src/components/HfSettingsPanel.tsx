/**
 * Catalogue → "Your Hugging Face account" (optional). Each user can point the
 * catalogue at their own model mirror and use their own token; both are kept
 * only on this device. Public mirrors need no token.
 */
import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { readHfSettings, writeHfSettings } from '../lib/catalog/hf-settings';
import { HF_MIRROR_OWNER } from '../lib/catalog/catalog';
import { Button } from './ui/Button';

export function HfSettingsPanel({ onSaved }: { onSaved?: () => void }) {
  const initial = readHfSettings();
  const [owner, setOwner] = useState(initial.mirrorOwner ?? '');
  const [token, setToken] = useState('');
  const [hasToken, setHasToken] = useState(Boolean(initial.token));
  const [msg, setMsg] = useState<string | null>(null);
  const inputCls =
    'w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900';

  function save(clear = false) {
    try {
      const s = writeHfSettings(
        clear ? {} : { mirrorOwner: owner, token: token.trim() ? token : hasToken ? readHfSettings().token : undefined }
      );
      setHasToken(Boolean(s.token));
      setToken('');
      if (clear) setOwner('');
      setMsg(clear ? 'Cleared — using the default mirror without a token.' : 'Saved on this device.');
      onSaved?.();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  return (
    <details className="rounded border border-slate-200 p-2 dark:border-slate-700" data-testid="hf-settings">
      <summary className="flex cursor-pointer items-center gap-1.5 text-xs font-medium text-slate-800 dark:text-slate-100">
        <KeyRound className="h-3.5 w-3.5" /> Your Hugging Face account (optional)
      </summary>
      <div className="mt-2 space-y-2 text-[11px]">
        <p className="leading-tight text-slate-500">
          Models download from a public mirror with no account. Use your own mirror (the <code>tamias-zenodo-liver-models</code>{' '}
          repo of your HF account, filled by the export workflow with your own <code>HF_TOKEN</code>) and, for a private or
          gated mirror, your own token. Stored only on this device, sent only to huggingface.co; every model is still checked
          against its pinned SHA-256.
        </p>
        <label className="block space-y-0.5">
          <span className="text-slate-600 dark:text-slate-300">Mirror account (default: {HF_MIRROR_OWNER})</span>
          <input
            data-testid="hf-mirror-owner"
            value={owner}
            onChange={(e) => setOwner(e.currentTarget.value)}
            placeholder={HF_MIRROR_OWNER}
            className={inputCls}
          />
        </label>
        <label className="block space-y-0.5">
          <span className="text-slate-600 dark:text-slate-300">Access token {hasToken ? '(saved — leave empty to keep)' : ''}</span>
          <input
            data-testid="hf-token"
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.currentTarget.value)}
            placeholder="hf_…"
            className={inputCls}
          />
        </label>
        <div className="flex gap-1.5">
          <Button size="sm" className="h-6 px-2 text-[11px]" data-testid="hf-save" onClick={() => save()}>
            Save
          </Button>
          <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => save(true)}>
            Clear
          </Button>
        </div>
        {msg && <p className="text-slate-600 dark:text-slate-300">{msg}</p>}
      </div>
    </details>
  );
}
