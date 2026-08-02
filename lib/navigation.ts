/**
 * Match navigation destinations on route-segment boundaries. Review orders is
 * a stable entry route whose detail screens live under /results/:batchId.
 */
export function isNavigationActive(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  if (href === "/review-orders") {
    return pathname === href || pathname.startsWith("/results/");
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}
