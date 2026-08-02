"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import Icon, { IconName } from "./Icon";
import { formatDate } from "@/lib/format";
import { isNavigationActive } from "@/lib/navigation";

type SearchResult = { type: string; id: string; title: string; subtitle: string; meta: string; href: string };
type CurrentUser = { id: string; username: string; displayName: string; email: string | null; role: string; mustChangePassword: boolean; allowedAreas?: string[] };
type NavLink = { href: string; label: string; shortLabel: string; icon: IconName; area: string };

const primaryLinks: NavLink[] = [
  { href: "/dashboard", label: "Overview", shortLabel: "Overview", icon: "overview", area: "overview" },
  { href: "/", label: "Build a plan", shortLabel: "Plan", icon: "replenishment", area: "plan_builder" },
  { href: "/review-orders", label: "Review orders", shortLabel: "Review", icon: "check", area: "review_orders" },
  { href: "/forecast", label: "Forecast health", shortLabel: "Forecast", icon: "forecast", area: "forecast_health" },
  { href: "/purchase-orders", label: "Purchase orders", shortLabel: "POs", icon: "purchaseOrder", area: "purchase_orders" },
];

const secondaryLinks: NavLink[] = [
  { href: "/readiness", label: "Planning readiness", shortLabel: "Readiness", icon: "target", area: "planning_readiness" },
  { href: "/history", label: "Plan history", shortLabel: "History", icon: "history", area: "plan_history" },
  { href: "/supplier-mappings", label: "Supplier mapping", shortLabel: "Suppliers", icon: "package", area: "supplier_mapping" },
  { href: "/automation", label: "Data & automation", shortLabel: "Automation", icon: "automation", area: "data_automation" },
];

const adminLinks: NavLink[] = [
  { href: "/admin", label: "Control centre", shortLabel: "Admin", icon: "automation", area: "admin_access_control" },
  { href: "/admin/access-control", label: "Access control", shortLabel: "Access", icon: "shield", area: "admin_access_control" },
];

export default function Nav() {
  const pathname = usePathname();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [allowedAreas, setAllowedAreas] = useState<string[]>([]);
  const [accessResolved, setAccessResolved] = useState(false);
  const [dataAsOf, setDataAsOf] = useState<string | null>(null);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);
  const accountRef = useRef<HTMLDivElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const mobileSheetRef = useRef<HTMLDivElement>(null);
  const mobileCloseRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (pathname === "/login") return;
    fetch("/api/auth/me", { cache: "no-store" })
      .then(async response => {
        if (response.status === 401) {
          router.replace(`/login?next=${encodeURIComponent(pathname)}`);
          return null;
        }
        return response.ok ? response.json() : null;
      })
      .then(result => {
        setUser(result?.user ?? null);
        const nextAllowed = result?.allowedAreas ?? result?.user?.allowedAreas;
        const areaAccess = result?.areaAccess ?? result?.user?.areaAccess;
        if (Array.isArray(nextAllowed)) {
          setAllowedAreas(nextAllowed.filter((area: unknown): area is string => typeof area === "string"));
        } else if (areaAccess && typeof areaAccess === "object") {
          setAllowedAreas(Object.entries(areaAccess).filter(([, allowed]) => allowed === true).map(([area]) => area));
        } else {
          setAllowedAreas([]);
        }
        setAccessResolved(true);
      })
      .catch(() => undefined);
  }, [pathname, router]);

  useEffect(() => {
    try { setRailCollapsed(window.localStorage.getItem("styleflow.sidebar") === "collapsed"); } catch { /* Local storage can be unavailable in private contexts. */ }
  }, []);

  useEffect(() => {
    fetch("/api/dashboard")
      .then(response => response.ok ? response.json() : null)
      .then(data => setDataAsOf(data?.planning?.dataAsOf ?? data?.planning?.createdAt ?? null))
      .catch(() => undefined);
  }, [pathname]);

  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(`/api/search?q=${encodeURIComponent(query.trim())}`, { signal: controller.signal });
        const data = await response.json();
        setResults(response.ok ? data.results ?? [] : []);
      } catch (error) {
        if ((error as Error).name !== "AbortError") setResults([]);
      } finally {
        setSearching(false);
      }
    }, 220);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query]);

  useEffect(() => {
    function closeOnOutsideClick(event: MouseEvent) {
      if (!searchRef.current?.contains(event.target as Node)) setSearchOpen(false);
      if (!accountRef.current?.contains(event.target as Node)) setAccountOpen(false);
    }
    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, []);

  useEffect(() => {
    setSearchOpen(false);
    setAccountOpen(false);
    setMoreOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!moreOpen) return;
    mobileCloseRef.current?.focus();
    function handleSheetKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setMoreOpen(false);
        moreButtonRef.current?.focus();
        return;
      }
      if (event.key !== "Tab" || !mobileSheetRef.current) return;
      const focusable = [...mobileSheetRef.current.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')];
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
    document.addEventListener("keydown", handleSheetKeyDown);
    return () => document.removeEventListener("keydown", handleSheetKeyDown);
  }, [moreOpen]);

  useEffect(() => {
    function closeFloatingUi(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setSearchOpen(false);
      setAccountOpen(false);
    }
    document.addEventListener("keydown", closeFloatingUi);
    return () => document.removeEventListener("keydown", closeFloatingUi);
  }, []);

  if (pathname === "/login") return null;

  const canOpen = (area: string) => accessResolved && allowedAreas.includes(area);
  const visiblePrimaryLinks = primaryLinks.filter(link => canOpen(link.area));
  const visibleSecondaryLinks = secondaryLinks.filter(link => canOpen(link.area));
  const visibleAdminLinks = user?.role === "admin" ? adminLinks.filter(link => canOpen(link.area)) : [];
  const mobilePrimaryLinks = visiblePrimaryLinks.filter(link => link.href !== "/forecast");
  const mobileMoreLinks = [...visiblePrimaryLinks.filter(link => link.href === "/forecast"), ...visibleSecondaryLinks];
  const mobileAdminActive = visibleAdminLinks.some(link => link.href === "/admin" ? pathname === "/admin" : isNavigationActive(pathname, link.href));
  const homeHref = visiblePrimaryLinks[0]?.href ?? "/profile";

  function toggleRail() {
    setRailCollapsed(current => {
      const next = !current;
      try { window.localStorage.setItem("styleflow.sidebar", next ? "collapsed" : "expanded"); } catch { /* Keep the in-memory preference for this session. */ }
      return next;
    });
  }

  function openResult(result: SearchResult) {
    setSearchOpen(false);
    setQuery("");
    router.push(result.href);
  }

  async function logout() {
    setAccountOpen(false);
    setMoreOpen(false);
    setAccessResolved(false);
    setAllowedAreas([]);
    setUser(null);
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    router.replace("/login");
    router.refresh();
  }

  return <>
    <aside id="app-sidebar" className={`app-rail ${railCollapsed ? "is-collapsed" : ""}`}>
      <Link href={homeHref} className="brand-lockup" aria-label="StyleFlow home">
        <span className="brand-mark" aria-hidden="true"><img src="/brand/myntra-mark.png" alt=""/></span>
        <span><strong>StyleFlow</strong><small>Myntra buying operations</small></span>
      </Link>

      <div className="rail-section-label">Workspace</div>
      <nav aria-label="Primary navigation" className="rail-links">
        {visiblePrimaryLinks.map(link => <RailLink key={link.href} {...link} active={isNavigationActive(pathname, link.href)} collapsed={railCollapsed}/>) }
      </nav>

      <div className="rail-section-label rail-section-spaced">Manage</div>
      <nav aria-label="Management navigation" className="rail-links">
        {visibleSecondaryLinks.map(link => <RailLink key={link.href} {...link} active={isNavigationActive(pathname, link.href)} collapsed={railCollapsed}/>) }
      </nav>

      {visibleAdminLinks.length > 0 && <>
        <div className="rail-section-label rail-section-spaced">Administration</div>
        <nav aria-label="Administration navigation" className="rail-links">
          {visibleAdminLinks.map(link => <RailLink key={link.href} {...link} active={link.href === "/admin" ? pathname === "/admin" : isNavigationActive(pathname, link.href)} collapsed={railCollapsed}/>) }
        </nav>
      </>}

      <div className="rail-footer" title={railCollapsed ? "Local workspace ready" : undefined}>
        <span className="status-dot" aria-hidden="true"/>
        <div><strong>Local workspace ready</strong><small>Catalogue snapshot · Sample workspace</small></div>
      </div>
    </aside>
    <button className={`rail-collapse-button ${railCollapsed ? "is-collapsed" : ""}`} type="button" onClick={toggleRail} aria-controls="app-sidebar" aria-expanded={!railCollapsed} aria-label={railCollapsed ? "Expand sidebar" : "Minimise sidebar"} title={railCollapsed ? "Expand sidebar" : "Minimise sidebar"}>
      <Icon name="chevronRight"/>
    </button>

    <header className="command-bar">
      <div className="command-search" ref={searchRef}>
        <Icon name="search"/>
        <label className="sr-only" htmlFor="global-search">Search styles, SKUs, suppliers or purchase orders</label>
        <input
          id="global-search"
          value={query}
          onChange={event => { setQuery(event.target.value); setSearchOpen(true); }}
          onFocus={() => setSearchOpen(true)}
          onKeyDown={event => {
            if (event.key === "Escape") setSearchOpen(false);
            if (event.key === "Enter" && results[0]) openResult(results[0]);
          }}
          autoComplete="off"
          placeholder="Search style, SKU, supplier or PO…"
        />
        {query && <button className="search-clear" aria-label="Clear search" onClick={() => { setQuery(""); setResults([]); }}><Icon name="close"/></button>}
        {searchOpen && query.trim().length >= 2 && <div className="search-results" role="listbox" aria-label="Search results">
          <div className="search-results-head" aria-live="polite">{searching ? "Searching…" : `${results.length} result${results.length === 1 ? "" : "s"}`}</div>
          {!searching && results.map(result => <button key={`${result.type}-${result.id}`} role="option" aria-selected="false" onClick={() => openResult(result)}>
            <span className="search-result-icon"><Icon name={result.type === "purchase_order" ? "purchaseOrder" : "package"}/></span>
            <span><strong>{result.title}</strong><small>{result.subtitle}</small></span>
            <em>{result.meta}</em>
          </button>)}
          {!searching && !results.length && <p>No matching styles, suppliers or POs.</p>}
        </div>}
      </div>
      <div className="freshness">
        <span className="status-dot" aria-hidden="true"/>
        <span><strong>Latest data</strong><small>{dataAsOf ? formatDate(dataAsOf) : "Checking…"}</small></span>
      </div>
      <div className="account-menu" ref={accountRef}>
        <button className="account-trigger" type="button" aria-expanded={accountOpen} aria-controls="account-popover" onClick={() => setAccountOpen(value => !value)}>
          <span className="avatar" aria-hidden="true">{initials(user?.displayName || user?.username || "User")}</span>
          <span className="account-trigger-copy"><strong>{user?.displayName || "Loading account…"}</strong><small>{user ? roleLabel(user.role) : ""}</small></span>
          <Icon name="chevronRight"/>
        </button>
        {accountOpen && <div id="account-popover" className="account-popover">
          <div className="account-popover-head"><span className="avatar">{initials(user?.displayName || user?.username || "User")}</span><div><strong>{user?.displayName}</strong><small>@{user?.username} · {roleLabel(user?.role || "viewer")}</small></div></div>
          {user?.mustChangePassword && <Link className="account-security-notice" href="/profile" onClick={() => setAccountOpen(false)}><Icon name="alert"/><span><strong>Change temporary password</strong><small>Secure this account now</small></span></Link>}
          <nav aria-label="Account navigation">
            <Link href="/profile" onClick={() => setAccountOpen(false)}><Icon name="shield"/><span>Profile & security</span></Link>
            {user?.role === "admin" && canOpen("admin_access_control") && <Link href="/admin" onClick={() => setAccountOpen(false)}><Icon name="automation"/><span>Workspace admin</span></Link>}
            <button type="button" onClick={logout}><Icon name="arrowRight"/><span>Sign out</span></button>
          </nav>
        </div>}
      </div>
    </header>

    <nav className="mobile-nav" aria-label="Mobile navigation">
      {mobilePrimaryLinks.map(link => <Link key={link.href} href={link.href} aria-current={isNavigationActive(pathname, link.href) ? "page" : undefined}>
        <Icon name={link.icon}/><small>{link.shortLabel}</small>
      </Link>)}
      <button ref={moreButtonRef} type="button" aria-haspopup="dialog" aria-expanded={moreOpen} aria-controls="mobile-more-menu" onClick={() => setMoreOpen(value => !value)} className={mobileAdminActive || mobileMoreLinks.some(link => isNavigationActive(pathname, link.href)) ? "active" : ""}>
        <Icon name="more"/><small>More</small>
      </button>
    </nav>
    {moreOpen && <div className="mobile-more-backdrop" onClick={() => { setMoreOpen(false); moreButtonRef.current?.focus(); }}>
      <div ref={mobileSheetRef} id="mobile-more-menu" className="mobile-more-sheet" role="dialog" aria-modal="true" aria-labelledby="mobile-more-title" onClick={event => event.stopPropagation()}>
        <div className="mobile-more-handle"/>
        <div className="flex items-center justify-between"><div><p className="eyebrow">More</p><h2 id="mobile-more-title" className="section-title">Planning tools</h2></div><button ref={mobileCloseRef} type="button" className="icon-button" aria-label="Close more menu" onClick={() => { setMoreOpen(false); moreButtonRef.current?.focus(); }}><Icon name="close"/></button></div>
        {mobileMoreLinks.map(link => <Link key={link.href} href={link.href} onClick={() => setMoreOpen(false)}><span><Icon name={link.icon}/></span><strong>{link.label}</strong><Icon name="chevronRight"/></Link>)}
        <div className="mobile-account-summary"><span className="avatar">{initials(user?.displayName || user?.username || "User")}</span><div><strong>{user?.displayName || user?.username}</strong><small>{roleLabel(user?.role || "viewer")}</small></div></div>
        <Link href="/profile" onClick={() => setMoreOpen(false)}><span><Icon name="shield"/></span><strong>Profile & security</strong><Icon name="chevronRight"/></Link>
        {user?.role === "admin" && canOpen("admin_access_control") && <><Link href="/admin" onClick={() => setMoreOpen(false)}><span><Icon name="automation"/></span><strong>Workspace admin</strong><Icon name="chevronRight"/></Link><Link href="/admin/access-control" onClick={() => setMoreOpen(false)}><span><Icon name="shield"/></span><strong>Access control</strong><Icon name="chevronRight"/></Link></>}
        <button type="button" onClick={logout}><span><Icon name="arrowRight"/></span><strong>Sign out</strong><Icon name="chevronRight"/></button>
      </div>
    </div>}
  </>;
}

function initials(value: string) {
  return value.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join("").toUpperCase() || "U";
}

function roleLabel(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, letter => letter.toUpperCase());
}

function RailLink({ href, label, icon, active, collapsed }: NavLink & { active: boolean; collapsed: boolean }) {
  return <Link href={href} aria-current={active ? "page" : undefined} aria-label={label} title={collapsed ? label : undefined} className={active ? "active" : ""}>
    <span aria-hidden="true"><Icon name={icon}/></span><span>{label}</span>
  </Link>;
}
