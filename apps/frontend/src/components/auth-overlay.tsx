import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';

import { useAuthStore } from '../stores/auth-store';

export function AuthOverlay() {
  const { status, isSubmitting, error, disclaimer } = useAuthStore((state) => ({
    status: state.status,
    isSubmitting: state.isSubmitting,
    error: state.error,
    disclaimer: state.disclaimer,
  }));
  const login = useAuthStore((state) => state.login);
  const acceptLegal = useAuthStore((state) => state.acceptLegal);
  const clearError = useAuthStore((state) => state.clearError);

  const [email, setEmail] = useState('admin@example.com');
  const [password, setPassword] = useState('admin');
  const [ackChecked, setAckChecked] = useState(false);
  const [hasScrolled, setHasScrolled] = useState(false);

  const scrollRef = useRef<HTMLDivElement | null>(null);

  const overlayVisible = status !== 'authenticated';
  const showLegalStep = status === 'legal';
  useEffect(() => {
    if (showLegalStep) {
      setHasScrolled(false);
      setAckChecked(false);
      if (scrollRef.current) {
        scrollRef.current.scrollTop = 0;
      }
    }
  }, [showLegalStep]);

  const handleLogin = (event: FormEvent) => {
    event.preventDefault();
    clearError();
    void login(email, password);
  };

  const handleAccept = (event: FormEvent) => {
    event.preventDefault();
    clearError();
    void acceptLegal();
  };

  const legalReady = useMemo(() => hasScrolled && ackChecked, [hasScrolled, ackChecked]);

  if (!overlayVisible) {
    return null;
  }

  return (
    <div className="auth-overlay" role="dialog" aria-modal="true">
      <div className="auth-overlay__panel">
        <header className="auth-overlay__header">
          <img
            className="auth-overlay__logo-mark"
            src="/logo111.png"
            alt="AntiHunter Shield Logo"
          />
          <h1 className="auth-overlay__brand-title">AntiHunter Command & Control Pro</h1>
        </header>

        {error ? <div className="auth-overlay__error">{error}</div> : null}

        {status === 'checking' ? (
          <div className="auth-overlay__loading">Validating session…</div>
        ) : showLegalStep ? (
          <form onSubmit={handleAccept} className="auth-overlay__form">
            <div
              className="auth-overlay__disclaimer"
              ref={scrollRef}
              onScroll={(event) => {
                const target = event.currentTarget;
                if (target.scrollTop + target.clientHeight >= target.scrollHeight - 8) {
                  setHasScrolled(true);
                }
              }}
            >
              <pre>{disclaimer}</pre>
            </div>
            <label className="auth-overlay__checkbox">
              <input
                type="checkbox"
                checked={ackChecked}
                onChange={(event) => setAckChecked(event.target.checked)}
              />
              <span>I have read and accept the legal agreement above.</span>
            </label>
            <button type="submit" className="submit-button" disabled={!legalReady || isSubmitting}>
              {isSubmitting ? 'Saving…' : 'Accept and Continue'}
            </button>
          </form>
        ) : (
          <form onSubmit={handleLogin} className="auth-overlay__form">
            <label>
              <span>Email</span>
              <input
                type="email"
                value={email}
                autoComplete="username"
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
            <label>
              <span>Password</span>
              <input
                type="password"
                value={password}
                autoComplete="current-password"
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            <button type="submit" className="submit-button" disabled={isSubmitting}>
              {isSubmitting ? 'Signing in…' : 'Sign In'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
