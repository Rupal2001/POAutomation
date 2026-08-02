import { NextRequest, NextResponse } from "next/server";
import JSZip from "jszip";
import { AuthError, requireUser } from "@/lib/auth";
import { sql, BatchRow } from "@/lib/db";
import { Recommendation, type VendorMasterRow } from "@/lib/po-engine";
import { buildMasterCsv, buildVendorWorkbook } from "@/lib/export";
import { hasApplicableSupplierMaster, purchaseOrderBlockReason } from "@/lib/recommendation-review";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const format = req.nextUrl.searchParams.get("format") ?? "zip";

  try {
    await requireUser(req);
    const db = sql();
    const rows = (await db`SELECT * FROM batches WHERE id = ${id}`) as BatchRow[];
    if (rows.length === 0) {
      return NextResponse.json({ error: "Batch not found." }, { status: 404 });
    }
    const batch = rows[0];
    if (!batch.recommendations) {
      return NextResponse.json({ error: "This batch has not been generated yet." }, { status: 400 });
    }

    const recommendations = batch.recommendations as Recommendation[];
    const vendorMaster = (Array.isArray(batch.vendor_master_data) ? batch.vendor_master_data : []) as VendorMasterRow[];
    const runDate = new Date(batch.created_at).toISOString().slice(0, 10);
    const masterCsv = buildMasterCsv(recommendations);

    if (format === "csv") {
      return new NextResponse(masterCsv, {
        headers: {
          "Content-Type": "text/csv",
          "Content-Disposition": `attachment; filename="PO_Recommendations_${runDate}.csv"`,
        },
      });
    }

    const zip = new JSZip();
    zip.file(`PO_Recommendations_${runDate}.csv`, masterCsv);

    const byVendor = new Map<string, Recommendation[]>();
    for (const r of recommendations) {
      if (r.suggestedPoQty <= 0 || purchaseOrderBlockReason(r) || !hasApplicableSupplierMaster(r, vendorMaster)) continue;
      const list = byVendor.get(r.vendor) ?? [];
      list.push(r);
      byVendor.set(r.vendor, list);
    }

    const vendorFolder = zip.folder(`supplier_ready_recommendations_${runDate}`);
    for (const [vendor, vendorRows] of byVendor.entries()) {
      const buffer = await buildVendorWorkbook(vendor, vendorRows, batch.coverage_days, runDate);
      const safeName = vendor.replace(/[^a-zA-Z0-9 _-]/g, "").trim() || "Supplier";
      vendorFolder?.file(`Recommendation_${safeName}_${runDate}.xlsx`, buffer);
    }

    const zipBytes = await zip.generateAsync({ type: "uint8array" });
    const zipArrayBuffer = zipBytes.buffer.slice(
      zipBytes.byteOffset,
      zipBytes.byteOffset + zipBytes.byteLength
    ) as ArrayBuffer;
    return new NextResponse(zipArrayBuffer, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="PO_Export_${runDate}.zip"`,
      },
    });
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status });
    console.error(err);
    return NextResponse.json({ error: "Unexpected error while exporting." }, { status: 500 });
  }
}
