"use client";

import { FormEvent, useEffect, useState } from "react";
import { PageIntro, LoadingState, StatusMessage } from "@/components/Ui";
import Icon from "@/components/Icon";

type CurrentUser = {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  role: string;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
};

export default function ProfilePage() {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    fetch("/api/auth/me", { cache: "no-store" })
      .then(async response => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Could not load your profile.");
        setUser(result.user);
        setDisplayName(result.user.displayName || "");
        setEmail(result.user.email || "");
      })
      .catch(nextError => setError(nextError instanceof Error ? nextError.message : "Could not load your profile."));
  }, []);

  async function saveProfile(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      if (newPassword && newPassword !== confirmPassword) throw new Error("The new passwords do not match.");
      if (user?.mustChangePassword && !newPassword) throw new Error("Change the temporary password before continuing.");
      const response = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName, email, currentPassword, newPassword }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not save your profile.");
      setUser(result.user);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setMessage(result.passwordChanged ? "Profile saved and password changed." : "Profile saved.");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not save your profile.");
    } finally {
      setBusy(false);
    }
  }

  if (!user && !error) return <LoadingState>Loading your account…</LoadingState>;

  return <div className="profile-page">
    <PageIntro
      eyebrow="Your account"
      title="Profile & security"
      description="Keep your identity and sign-in details accurate. Your name is used in planning and purchase-order audit history."
    />

    {user?.mustChangePassword && <StatusMessage type="warning"><strong>Change the temporary password.</strong> The local admin/admin credentials are intended only for first sign-in.</StatusMessage>}
    {error && <StatusMessage type="error">{error}</StatusMessage>}
    {message && <StatusMessage>{message}</StatusMessage>}

    {user && <div className="profile-layout">
      <aside className="panel account-summary">
        <div className="profile-avatar" aria-hidden="true">{initials(user.displayName || user.username)}</div>
        <h2>{user.displayName}</h2>
        <p>@{user.username}</p>
        <span className="role-pill">{roleLabel(user.role)}</span>
        <dl>
          <div><dt>Account status</dt><dd><span className="status-dot"/>Active</dd></div>
          <div><dt>Last sign in</dt><dd>{user.lastLoginAt ? new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(user.lastLoginAt)) : "First session"}</dd></div>
        </dl>
      </aside>

      <form className="panel profile-form" onSubmit={saveProfile}>
        <section>
          <div className="panel-head"><div><h2 className="section-title">Account details</h2><p className="section-description">Used to identify your actions in StyleFlow.</p></div><Icon name="shield"/></div>
          <div className="form-stack profile-fields">
            <label><span className="field-label">Username</span><input className="field" value={user.username} disabled/><small className="field-help">Usernames are managed by an administrator.</small></label>
            <div className="form-grid-2">
              <label><span className="field-label">Display name</span><input className="field" value={displayName} maxLength={100} onChange={event => setDisplayName(event.target.value)} required/></label>
              <label><span className="field-label">Work email</span><input className="field" type="email" value={email} maxLength={254} onChange={event => setEmail(event.target.value)} placeholder="name@company.com"/></label>
            </div>
          </div>
        </section>

        <section className="profile-security-section">
          <div className="panel-head"><div><h2 className="section-title">Change password</h2><p className="section-description">Use at least 10 characters. Leave these fields blank to keep your current password.</p></div></div>
          <div className="form-stack profile-fields">
            <label><span className="field-label">Current password</span><input className="field" type="password" value={currentPassword} autoComplete="current-password" onChange={event => setCurrentPassword(event.target.value)} required={Boolean(newPassword) || user.mustChangePassword}/></label>
            <div className="form-grid-2">
              <label><span className="field-label">New password</span><input className="field" type="password" minLength={10} value={newPassword} autoComplete="new-password" onChange={event => setNewPassword(event.target.value)}/></label>
              <label><span className="field-label">Confirm new password</span><input className="field" type="password" minLength={10} value={confirmPassword} autoComplete="new-password" onChange={event => setConfirmPassword(event.target.value)}/></label>
            </div>
          </div>
        </section>

        <div className="profile-form-footer"><span>Role: {roleLabel(user.role)}</span><button className="btn-primary" type="submit" disabled={busy}>{busy ? "Saving…" : "Save profile"}</button></div>
      </form>
    </div>}
  </div>;
}

function initials(value: string) {
  return value.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join("").toUpperCase() || "U";
}

function roleLabel(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, letter => letter.toUpperCase());
}
