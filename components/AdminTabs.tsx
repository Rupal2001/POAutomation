"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import Icon from "@/components/Icon";

const links = [
  { href: "/admin", label: "Control centre", description: "Users and system health", icon: "automation" as const },
  { href: "/admin/access-control", label: "Access control", description: "Page access by role and user", icon: "shield" as const },
];

export default function AdminTabs() {
  const pathname = usePathname();

  return <nav className="admin-section-nav" aria-label="Administration sections">
    {links.map(link => {
      const active = link.href === "/admin" ? pathname === link.href : pathname.startsWith(link.href);
      return <Link key={link.href} href={link.href} className={active ? "active" : ""} aria-current={active ? "page" : undefined}>
        <span aria-hidden="true"><Icon name={link.icon}/></span>
        <span><strong>{link.label}</strong><small>{link.description}</small></span>
      </Link>;
    })}
  </nav>;
}
