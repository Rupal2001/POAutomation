"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import AdminTabs from "@/components/AdminTabs";
import Icon from "@/components/Icon";
import { InfoNote, LoadingState, PageIntro, StatusMessage } from "@/components/Ui";

type AccessEffect = "inherit" | "allow" | "deny";
type AccessArea = {
  key: string;
  label: string;
  description: string;
  href: string;
  group: string;
  lockedForAdmin: boolean;
};
type AccessRole = { key: string; label: string };
type AccessUser = {
  id: string;
  username: string;
  displayName: string;
  role: string;
  isActive: boolean;
};
type AccessConfig = {
  revision: number;
  areas: AccessArea[];
  roles: AccessRole[];
  users: AccessUser[];
  roleAccess: Record<string, Record<string, boolean>>;
  userOverrides: Record<string, Record<string, AccessEffect>>;
};

const emptyConfig: AccessConfig = { revision: 0, areas: [], roles: [], users: [], roleAccess: {}, userOverrides: {} };

export default function AccessControlPage() {
  const [saved, setSaved] = useState<AccessConfig>(emptyConfig);
  const [draft, setDraft] = useState<AccessConfig>(emptyConfig);
  const [selectedUserId, setSelectedUserId] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [changeReason, setChangeReason] = useState("");
  const [userQuery, setUserQuery] = useState("");
  const accessModalRef = useRef<HTMLElement>(null);
  const accessModalCloseRef = useRef<HTMLButtonElement>(null);
  const manageAccessTriggerRef = useRef<HTMLButtonElement | null>(null);

  const dirty = useMemo(() => serialiseAccess(draft) !== serialiseAccess(saved), [draft, saved]);
  const selectedUser = draft.users.find(user => user.id === selectedUserId) ?? null;
  const activeUserCount = draft.users.filter(user => user.isActive).length;
  const filteredUsers = useMemo(() => {
    const query = userQuery.trim().toLocaleLowerCase("en-IN");
    if (!query) return draft.users;
    return draft.users.filter(user => [user.username, user.displayName, roleLabel(user.role)].some(value => value.toLocaleLowerCase("en-IN").includes(query)));
  }, [draft.users, userQuery]);

  async function load({ announce = false }: { announce?: boolean } = {}) {
    setError("");
    const response = await fetch("/api/admin/access-control", { cache: "no-store" });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Access settings could not be loaded.");
    const next = normaliseAccessResponse(result);
    setSaved(next);
    setDraft(cloneConfig(next));
    setSelectedUserId(current => next.users.some(user => user.id === current) ? current : "");
    if (announce) setMessage("Unsaved changes were discarded. The latest access settings are shown.");
  }

  useEffect(() => {
    load().catch(nextError => setError(errorMessage(nextError, "Access settings could not be loaded."))).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!selectedUserId) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.requestAnimationFrame(() => accessModalCloseRef.current?.focus());

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setSelectedUserId("");
        return;
      }
      if (event.key !== "Tab" || !accessModalRef.current) return;
      const focusable = [...accessModalRef.current.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
      window.requestAnimationFrame(() => manageAccessTriggerRef.current?.focus());
    };
  }, [selectedUserId]);

  function setRoleArea(role: string, area: string, allowed: boolean) {
    setMessage("");
    setDraft(current => ({
      ...current,
      roleAccess: {
        ...current.roleAccess,
        [role]: { ...(current.roleAccess[role] ?? {}), [area]: allowed },
      },
    }));
  }

  function setUserArea(userId: string, area: string, effect: AccessEffect) {
    setMessage("");
    setDraft(current => ({
      ...current,
      userOverrides: {
        ...current.userOverrides,
        [userId]: { ...(current.userOverrides[userId] ?? {}), [area]: effect },
      },
    }));
  }

  function resetUserToRole(userId: string) {
    setMessage("");
    setDraft(current => ({
      ...current,
      userOverrides: {
        ...current.userOverrides,
        [userId]: Object.fromEntries(current.areas.map(area => [area.key, "inherit" as const])),
      },
    }));
  }

  async function save(): Promise<boolean> {
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/admin/access-control", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedRevision: saved.revision,
          roleAccess: roleAccessChanges(saved, draft),
          userOverrides: userOverrideChanges(saved, draft),
          reason: changeReason.trim() || undefined,
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Access settings could not be saved.");
      const next = result.areas || result.config || result.roleAccess
        ? normaliseAccessResponse(result, draft)
        : cloneConfig(draft);
      setSaved(next);
      setDraft(cloneConfig(next));
      setChangeReason("");
      setMessage(result.message || "Access settings saved. New page access applies immediately.");
      return true;
    } catch (nextError) {
      setError(errorMessage(nextError, "Access settings could not be saved."));
      return false;
    } finally {
      setSaving(false);
    }
  }

  function openUserAccess(userId: string, trigger: HTMLButtonElement) {
    manageAccessTriggerRef.current = trigger;
    setError("");
    setMessage("");
    setSelectedUserId(userId);
  }

  function closeUserAccess() {
    setSelectedUserId("");
  }

  if (loading) return <LoadingState>Loading page access…</LoadingState>;

  return <div className="admin-page access-control-page">
    <PageIntro
      eyebrow="Workspace administration / Access control"
      title="Choose who can see each page"
      description="Find a username and click Manage access to control the pages that person can open. Changes affect both navigation and direct page access."
      actions={<span className="admin-count"><Icon name="shield"/>{activeUserCount} active user{activeUserCount === 1 ? "" : "s"}</span>}
    />

    <AdminTabs/>

    {error && <StatusMessage type="error">{error}</StatusMessage>}
    {message && <StatusMessage>{message}</StatusMessage>}

    {!draft.areas.length || !draft.roles.length ? <section className="panel access-empty">
      <span><Icon name="shield"/></span>
      <div><h2>No access catalogue is available</h2><p>Reload after the administrator finishes configuring application areas.</p></div>
      <button className="btn-secondary" type="button" onClick={() => { setLoading(true); load().catch(nextError => setError(errorMessage(nextError, "Access settings could not be loaded."))).finally(() => setLoading(false)); }}><Icon name="refresh"/>Reload</button>
    </section> : <>
      <InfoNote title="How access is decided" tone="neutral">
        Click <strong>Manage access</strong> beside a username. The matrix starts with that person&apos;s role defaults; a personal <strong>Allow</strong> or <strong>Deny</strong> takes priority, and <strong>Use role default</strong> removes the exception.
      </InfoNote>

      <section className="panel access-user-panel access-user-directory-panel" aria-labelledby="user-access-heading">
        <div className="panel-head access-panel-head">
          <div><p className="step-kicker">1 · Users</p><h2 id="user-access-heading" className="section-title">Users and access</h2><p className="section-description">Choose a person, then open only that user&apos;s page permissions.</p></div>
          <span className="access-change-state" data-dirty={dirty ? "true" : "false"}><span aria-hidden="true"/>{dirty ? "Unsaved changes" : "All changes saved"}</span>
        </div>
        <div className="access-directory-toolbar">
          <label className="access-directory-search">
            <span className="sr-only">Search users</span>
            <Icon name="search"/>
            <input className="field" value={userQuery} onChange={event => setUserQuery(event.target.value)} placeholder="Search username, name or role…"/>
          </label>
          <span>{filteredUsers.length} of {draft.users.length} user{draft.users.length === 1 ? "" : "s"}</span>
        </div>
        {filteredUsers.length ? <div className="access-user-directory" role="list">
          {filteredUsers.map(user => {
            const effectiveCount = draft.areas.filter(area => {
              const effect = draft.userOverrides[user.id]?.[area.key] ?? "inherit";
              return effect === "allow" || (effect === "inherit" && Boolean(draft.roleAccess[user.role]?.[area.key]));
            }).length;
            const overrideCount = draft.areas.filter(area => (draft.userOverrides[user.id]?.[area.key] ?? "inherit") !== "inherit").length;
            return <article key={user.id} className="access-user-row" role="listitem">
              <div className="access-user-identity"><span>{initials(user.displayName || user.username)}</span><div><strong>{user.displayName}</strong><small>@{user.username}</small></div></div>
              <div className="access-user-role"><small>Role</small><strong>{roleLabel(user.role)}</strong><span data-active={user.isActive ? "true" : "false"}>{user.isActive ? "Active" : "Suspended"}</span></div>
              <div className="access-user-count"><small>Effective page access</small><strong>{effectiveCount} of {draft.areas.length} pages</strong><span>{overrideCount ? `${overrideCount} personal exception${overrideCount === 1 ? "" : "s"}` : "Uses role defaults"}</span></div>
              <button className="btn-secondary access-manage-button" type="button" onClick={event => openUserAccess(user.id, event.currentTarget)}><Icon name="shield"/>Manage access<Icon name="chevronRight"/></button>
            </article>;
          })}
        </div> : <div className="access-no-users"><Icon name="info"/><span>{draft.users.length ? "No users match this search." : "Create a workspace user before assigning page access."}</span></div>}
      </section>

      <details className="panel access-role-panel access-role-disclosure">
        <summary>
          <span><Icon name="shield"/></span>
          <span><small>2 · Role defaults</small><strong>Set normal page access by role</strong><em>Use this only when everyone in a role should change.</em></span>
          <Icon name="chevronRight"/>
        </summary>
        <div className="access-matrix-scroll" tabIndex={0} aria-label="Role access matrix; scroll horizontally to see every role">
          <table className="access-matrix">
            <caption>Default page access for each workspace role</caption>
            <thead><tr><th scope="col">Application page</th>{draft.roles.map(role => <th scope="col" key={role.key}>{role.label}</th>)}</tr></thead>
            <tbody>{draft.areas.map((area, index) => {
              const showGroup = index === 0 || draft.areas[index - 1]?.group !== area.group;
              return <tr key={area.key} className={showGroup ? "group-start" : ""}>
                <th scope="row"><span>{showGroup ? area.group : ""}</span><strong>{area.label}</strong><small>{area.description}</small><code>{area.href}</code></th>
                {draft.roles.map(role => {
                  const allowed = Boolean(draft.roleAccess[role.key]?.[area.key]);
                  const locked = area.lockedForAdmin;
                  if (locked) return <td key={role.key}><span className={`access-toggle locked ${role.key === "admin" ? "allowed" : "denied"}`} aria-label={role.key === "admin" ? `${area.label} is always available to administrators` : `${area.label} is reserved for administrators`}><Icon name="shield"/><span>{role.key === "admin" ? "Always on" : "Admin only"}</span></span></td>;
                  return <td key={role.key}><button type="button" className={`access-toggle ${allowed ? "allowed" : "denied"}`} aria-pressed={allowed} aria-label={`${allowed ? "Remove" : "Allow"} ${role.label} access to ${area.label}`} onClick={() => setRoleArea(role.key, area.key, !allowed)}><Icon name={allowed ? "check" : "close"}/><span>{allowed ? "Allowed" : "No access"}</span></button></td>;
                })}
              </tr>;
            })}</tbody>
          </table>
        </div>
      </details>
    </>}

    {selectedUser && <div className="modal-backdrop access-user-modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) closeUserAccess(); }}>
      <section ref={accessModalRef} className="modal-card modal-wide access-user-modal" role="dialog" aria-modal="true" aria-labelledby="user-access-modal-title">
        <div className="modal-head access-user-modal-head">
          <div className="access-user-summary"><span>{initials(selectedUser.displayName || selectedUser.username)}</span><div><p className="eyebrow">User access matrix</p><h2 id="user-access-modal-title">{selectedUser.displayName}</h2><small>@{selectedUser.username} · {roleLabel(selectedUser.role)}{selectedUser.isActive ? "" : " · Suspended"}</small></div></div>
          <button ref={accessModalCloseRef} className="icon-button" type="button" onClick={closeUserAccess} aria-label="Close user access matrix"><Icon name="close"/></button>
        </div>
        <div className="modal-body access-user-modal-body">
          <div className="access-modal-guidance"><Icon name="info"/><p><strong>Role default is the starting point.</strong> Use Allow or Deny only when {selectedUser.displayName} should differ from the {roleLabel(selectedUser.role)} role.</p><button className="btn-secondary" type="button" onClick={() => resetUserToRole(selectedUser.id)}><Icon name="refresh"/>Reset all to role default</button></div>
          <div className="access-override-list">
            {draft.areas.map(area => {
              const effect = draft.userOverrides[selectedUser.id]?.[area.key] ?? "inherit";
              const roleAllows = Boolean(draft.roleAccess[selectedUser.role]?.[area.key]);
              const effective = effect === "allow" || (effect === "inherit" && roleAllows);
              const locked = area.lockedForAdmin;
              return <article key={area.key}>
                <div className="access-area-copy"><strong>{area.label}</strong><span>{area.description}</span><small>{area.group} · {area.href}</small></div>
                <div className="access-effective" data-allowed={effective ? "true" : "false"}><span aria-hidden="true"><Icon name={effective ? "check" : "close"}/></span><div><small>Effective access</small><strong>{effective ? "Can open" : "Cannot open"}</strong></div></div>
                {locked ? <div className="access-locked-note"><Icon name="shield"/><span><strong>{selectedUser.role === "admin" ? "Always available" : "Administrator only"}</strong><small>{selectedUser.role === "admin" ? "Administrators keep access to access controls." : "Assign the Administrator role to manage access controls."}</small></span></div> : <div className="access-effect-control" role="group" aria-label={`${area.label} access for ${selectedUser.displayName}`}>
                  <button type="button" className={effect === "inherit" ? "active" : ""} aria-pressed={effect === "inherit"} onClick={() => setUserArea(selectedUser.id, area.key, "inherit")}><span>Use role default</span><small>{roleAllows ? "Allowed" : "No access"}</small></button>
                  <button type="button" className={effect === "allow" ? "active allow" : ""} aria-pressed={effect === "allow"} onClick={() => setUserArea(selectedUser.id, area.key, "allow")}><span>Allow</span><small>Personal exception</small></button>
                  <button type="button" className={effect === "deny" ? "active deny" : ""} aria-pressed={effect === "deny"} onClick={() => setUserArea(selectedUser.id, area.key, "deny")}><span>Deny</span><small>Personal exception</small></button>
                </div>}
              </article>;
            })}
          </div>
        </div>
        <div className="modal-footer access-user-modal-footer">
          <label><span>Change note <small>optional</small></span><input className="field" value={changeReason} maxLength={500} onChange={event => setChangeReason(event.target.value)} placeholder="Why is this access changing?"/></label>
          <div><button className="btn-secondary" type="button" onClick={closeUserAccess} disabled={saving}>Close</button><button className="btn-primary" type="button" onClick={async () => { if (await save()) closeUserAccess(); }} disabled={saving || !dirty}><Icon name={saving ? "refresh" : "check"}/>{saving ? "Saving…" : dirty ? "Save access" : "No changes"}</button></div>
        </div>
      </section>
    </div>}

    {dirty && <div className="access-save-bar" role="region" aria-label="Unsaved access changes">
      <div><strong>Access changes are ready to save</strong><span>They will apply to the affected users as soon as you save.</span></div>
      <label><span className="sr-only">Reason for access changes</span><input className="field" value={changeReason} maxLength={500} onChange={event => setChangeReason(event.target.value)} placeholder="Change note (optional)"/></label>
      <div><button className="btn-secondary" type="button" onClick={() => load({ announce: true }).catch(nextError => setError(errorMessage(nextError, "Access settings could not be reloaded.")))} disabled={saving}>Discard changes</button><button className="btn-primary" type="button" onClick={save} disabled={saving}><Icon name={saving ? "refresh" : "check"}/>{saving ? "Saving…" : "Save access"}</button></div>
    </div>}
  </div>;
}

function normaliseAccessResponse(input: unknown, fallback: AccessConfig = emptyConfig): AccessConfig {
  const root = asRecord(input);
  const source = asRecord(root.config ?? root.accessControl ?? root);
  const areasRaw = Array.isArray(source.areas) ? source.areas : fallback.areas;
  const rolesRaw = Array.isArray(source.roles) ? source.roles : fallback.roles;
  const usersRaw = Array.isArray(source.users) ? source.users : fallback.users;
  const areas = areasRaw.map((item, index) => {
    const row = asRecord(item);
    const key = textValue(row.key ?? row.id ?? row.area ?? row.slug, `area_${index + 1}`);
    return {
      key,
      label: textValue(row.label ?? row.name ?? row.title, humanise(key)),
      description: textValue(row.description ?? row.helpText, "Control whether this page appears and can be opened."),
      href: textValue(row.href ?? row.path ?? row.route, "/"),
      group: textValue(row.group ?? row.section, "Workspace"),
      lockedForAdmin: row.lockedForAdmin === true,
    };
  });
  const roles = rolesRaw.map((item, index) => {
    if (typeof item === "string") return { key: item, label: roleLabel(item) };
    const row = asRecord(item);
    const key = textValue(row.key ?? row.id ?? row.role, `role_${index + 1}`);
    return { key, label: textValue(row.label ?? row.name, roleLabel(key)) };
  });
  const users = usersRaw.map((item, index) => {
    const row = asRecord(item);
    return {
      id: textValue(row.id ?? row.userId, `user_${index + 1}`),
      username: textValue(row.username, "user"),
      displayName: textValue(row.displayName ?? row.name, textValue(row.username, "User")),
      role: textValue(row.role, "viewer"),
      isActive: row.isActive !== false && row.active !== false,
    };
  });

  const roleAccess = initialiseRoleAccess(roles, areas, fallback.roleAccess);
  applyRoleAccess(roleAccess, source.roleAccess ?? source.roleDefaults, roles, areas);
  const userOverrides = initialiseUserOverrides(users, areas, fallback.userOverrides);
  applyUserOverrides(userOverrides, source.userOverrides ?? source.overrides, users, areas);
  return { revision: Number(source.revision ?? root.revision ?? fallback.revision) || 0, areas, roles, users, roleAccess, userOverrides };
}

function initialiseRoleAccess(roles: AccessRole[], areas: AccessArea[], fallback: AccessConfig["roleAccess"]) {
  return Object.fromEntries(roles.map(role => [role.key, Object.fromEntries(areas.map(area => [area.key, Boolean(fallback[role.key]?.[area.key])]))]));
}

function initialiseUserOverrides(users: AccessUser[], areas: AccessArea[], fallback: AccessConfig["userOverrides"]) {
  return Object.fromEntries(users.map(user => [user.id, Object.fromEntries(areas.map(area => [area.key, normaliseEffect(fallback[user.id]?.[area.key])]))]));
}

function applyRoleAccess(target: AccessConfig["roleAccess"], input: unknown, roles: AccessRole[], areas: AccessArea[]) {
  if (Array.isArray(input)) {
    input.forEach(item => {
      const row = asRecord(item);
      const role = textValue(row.role ?? row.roleKey, "");
      const area = textValue(row.area ?? row.areaKey ?? row.page, "");
      if (target[role] && area in target[role]) target[role][area] = Boolean(row.allowed ?? row.canAccess ?? row.value);
    });
    return;
  }
  const record = asRecord(input);
  roles.forEach(role => {
    const values = asRecord(record[role.key]);
    areas.forEach(area => { if (area.key in values) target[role.key][area.key] = Boolean(values[area.key]); });
  });
}

function applyUserOverrides(target: AccessConfig["userOverrides"], input: unknown, users: AccessUser[], areas: AccessArea[]) {
  if (Array.isArray(input)) {
    input.forEach(item => {
      const row = asRecord(item);
      const user = textValue(row.userId ?? row.user, "");
      const area = textValue(row.area ?? row.areaKey ?? row.page, "");
      if (target[user] && area in target[user]) target[user][area] = normaliseEffect(row.effect ?? row.access ?? row.value);
    });
    return;
  }
  const record = asRecord(input);
  users.forEach(user => {
    const values = asRecord(record[user.id]);
    areas.forEach(area => { if (area.key in values) target[user.id][area.key] = normaliseEffect(values[area.key]); });
  });
}

function roleAccessChanges(saved: AccessConfig, draft: AccessConfig) {
  return draft.roles.flatMap(role => draft.areas.flatMap(area => {
    const before = Boolean(saved.roleAccess[role.key]?.[area.key]);
    const allowed = Boolean(draft.roleAccess[role.key]?.[area.key]);
    return before === allowed ? [] : [{ role: role.key, areaKey: area.key, allowed }];
  }));
}

function userOverrideChanges(saved: AccessConfig, draft: AccessConfig) {
  return draft.users.flatMap(user => draft.areas.flatMap(area => {
    const before = saved.userOverrides[user.id]?.[area.key] ?? "inherit";
    const effect = draft.userOverrides[user.id]?.[area.key] ?? "inherit";
    return before === effect ? [] : [{ userId: user.id, areaKey: area.key, effect }];
  }));
}

function cloneConfig(value: AccessConfig): AccessConfig {
  return JSON.parse(JSON.stringify(value)) as AccessConfig;
}

function serialiseAccess(value: AccessConfig) {
  return JSON.stringify({ roleAccess: value.roleAccess, userOverrides: value.userOverrides });
}

function normaliseEffect(value: unknown): AccessEffect {
  if (value === true || value === "allow" || value === "allowed") return "allow";
  if (value === false || value === "deny" || value === "denied") return "deny";
  return "inherit";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function textValue(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function humanise(value: string) {
  return value.replaceAll("_", " ").replaceAll("-", " ").replace(/\b\w/g, letter => letter.toUpperCase());
}

function roleLabel(value: string) {
  return humanise(value);
}

function initials(value: string) {
  return value.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join("").toUpperCase() || "U";
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
