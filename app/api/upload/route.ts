import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { AuthError, requireUser } from "@/lib/auth";
import { dbJson, sql } from "@/lib/db";
import { adaptNewPoDataset, newPoPlanningSettings } from "@/lib/new-po-adapter";
import { isMyntraOperationalCsvBundle, parseMyntraOperationalCsvBundle } from "@/lib/legacy-new-po-import";
import {
  combineNewPoSourceImports,
  NewPoImportError,
  parseNewPoBulkWorkbook,
  parseNewPoSourceFile,
  type NewPoImportBundle,
  type NewPoSourceType,
} from "@/lib/new-po-import";
import { NewPoCalculationError, type NewPoCalculationInput } from "@/lib/new-po-methodology";
import { enrichStyleDetailsWithMappings, loadVendorMappingsForStyles, mergeVendorMasterMappings } from "@/lib/vendor-mappings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    await requireUser(req, ["admin", "planner"]);
    const form = await req.formData();
    const coverageDays = positiveWholeNumber(form.get("coverageDays"), 45, "PO cover days", 365);
    const dohThreshold = positiveNumber(form.get("dohThreshold"), 80, "DOH threshold", 730);
    const label = String(form.get("label") || "Myntra style cover plan").trim().slice(0, 160);
    const forecastMethod = String(form.get("forecastMethod") || "auto");
    if (!["auto", "average", "recent", "weighted", "seasonal", "trend", "croston"].includes(forecastMethod)) {
      return NextResponse.json({ error: "Unsupported forecast evidence method." }, { status: 400 });
    }

    const workbooks = form.getAll("planning_workbook").filter((value): value is File => value instanceof File && Boolean(value.name));
    if (workbooks.length > 1) {
      return NextResponse.json({ error: "Upload only one bulk planning workbook." }, { status: 400 });
    }
    const workbook = workbooks[0];
    const separateUpload = sourceFiles(form);
    if (separateUpload.duplicateSource) {
      return NextResponse.json({ error: `Upload only one ${sourceLabel(separateUpload.duplicateSource)} file.` }, { status: 400 });
    }
    const separateFiles = separateUpload.files;
    if (workbook instanceof File && separateFiles.length) {
      return NextResponse.json({ error: "Choose either one bulk workbook or separate source files, not both." }, { status: 400 });
    }

    let bundle: NewPoImportBundle & { data: NewPoCalculationInput };
    let importMode: "bulk_workbook" | "separate_files";
    if (workbook instanceof File) {
      bundle = await parseNewPoBulkWorkbook(await workbook.arrayBuffer(), workbook.name);
      importMode = "bulk_workbook";
    } else {
      const missing = (["sales", "inventory", "openPos", "styleDetails"] as NewPoSourceType[]).filter(type => !separateFiles.some(file => file.sourceType === type));
      if (missing.length) {
        return NextResponse.json({ error: `Separate upload is missing: ${missing.map(sourceLabel).join(", ")}.` }, { status: 400 });
      }
      const uploadedSources = await Promise.all(separateFiles.map(async file => ({
        fileName: file.file.name,
        data: await file.file.arrayBuffer(),
        sourceType: file.sourceType,
      })));
      if (isMyntraOperationalCsvBundle(uploadedSources)) {
        bundle = parseMyntraOperationalCsvBundle(uploadedSources);
      } else {
        const parts = await Promise.all(uploadedSources.map(parseNewPoSourceFile));
        bundle = combineNewPoSourceImports(parts);
      }
      importMode = "separate_files";
    }

    const db = sql();
    const mappings = await loadVendorMappingsForStyles(db, bundle.data.styleDetails.map(row => row.styleId));
    const enrichedInput = {
      ...bundle.data,
      styleDetails: enrichStyleDetailsWithMappings(bundle.data.styleDetails, mappings),
    };
    const adapted = adaptNewPoDataset(enrichedInput, coverageDays, dohThreshold);
    adapted.vendorMaster = mergeVendorMasterMappings(adapted.vendorMaster, mappings);
    const id = randomUUID();
    const source = {
      importMode,
      importVersion: bundle.report.importVersion,
      sourceFormat: bundle.report.sourceFormat,
      fileNames: bundle.report.fileNames,
      sheetNames: bundle.report.sheetNames,
      rowCounts: bundle.report.rowCounts,
      ignoredSheetNames: bundle.report.ignoredSheetNames,
      ...("compatibility" in bundle.report ? { compatibility: bundle.report.compatibility } : {}),
    };
    const planningSettings = {
      ...newPoPlanningSettings(adapted, source, dohThreshold),
      forecastMethod,
      lookbackDays: Number(form.get("lookbackDays") || 0) || null,
      plannedPromotionUpliftPct: Number(form.get("plannedPromotionUpliftPct") || 0) || 0,
      eventName: String(form.get("eventName") || "").trim() || null,
      sourceBatchId: id,
    };
    await db`
      INSERT INTO batches (id,coverage_days,status,label,sales_data,inventory_data,open_po_data,vendor_master_data,planning_settings)
      VALUES (${id},${coverageDays},'uploaded',${label || null},${dbJson(adapted.sales)}::jsonb,${dbJson(adapted.inventory)}::jsonb,
              ${dbJson(adapted.openPos)}::jsonb,${dbJson(adapted.vendorMaster)}::jsonb,${dbJson(planningSettings)}::jsonb)
    `;
    await db`
      INSERT INTO integration_runs (integration,direction,status,reference,details)
      VALUES ('file_import','inbound','completed',${id},${dbJson({ ...source, summary: adapted.calculationPreview.summary })}::jsonb)
    `;
    const salesStyles = new Set(adapted.sales.map(row => row.styleId || row.sku).filter(Boolean));
    const mappedVendorStyles = new Set(adapted.vendorMaster
      .filter(row => row.vendor && row.vendor !== "Supplier mapping required")
      .map(row => row.styleId || row.sku)
      .filter(Boolean));
    const missingVendors = [...salesStyles].filter(styleId => !mappedVendorStyles.has(styleId)).length;
    return NextResponse.json({
      batchId: id,
      methodologyVersion: adapted.calculationPreview.methodologyVersion,
      summary: adapted.calculationPreview.summary,
      dataQuality: {
        ...adapted.calculationPreview.dataQuality,
        missingVendorMappings: missingVendors,
      },
      importReport: bundle.report,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof NewPoImportError) {
      return NextResponse.json({ error: error.message, issues: error.issues }, { status: 400 });
    }
    if (error instanceof NewPoCalculationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof Error && /^(PO cover days|DOH threshold)/.test(error.message)) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error(error);
    return NextResponse.json({ error: "Unexpected error while validating the New PO source data." }, { status: 500 });
  }
}

function sourceFiles(form: FormData) {
  const definitions: Array<{ sourceType: NewPoSourceType; keys: string[] }> = [
    { sourceType: "sales", keys: ["sell_out", "historical_sales"] },
    { sourceType: "inventory", keys: ["current_inventory"] },
    { sourceType: "openPos", keys: ["open_purchase_orders"] },
    { sourceType: "styleDetails", keys: ["style_details", "vendor_master"] },
  ];
  const files: Array<{ sourceType: NewPoSourceType; file: File }> = [];
  for (const definition of definitions) {
    const matches = definition.keys.flatMap(key => form.getAll(key)).filter((value): value is File => value instanceof File && Boolean(value.name));
    if (matches.length > 1) return { files, duplicateSource: definition.sourceType };
    if (matches[0]) files.push({ sourceType: definition.sourceType, file: matches[0] });
  }
  return { files, duplicateSource: null as NewPoSourceType | null };
}

function positiveWholeNumber(value: FormDataEntryValue | null, fallback: number, label: string, maximum: number) {
  const parsed = value === null || value === "" ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > maximum) throw new Error(`${label} must be a whole number from 1 to ${maximum}.`);
  return parsed;
}

function positiveNumber(value: FormDataEntryValue | null, fallback: number, label: string, maximum: number) {
  const parsed = value === null || value === "" ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > maximum) throw new Error(`${label} must be above 0 and no more than ${maximum}.`);
  return parsed;
}

function sourceLabel(source: NewPoSourceType) {
  return ({ sales: "sell-out", inventory: "current inventory", openPos: "open PO", styleDetails: "style details" } as const)[source];
}
