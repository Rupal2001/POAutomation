"use client";

import { FormEvent, useEffect, useState } from "react";
import AdminTabs from "@/components/AdminTabs";
import Icon from "@/components/Icon";
import { LoadingState, PageIntro, StatusMessage } from "@/components/Ui";

type UserRole = "admin" | "planner" | "approver" | "senior_approver" | "receiver" | "viewer";
type ManagedUser = {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  role: UserRole;
  isActive: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  temporaryPassword?: string;
};

type Readiness = "ready" | "attention" | "empty";
type UncertainDelivery = {
  id: string;
  purchaseOrderId: string;
  poNumber: string;
  vendor: string;
  provider: string;
  purchaseOrderStatus: string;
  createdBy: string;
  createdAt: string;
  problem: string;
};
type SystemStatus = {
  generatedAt: string;
  environment: "local" | "deployment";
  database: {
    status: Readiness;
    name: string;
    mode: string;
    responseTimeMs: number;
    serverTime: string | null;
    schemaTables: number;
    requiredSchemaTables: number;
    requiredSchemaReady: boolean;
  };
  planning: {
    status: Readiness;
    connectionName: string;
    explanation: string;
    snapshot: null | {
      id: string;
      label: string | null;
      status: string;
      createdAt: string | null;
      dataAsOf: string | null;
      sourceType: string | null;
      methodologyVersion: string | null;
      salesRows: number;
      inventoryRows: number;
      openPoRows: number;
      styleMasterRows: number;
      loadedAgeHours: number | null;
      dataAgeDays: number | null;
      latestInbound: null | { integration: string; status: string; createdAt: string | null };
    };
  };
  email: {
    status: Readiness;
    provider: "preview" | "resend";
    configured: boolean;
    deliveryEnabled: boolean;
    mode: string;
    safetyOverrideEnabled: boolean;
    explanation: string;
  };
  authentication: {
    status: Readiness;
    sessionSigningReady: boolean;
    totalUsers: number;
    activeUsers: number;
    activeAdmins: number;
    temporaryPasswordUsers: number;
    warnings: string[];
  };
  liveDataNotice: string;
};

const roleDescriptions: Record<UserRole, string> = {
  admin: "Users, controls and all workflows",
  planner: "Data, plans and PO preparation",
  approver: "Standard PO approval decisions",
  senior_approver: "High-value PO approval decisions",
  receiver: "Goods receipt against issued POs",
  viewer: "Read-only planning visibility",
};

const defaultNewUser = { username: "", displayName: "", email: "", role: "viewer" as UserRole, temporaryPassword: "" };

export default function AdminPage() {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [roles, setRoles] = useState<UserRole[]>(Object.keys(roleDescriptions) as UserRole[]);
  const [currentUserId, setCurrentUserId] = useState("");
  const [newUser, setNewUser] = useState(defaultNewUser);
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [uncertainDeliveries, setUncertainDeliveries] = useState<UncertainDelivery[]>([]);
  const [reconciliationNotes, setReconciliationNotes] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [systemBusy, setSystemBusy] = useState(false);
  const [systemError, setSystemError] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function load() {
    const [usersResponse, meResponse, statusResponse, emailResponse] = await Promise.all([
      fetch("/api/admin/users", { cache: "no-store" }),
      fetch("/api/auth/me", { cache: "no-store" }),
      fetch("/api/admin/system-status", { cache: "no-store" }),
      fetch("/api/admin/email-deliveries", { cache: "no-store" }),
    ]);
    const usersResult = await usersResponse.json();
    const meResult = await meResponse.json();
    const statusResult = await statusResponse.json();
    const emailResult = await emailResponse.json();
    if (!usersResponse.ok) throw new Error(usersResult.error || "Could not load users.");
    setUsers(usersResult.users);
    setRoles(usersResult.roles);
    if (meResponse.ok) setCurrentUserId(meResult.user.id);
    if (statusResponse.ok) {
      setSystemStatus(statusResult);
      setSystemError("");
    } else {
      setSystemStatus(null);
      setSystemError(statusResult.error || "System health could not be checked.");
    }
    if (emailResponse.ok) setUncertainDeliveries(emailResult.deliveries ?? []);
  }

  async function refreshSystemStatus() {
    setSystemBusy(true);
    setSystemError("");
    try {
      const response = await fetch("/api/admin/system-status", { cache: "no-store" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "System health could not be checked.");
      setSystemStatus(result);
    } catch (nextError) {
      setSystemError(nextError instanceof Error ? nextError.message : "System health could not be checked.");
    } finally {
      setSystemBusy(false);
    }
  }

  useEffect(() => {
    load().catch(nextError => setError(nextError instanceof Error ? nextError.message : "Could not load users.")).finally(() => setLoading(false));
  }, []);

  async function createUser(event: FormEvent) {
    event.preventDefault();
    setBusy("create");
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/admin/users", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(newUser) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not create the user.");
      setUsers(current => [...current, result.user].sort((a, b) => a.displayName.localeCompare(b.displayName)));
      setNewUser(defaultNewUser);
      setMessage(`${result.user.displayName} can now sign in. Their temporary password must be changed after first use.`);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not create the user.");
    } finally {
      setBusy("");
    }
  }

  function updateDraft(id: string, values: Partial<ManagedUser>) {
    setUsers(current => current.map(user => user.id === id ? { ...user, ...values } : user));
  }

  async function saveUser(user: ManagedUser) {
    setBusy(user.id);
    setError("");
    setMessage("");
    try {
      const response = await fetch(`/api/admin/users/${user.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: user.displayName, email: user.email, role: user.role, isActive: user.isActive, temporaryPassword: user.temporaryPassword }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not update the user.");
      setUsers(current => current.map(row => row.id === user.id ? result.user : row));
      setMessage(`${result.user.displayName}'s access has been updated.`);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not update the user.");
      await load().catch(() => undefined);
    } finally {
      setBusy("");
    }
  }

  async function reconcileEmail(delivery: UncertainDelivery, action: "confirm_sent" | "release_retry") {
    setBusy(`email-${delivery.id}`);
    setError("");
    setMessage("");
    try {
      const response = await fetch(`/api/admin/email-deliveries/${delivery.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, note: reconciliationNotes[delivery.id] || "" }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not reconcile the email delivery.");
      setUncertainDeliveries(current => current.filter(item => item.id !== delivery.id));
      setReconciliationNotes(current => { const next = { ...current }; delete next[delivery.id]; return next; });
      setMessage(result.message);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not reconcile the email delivery.");
    } finally {
      setBusy("");
    }
  }

  if (loading) return <LoadingState>Loading administration controls…</LoadingState>;

  return <div className="admin-page">
    <PageIntro
      eyebrow="Workspace administration"
      title="Control centre"
      description="Check whether the planning workspace is safe to operate, then manage named users and role-based access. Secrets and credentials are never shown here."
      actions={<span className="admin-count"><Icon name="shield"/>{users.filter(user => user.isActive).length} active users</span>}
    />

    <AdminTabs/>

    {error && <StatusMessage type="error">{error}</StatusMessage>}
    {message && <StatusMessage>{message}</StatusMessage>}

    <SystemStatusPanel
      status={systemStatus}
      error={systemError}
      busy={systemBusy}
      onRefresh={refreshSystemStatus}
    />

    {uncertainDeliveries.length > 0 && <section className="panel admin-email-reconciliation">
      <div className="panel-head"><div><h2 className="section-title">Email delivery reconciliation</h2><p className="section-description">These provider requests ended without a trustworthy final response. Never retry until an administrator checks the provider dashboard.</p></div><span className="decision-badge decision-review"><Icon name="alert"/>{uncertainDeliveries.length} blocked</span></div>
      <div className="admin-email-reconciliation-list">
        {uncertainDeliveries.map(delivery => <article key={delivery.id}>
          <div><strong>{delivery.poNumber} · {delivery.vendor}</strong><span>{delivery.problem}</span><small>{dateTime(delivery.createdAt)} · Started by {delivery.createdBy} · PO is {delivery.purchaseOrderStatus.replaceAll("_", " ")}</small></div>
          <label><span className="field-label">Provider evidence checked</span><textarea className="field" maxLength={1000} value={reconciliationNotes[delivery.id] || ""} onChange={event => setReconciliationNotes(current => ({ ...current, [delivery.id]: event.target.value }))} placeholder="Example: Resend dashboard shows no message ID or accepted request; safe to retry."/></label>
          <div><button className="btn-secondary" type="button" disabled={Boolean(busy)} onClick={() => reconcileEmail(delivery, "release_retry")}>Verified not sent · release retry</button><button className="btn-primary" type="button" disabled={Boolean(busy)} onClick={() => reconcileEmail(delivery, "confirm_sent")}>Provider accepted · mark sent</button></div>
        </article>)}
      </div>
    </section>}

    <div className="admin-layout">
      <section className="panel admin-users-panel">
        <div className="panel-head"><div><h2 className="section-title">Workspace users</h2><p className="section-description">Changes to role, password or status invalidate the user&apos;s existing sessions.</p></div></div>
        <div className="admin-user-list">
          {users.map(user => <article className={`admin-user-row ${user.isActive ? "" : "inactive"}`} key={user.id}>
            <div className="admin-user-identity">
              <span>{initials(user.displayName || user.username)}</span>
              <div><strong>{user.displayName}</strong><small>@{user.username}{user.id === currentUserId ? " · You" : ""}</small></div>
              {user.mustChangePassword && <em>Temporary password</em>}
            </div>
            <div className="admin-user-fields">
              <label><span className="field-label">Display name</span><input className="field" value={user.displayName} maxLength={100} onChange={event => updateDraft(user.id, { displayName: event.target.value })}/></label>
              <label><span className="field-label">Work email</span><input className="field" type="email" value={user.email || ""} placeholder="Optional" onChange={event => updateDraft(user.id, { email: event.target.value })}/></label>
              <label><span className="field-label">Role</span><select className="field" value={user.role} disabled={user.id === currentUserId} onChange={event => updateDraft(user.id, { role: event.target.value as UserRole })}>{roles.map(role => <option value={role} key={role}>{roleLabel(role)}</option>)}</select></label>
            </div>
            <div className="admin-user-controls">
              <label className="admin-active-toggle"><input type="checkbox" checked={user.isActive} disabled={user.id === currentUserId} onChange={event => updateDraft(user.id, { isActive: event.target.checked })}/><span><strong>{user.isActive ? "Active" : "Suspended"}</strong><small>{user.isActive ? "Can sign in" : "Access blocked"}</small></span></label>
              <details>
                <summary>Set temporary password</summary>
                <label><span className="field-label">Temporary password</span><input className="field" type="password" minLength={10} autoComplete="new-password" value={user.temporaryPassword || ""} placeholder="10+ characters" onChange={event => updateDraft(user.id, { temporaryPassword: event.target.value })}/><small className="field-help">The user must change it at next sign-in.</small></label>
              </details>
              <button className="btn-secondary" type="button" disabled={Boolean(busy)} onClick={() => saveUser(user)}>{busy === user.id ? "Saving…" : "Save access"}</button>
            </div>
          </article>)}
        </div>
      </section>

      <aside className="admin-side-stack">
        <form className="panel admin-create-user" onSubmit={createUser}>
          <div className="panel-head"><div><h2 className="section-title">Add a user</h2><p className="section-description">Create a named account with a temporary password.</p></div><Icon name="plus"/></div>
          <div className="form-stack">
            <label><span className="field-label">Username</span><input className="field" pattern="[a-zA-Z0-9._-]{3,40}" value={newUser.username} onChange={event => setNewUser({ ...newUser, username: event.target.value })} placeholder="e.g. priya.shah" required/></label>
            <label><span className="field-label">Display name</span><input className="field" value={newUser.displayName} maxLength={100} onChange={event => setNewUser({ ...newUser, displayName: event.target.value })} placeholder="Priya Shah" required/></label>
            <label><span className="field-label">Work email</span><input className="field" type="email" value={newUser.email} onChange={event => setNewUser({ ...newUser, email: event.target.value })} placeholder="Optional"/></label>
            <label><span className="field-label">Role</span><select className="field" value={newUser.role} onChange={event => setNewUser({ ...newUser, role: event.target.value as UserRole })}>{roles.map(role => <option value={role} key={role}>{roleLabel(role)}</option>)}</select><small className="field-help">{roleDescriptions[newUser.role]}</small></label>
            <label><span className="field-label">Temporary password</span><input className="field" type="password" minLength={10} maxLength={200} autoComplete="new-password" value={newUser.temporaryPassword} onChange={event => setNewUser({ ...newUser, temporaryPassword: event.target.value })} placeholder="10+ characters" required/></label>
            <button className="btn-primary" disabled={Boolean(busy)} type="submit">{busy === "create" ? "Creating user…" : "Create user"}</button>
          </div>
        </form>

        <section className="panel role-guide">
          <div className="panel-head"><div><h2 className="section-title">Role guide</h2><p className="section-description">Access is checked again on every protected API action.</p></div></div>
          <dl>{roles.map(role => <div key={role}><dt>{roleLabel(role)}</dt><dd>{roleDescriptions[role]}</dd></div>)}</dl>
        </section>
      </aside>
    </div>
  </div>;
}

function initials(value: string) {
  return value.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join("").toUpperCase() || "U";
}

function roleLabel(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, letter => letter.toUpperCase());
}

function SystemStatusPanel({ status, error, busy, onRefresh }: {
  status: SystemStatus | null;
  error: string;
  busy: boolean;
  onRefresh: () => void;
}) {
  return <section className="panel admin-system-panel">
    <div className="panel-head admin-system-head">
      <div>
        <h2 className="section-title">System readiness</h2>
        <p className="section-description">A safe, read-only view of database, source data, email and sign-in readiness.</p>
      </div>
      <button className="btn-secondary" type="button" disabled={busy} onClick={onRefresh}>
        <Icon name="refresh"/>{busy ? "Checking…" : "Refresh checks"}
      </button>
    </div>

    {error && <div className="admin-system-error"><Icon name="alert"/><div><strong>Health check unavailable</strong><span>{error}</span></div></div>}
    {!status && !error && <div className="admin-system-loading"><span className="loading-spinner"/><span>Checking operational readiness…</span></div>}
    {status && <>
      <div className="admin-system-grid">
        <SystemCard
          icon="database"
          title="PostgreSQL"
          status={status.database.status}
          value={status.database.requiredSchemaReady ? "Connected" : "Schema attention"}
          description={`${status.database.mode} · ${status.database.responseTimeMs} ms check`}
        >
          <dl>
            <div><dt>Schema</dt><dd>{status.database.schemaTables} public tables · {status.database.requiredSchemaTables} required</dd></div>
            <div><dt>Checked</dt><dd>{dateTime(status.generatedAt)}</dd></div>
          </dl>
        </SystemCard>

        <SystemCard
          icon="automation"
          title="Planning snapshot"
          status={status.planning.status}
          value={status.planning.snapshot ? freshnessTitle(status.planning.snapshot.dataAgeDays) : "No source yet"}
          description={status.planning.explanation}
        >
          {status.planning.snapshot ? <dl>
            <div><dt>Sell-out</dt><dd>{number(status.planning.snapshot.salesRows)} rows</dd></div>
            <div><dt>Inventory</dt><dd>{number(status.planning.snapshot.inventoryRows)} rows</dd></div>
            <div><dt>Open PO</dt><dd>{number(status.planning.snapshot.openPoRows)} rows</dd></div>
            <div><dt>Style master</dt><dd>{number(status.planning.snapshot.styleMasterRows)} rows</dd></div>
          </dl> : <p className="admin-system-next-step">Start with New plan → upload the bulk workbook or all four separate sources.</p>}
        </SystemCard>

        <SystemCard
          icon="purchaseOrder"
          title="PO email"
          status={status.email.status}
          value={status.email.deliveryEnabled ? "Delivery enabled" : status.email.provider === "preview" ? "Preview only" : "Setup needed"}
          description={status.email.explanation}
        >
          <dl>
            <div><dt>Provider</dt><dd>{status.email.provider === "resend" ? "Resend" : "Local preview"}</dd></div>
            <div><dt>Test redirect</dt><dd>{status.email.safetyOverrideEnabled ? "Enabled" : "Off"}</dd></div>
          </dl>
        </SystemCard>

        <SystemCard
          icon="shield"
          title="Authentication"
          status={status.authentication.status}
          value={status.authentication.status === "ready" ? "Protected" : "Action required"}
          description={`${status.authentication.activeAdmins} active admin · ${status.authentication.activeUsers} active users`}
        >
          {status.authentication.warnings.length ? <ul className="admin-system-warnings">{status.authentication.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul> : <p className="admin-system-ok"><Icon name="check"/> Signed sessions and administrator coverage are ready.</p>}
        </SystemCard>
      </div>
      <div className="admin-live-semantics"><Icon name="info"/><div><strong>What “connected data” means today</strong><span>{status.liveDataNotice}</span></div><em>{status.environment === "local" ? "Local workspace" : "Deployed workspace"}</em></div>
    </>}
  </section>;
}

function SystemCard({ icon, title, status, value, description, children }: {
  icon: "database" | "automation" | "purchaseOrder" | "shield";
  title: string;
  status: Readiness;
  value: string;
  description: string;
  children: React.ReactNode;
}) {
  return <article className={`admin-system-card system-${status}`}>
    <div className="admin-system-card-head"><span><Icon name={icon}/></span><em>{readinessLabel(status)}</em></div>
    <h3>{title}</h3>
    <strong className="admin-system-value">{value}</strong>
    <p>{description}</p>
    {children}
  </article>;
}

function readinessLabel(status: Readiness) {
  return status === "ready" ? "Ready" : status === "empty" ? "Not started" : "Check";
}

function freshnessTitle(age: number | null) {
  if (age === null) return "Date unavailable";
  if (age < 0) return "Future data date";
  if (age === 0) return "Current today";
  if (age === 1) return "1 day old";
  return `${age} days old`;
}

function number(value: number) {
  return new Intl.NumberFormat("en-IN").format(value);
}

function dateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unavailable" : new Intl.DateTimeFormat("en-IN", {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
  }).format(date);
}
