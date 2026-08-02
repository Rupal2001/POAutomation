import { NextRequest, NextResponse } from "next/server";
import {
  ACCESS_AREAS,
  accessForSessionClaims,
  accessRequirementForRequest,
  type AccessAreaKey,
  type AreaAccessMap,
} from "@/lib/access-control";
import { AUTH_COOKIE, verifySessionToken } from "@/lib/session";

function isPublicAuthRoute(pathname: string) {
  return (
    pathname === "/login" ||
    pathname === "/api/auth/login" ||
    pathname === "/api/auth/logout"
  );
}

function authenticationRequired(req: NextRequest) {
  if (req.nextUrl.pathname.startsWith("/api/")) {
    const response = NextResponse.json({ error: "Authentication required." }, { status: 401 });
    response.cookies.delete(AUTH_COOKIE);
    return response;
  }

  const url = new URL("/login", req.url);
  url.searchParams.set("next", `${req.nextUrl.pathname}${req.nextUrl.search}`);
  const response = NextResponse.redirect(url);
  response.cookies.delete(AUTH_COOKIE);
  return response;
}

function forbidden(req: NextRequest) {
  if (req.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: "Administrator access is required." },
      { status: 403 }
    );
  }
  return new NextResponse("Administrator access is required.", { status: 403 });
}

function areaForbidden(
  req: NextRequest,
  required: AccessAreaKey[],
  access: AreaAccessMap
) {
  if (req.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json(
      {
        error: "Access to this application area has not been assigned to your account.",
        code: "AREA_ACCESS_DENIED",
        requiredAreas: required,
      },
      { status: 403 }
    );
  }

  const destination = ACCESS_AREAS.find((area) => access[area.key])?.href ?? "/profile";
  const url = new URL(destination, req.url);
  url.searchParams.set("access", "denied");
  return NextResponse.redirect(url);
}

function passwordChangeRequired(req: NextRequest) {
  if (req.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: "Change the temporary password before continuing.", code: "PASSWORD_CHANGE_REQUIRED" },
      { status: 403 }
    );
  }
  return NextResponse.redirect(new URL("/profile?password=required", req.url));
}

export async function proxy(req: NextRequest) {
  const pathname = req.nextUrl.pathname;
  if (isPublicAuthRoute(pathname)) return NextResponse.next();

  let session;
  try {
    session = verifySessionToken(req.cookies.get(AUTH_COOKIE)?.value);
  } catch (error) {
    console.error("Authentication configuration error:", error);
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        { error: "Authentication is temporarily unavailable." },
        { status: 503 }
      );
    }
    return new NextResponse("Authentication is temporarily unavailable.", { status: 503 });
  }

  if (!session) return authenticationRequired(req);

  const passwordChangeRoute =
    pathname === "/profile" ||
    pathname === "/api/profile" ||
    pathname === "/api/auth/me" ||
    pathname === "/api/auth/logout";
  if (session.mustChangePassword && !passwordChangeRoute) {
    return passwordChangeRequired(req);
  }

  if (
    (pathname === "/admin" ||
      pathname.startsWith("/admin/") ||
      pathname === "/api/admin" ||
      pathname.startsWith("/api/admin/")) &&
    session.role !== "admin"
  ) {
    return forbidden(req);
  }

  const requiredAreas = accessRequirementForRequest(pathname, req.method);
  if (requiredAreas) {
    try {
      const access = await accessForSessionClaims(session);
      if (!requiredAreas.some((area) => access[area])) {
        return areaForbidden(req, requiredAreas, access);
      }
    } catch (error) {
      console.error("Access-control evaluation error:", error);
      if (pathname.startsWith("/api/")) {
        return NextResponse.json(
          { error: "Access control is temporarily unavailable.", code: "ACCESS_CONTROL_UNAVAILABLE" },
          { status: 503 }
        );
      }
      return new NextResponse("Access control is temporarily unavailable.", { status: 503 });
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)"],
};
