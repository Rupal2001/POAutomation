import { NextRequest, NextResponse } from "next/server";
import { AuthError, requireUser } from "@/lib/auth";
import { sql } from "@/lib/db";
import { buildVendorMappingCsv, buildVendorMappingWorkbook } from "@/lib/vendor-mapping-files";
import { mappingFromDb } from "@/lib/vendor-mappings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    await requireUser(request);
    const format = request.nextUrl.searchParams.get("format")?.toLocaleLowerCase("en-IN") ?? "csv";
    if (format !== "csv" && format !== "xlsx") return NextResponse.json({ error: "Choose CSV or XLSX export format." }, { status: 400 });
    const template = request.nextUrl.searchParams.get("template") === "1";
    const rows = template ? [] : (await sql()`SELECT * FROM supplier_style_mappings ORDER BY style_id,vendor NULLS FIRST`).map(mappingFromDb);
    const date = new Date().toISOString().slice(0, 10);
    if (format === "xlsx") {
      const buffer = await buildVendorMappingWorkbook(rows);
      return new NextResponse(buffer as ArrayBuffer, { headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="StyleFlow_Supplier_Mappings_${date}.xlsx"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      } });
    }
    return new NextResponse(buildVendorMappingCsv(rows), { headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="StyleFlow_Supplier_Mappings_${date}.csv"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    } });
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error(error);
    return NextResponse.json({ error: "Could not export the supplier mapping master." }, { status: 500 });
  }
}
