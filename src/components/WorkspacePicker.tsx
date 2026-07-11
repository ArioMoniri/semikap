/**
 * Local-profile "login" control for the header. No backend: a profile is a
 * named on-device workspace that namespaces the user's models, datasets, and
 * benchmark runs. Gated profiles require a passphrase (verified against a local
 * PBKDF2 verifier — never uploaded, never used to decrypt anything).
 */

import { useEffect, useRef, useState } from 'react';
import { UserRound, Plus, Trash2, Lock, LogOut, Check } from 'lucide-react';
import {
  listProfiles,
  createProfile,
  deleteProfile,
  verifyPassphrase,
  setActiveProfileId,
  getProfile,
  type Profile,
} from '../lib/workspace/profiles';
import { listRecords } from '../lib/benchmark/store';
import { useBenchmarkStore } from '../lib/state/benchmarkStore';
import { Button } from './ui/Button';

export function WorkspacePicker() {
  const currentProfileId = useBenchmarkStore((s) => s.currentProfileId);
  const setCurrentProfile = useBenchmarkStore((s) => s.setCurrentProfile);
  const setRecords = useBenchmarkStore((s) => s.setRecords);
  const bump = useBenchmarkStore((s) => s.bump);
  const tick = useBenchmarkStore((s) => s.tick);

  const [open, setOpen] = useState(false);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [newName, setNewName] = useState('');
  const [newPass, setNewPass] = useState('');
  const [unlockId, setUnlockId] = useState<string | null>(null);
  const [unlockPass, setUnlockPass] = useState('');
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setProfiles(listProfiles());
  }, [open, tick]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const current = currentProfileId ? getProfile(currentProfileId) : null;

  async function activate(id: string) {
    setActiveProfileId(id);
    setCurrentProfile(id);
    setRecords(await listRecords(id));
    setUnlockId(null);
    setUnlockPass('');
    setError(null);
    setOpen(false);
  }

  async function onSelect(p: Profile) {
    setError(null);
    if (p.hasPassphrase) {
      setUnlockId(p.id);
      return;
    }
    await activate(p.id);
  }

  async function onUnlock() {
    if (!unlockId) return;
    const ok = await verifyPassphrase(unlockId, unlockPass);
    if (!ok) {
      setError('Incorrect passphrase.');
      return;
    }
    await activate(unlockId);
  }

  async function onCreate() {
    setError(null);
    try {
      const p = await createProfile(newName, newPass || undefined);
      setNewName('');
      setNewPass('');
      bump();
      await activate(p.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function onDelete(id: string) {
    deleteProfile(id);
    if (currentProfileId === id) {
      setCurrentProfile(null);
      setRecords([]);
    }
    bump();
  }

  function signOut() {
    setCurrentProfile(null);
    setRecords([]);
    setOpen(false);
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Local benchmarking profile"
        className="inline-flex items-center gap-1 rounded-md border border-white/15 bg-white/10 px-2 py-1 text-[11px] text-white/85 hover:bg-white/15"
      >
        <UserRound className="h-3 w-3" />
        {current ? current.name : 'Sign in'}
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-1 w-64 rounded-lg border border-slate-200 bg-white p-3 text-slate-800 shadow-xl dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Benchmarking profiles
          </div>

          <div className="max-h-40 space-y-1 overflow-y-auto">
            {profiles.length === 0 && (
              <div className="py-2 text-xs text-slate-400">No profiles yet — create one below.</div>
            )}
            {profiles.map((p) => (
              <div key={p.id} className="rounded-md border border-slate-100 dark:border-slate-800">
                <div className="flex items-center justify-between gap-2 px-2 py-1.5">
                  <button
                    type="button"
                    onClick={() => onSelect(p)}
                    className="flex min-w-0 flex-1 items-center gap-1 text-left text-xs"
                  >
                    {p.id === currentProfileId ? (
                      <Check className="h-3 w-3 shrink-0 text-emerald-500" />
                    ) : p.hasPassphrase ? (
                      <Lock className="h-3 w-3 shrink-0 text-slate-400" />
                    ) : (
                      <UserRound className="h-3 w-3 shrink-0 text-slate-400" />
                    )}
                    <span className="truncate">{p.name}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onDelete(p.id)}
                    title="Delete profile"
                    className="text-slate-400 hover:text-red-500"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
                {unlockId === p.id && (
                  <div className="flex items-center gap-1 px-2 pb-2">
                    <input
                      type="password"
                      value={unlockPass}
                      onChange={(e) => setUnlockPass(e.target.value)}
                      placeholder="Passphrase"
                      className="h-7 min-w-0 flex-1 rounded border border-slate-300 px-2 text-xs dark:border-slate-600 dark:bg-slate-800"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void onUnlock();
                      }}
                    />
                    <Button size="sm" onClick={() => void onUnlock()}>
                      Unlock
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="mt-3 border-t border-slate-100 pt-2 dark:border-slate-800">
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="New profile name"
              className="mb-1 h-7 w-full rounded border border-slate-300 px-2 text-xs dark:border-slate-600 dark:bg-slate-800"
            />
            <input
              type="password"
              value={newPass}
              onChange={(e) => setNewPass(e.target.value)}
              placeholder="Passphrase (optional)"
              className="mb-1 h-7 w-full rounded border border-slate-300 px-2 text-xs dark:border-slate-600 dark:bg-slate-800"
            />
            <Button size="sm" className="w-full" onClick={() => void onCreate()}>
              <Plus className="h-3 w-3" /> Create & switch
            </Button>
          </div>

          {current && (
            <button
              type="button"
              onClick={signOut}
              className="mt-2 inline-flex w-full items-center justify-center gap-1 text-xs text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
            >
              <LogOut className="h-3 w-3" /> Sign out of {current.name}
            </button>
          )}

          {error && <div className="mt-2 text-xs text-red-500">{error}</div>}
        </div>
      )}
    </div>
  );
}
