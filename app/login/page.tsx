"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await response.json().catch(() => ({})) as { error?: string; user?: { mustChangePassword?: boolean } };
      if (!response.ok) throw new Error(data.error || "Sign-in failed. Please try again.");

      const requestedNext = new URLSearchParams(window.location.search).get("next");
      const safeNext = requestedNext?.startsWith("/") && !requestedNext.startsWith("//")
        ? requestedNext
        : "/dashboard";
      router.replace(data.user?.mustChangePassword ? "/profile?password=required" : safeNext);
      router.refresh();
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "Sign-in failed. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-shell">
      <div className="login-orb login-orb-one" aria-hidden="true" />
      <div className="login-orb login-orb-two" aria-hidden="true" />

      <div className="login-card">
        <section className="login-context" aria-labelledby="login-product-name">
          <div className="login-brand">
            <span className="login-brand-mark" aria-hidden="true"><img src="/brand/myntra-mark.png" alt=""/></span>
            <span>
              <strong id="login-product-name">StyleFlow</strong>
              <small>Myntra buying operations</small>
            </span>
          </div>

          <div className="login-context-copy">
            <p className="login-kicker">One planning workspace</p>
            <h2>Turn demand signals into controlled purchase orders.</h2>
            <p>Review forecasts, replenish the right styles, and follow every order from draft to delivery.</p>
          </div>

          <ul className="login-benefits">
            <li><span aria-hidden="true">01</span><div><strong>Decision-ready forecasts</strong><small>Risk, accuracy and demand context in one view</small></div></li>
            <li><span aria-hidden="true">02</span><div><strong>Rupee-first planning</strong><small>Investment, cost and PO value shown in INR</small></div></li>
            <li><span aria-hidden="true">03</span><div><strong>Traceable PO workflow</strong><small>Approval, issue and receipt history stays visible</small></div></li>
          </ul>

          <p className="login-demo-note">Public catalogue snapshot · Synthetic operations</p>
        </section>

        <section className="login-form-panel" aria-labelledby="login-title">
          <div className="login-form-heading">
            <p className="eyebrow">Protected workspace</p>
            <h1 id="login-title">Welcome back</h1>
            <p>Sign in with your StyleFlow account to continue to supply planning.</p>
          </div>

          <form className="login-form" onSubmit={submit} aria-busy={busy}>
            <label htmlFor="workspace-username" className="field-label">Username</label>
            <input
              id="workspace-username"
              className="field login-username"
              value={username}
              onChange={event => {
                setUsername(event.target.value);
                if (error) setError("");
              }}
              autoFocus
              autoComplete="username"
              required
              spellCheck={false}
            />
            <label htmlFor="workspace-password" className="field-label">Workspace password</label>
            <div className="login-password-control">
              <input
                id="workspace-password"
                className="field"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={event => {
                  setPassword(event.target.value);
                  if (error) setError("");
                }}
                autoComplete="current-password"
                aria-describedby={`login-password-help${error ? " login-error" : ""}`}
                aria-invalid={Boolean(error)}
                required
                spellCheck={false}
              />
              <button
                type="button"
                className="password-visibility"
                aria-controls="workspace-password"
                aria-pressed={showPassword}
                onClick={() => setShowPassword(value => !value)}
              >
                {showPassword ? "Hide" : "Show"}
              </button>
            </div>
            <p id="login-password-help" className="login-field-help">New local installs start with <strong>admin / admin</strong> and ask you to change it after signing in.</p>

            {error && <div id="login-error" className="login-error" role="alert" aria-live="assertive">
              <span aria-hidden="true">!</span>
              <p><strong>We could not sign you in.</strong>{error}</p>
            </div>}

            <button className="btn-primary btn-large login-submit" type="submit" disabled={busy}>
              {busy ? <><span className="login-button-spinner" aria-hidden="true" />Signing in…</> : "Continue to workspace"}
            </button>
          </form>

          <p className="login-privacy">Your password is verified securely by this app and is never stored as readable text.</p>
        </section>
      </div>
    </div>
  );
}
