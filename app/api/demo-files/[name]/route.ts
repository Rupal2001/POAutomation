import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const allowed: Record<string, { filename: string; directory: "demo" | "methodology"; contentType: string }> = {
  sales: { filename: "historical_sales.csv", directory: "demo", contentType: "text/csv; charset=utf-8" },
  inventory: { filename: "current_inventory.csv", directory: "demo", contentType: "text/csv; charset=utf-8" },
  open_pos: { filename: "open_purchase_orders.csv", directory: "demo", contentType: "text/csv; charset=utf-8" },
  suppliers: { filename: "vendor_master.csv", directory: "demo", contentType: "text/csv; charset=utf-8" },
  supplier_mappings: { filename: "supplier_mappings.csv", directory: "demo", contentType: "text/csv; charset=utf-8" },
  catalogue: { filename: "catalogue_sources.csv", directory: "demo", contentType: "text/csv; charset=utf-8" },
  workbook: { filename: "Noise_113.xlsx", directory: "methodology", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  new_po_sales: { filename: "sell_out_template.csv", directory: "methodology", contentType: "text/csv; charset=utf-8" },
  new_po_inventory: { filename: "current_inventory_template.csv", directory: "methodology", contentType: "text/csv; charset=utf-8" },
  new_po_open_pos: { filename: "open_po_template.csv", directory: "methodology", contentType: "text/csv; charset=utf-8" },
  new_po_styles: { filename: "style_details_template.csv", directory: "methodology", contentType: "text/csv; charset=utf-8" },
};

export async function GET(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const config = allowed[name];
  if (!config) return NextResponse.json({ error: "Demo file not found." }, { status: 404 });

  try {
    const source = await readFile(path.join(process.cwd(), "sample-data", config.directory, config.filename));
    const download = req.nextUrl.searchParams.get("download") === "1";
    const emptyInboundTemplate = name === "open_pos" && req.nextUrl.searchParams.get("empty") === "1";
    const content = emptyInboundTemplate ? `${source.toString("utf8").split(/\r?\n/, 1)[0]}\n` : source;
    const downloadName = emptyInboundTemplate ? "open_purchase_orders_empty.csv" : config.filename;
    return new NextResponse(content, {
      headers: {
        "Content-Type": config.contentType,
        "Cache-Control": "no-store",
        ...(download ? { "Content-Disposition": `attachment; filename="${downloadName}"` } : {}),
      },
    });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "Could not load the demo file." }, { status: 500 });
  }
}
