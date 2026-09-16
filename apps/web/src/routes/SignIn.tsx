import { useState, type FormEvent } from 'react';
import { useSession } from '../lib/session';
import { Button, Field } from '../components/ui';

/**
 * Sign-in.
 *
 * The failure message is the same whether the address is unknown or the
 * password is wrong, matching the server, which also equalises the time both
 * take. Anything more specific would enumerate accounts.
 */
export function SignInPage() {
  const { signIn } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);

    try {
      await signIn(email, password);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Email or password is incorrect');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <span className="inline-block rounded bg-ink-900 px-2 py-1 text-xs font-bold uppercase tracking-widest text-white">
            Rentwell
          </span>
          <h1 className="mt-4 text-lg font-semibold text-ink-900">Sign in</h1>
          <p className="mt-1 text-sm text-ink-500">Commercial real estate financial operations</p>
        </div>

        <form onSubmit={submit} className="panel space-y-4 p-5">
          <Field label="Email">
            <input
              type="email"
              className="input"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="username"
              required
              autoFocus
              data-testid="email"
            />
          </Field>

          <Field label="Password">
            <input
              type="password"
              className="input"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              required
              data-testid="password"
            />
          </Field>

          {error && (
            <p
              className="rounded border border-critical-600/30 bg-critical-100 px-3 py-2 text-sm text-critical-800"
              role="alert"
            >
              {error}
            </p>
          )}

          <Button type="submit" variant="primary" busy={busy} testId="sign-in">
            Sign in
          </Button>
        </form>

        <div className="panel mt-4 p-4 text-xs text-ink-600">
          <p className="font-medium text-ink-800">Demonstration accounts</p>
          <p className="mt-1">
            All accounts use the password{' '}
            <code className="rounded bg-ink-100 px-1">rentwell-demo-2026</code>. Every record in
            this instance is synthetic.
          </p>
          <ul className="mt-2 space-y-0.5">
            <li>controller@rentwell.example — closes periods</li>
            <li>accountant@rentwell.example — reconciles, 6 properties only</li>
            <li>manager@rentwell.example — read-only, 2 properties</li>
            <li>auditor@rentwell.example — reads everything, writes nothing</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
