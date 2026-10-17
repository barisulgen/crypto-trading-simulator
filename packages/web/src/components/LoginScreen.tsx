import { useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiError } from '../lib/api.ts';
import { afterLogin } from '../lib/live.ts';
import { Button, ErrorText, TextField } from './ui.tsx';

/** Shown on any 401: the server runs on the LAN with a password (APP_PASSWORD). */
export function LoginScreen() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.login(password);
      afterLogin();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <main className="flex flex-1 items-center justify-center p-4">
      <form onSubmit={submit} className="flex w-full max-w-[22rem] flex-col gap-4 rounded-dialog border border-line bg-panel p-6">
        <div className="flex flex-col gap-1">
          <h1 className="text-lg font-semibold">Log in</h1>
          <p className="text-sm text-muted">This simulator is shared on your network. Enter the password set in its APP_PASSWORD.</p>
        </div>
        <TextField
          label="Password"
          type="password"
          name="password"
          autoComplete="current-password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <ErrorText>{error}</ErrorText>
        <Button type="submit" tone="primary" className="h-10" disabled={busy || password === ''}>
          {busy ? 'Logging in...' : 'Log in'}
        </Button>
      </form>
    </main>
  );
}
