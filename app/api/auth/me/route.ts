import { NextRequest, NextResponse } from "next/server";
import { getEffectiveAreaAccess } from "@/lib/access-control";
import { AuthError, getSessionUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const user = await getSessionUser(request);
    if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    const areaAccess = await getEffectiveAreaAccess(user);
    const allowedAreas = Object.entries(areaAccess)
      .filter(([, allowed]) => allowed)
      .map(([area]) => area);
    return NextResponse.json({ user, areaAccess, allowedAreas }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error(error);
    return NextResponse.json({ error: "Could not load your account." }, { status: 500 });
  }
}
