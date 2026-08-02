import Link from "next/link";
import { redirect } from "next/navigation";
import Icon from "@/components/Icon";
import { EmptyState } from "@/components/Ui";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type SavedPlan = { id: string };

export default async function ReviewOrdersEntryPage() {
  let latestPlan: SavedPlan | undefined;

  try {
    const rows = await sql()`
      SELECT id
      FROM batches
      WHERE status IN ('generated', 'archived')
        AND recommendations IS NOT NULL
      ORDER BY (status = 'generated') DESC, created_at DESC
      LIMIT 1
    ` as SavedPlan[];
    latestPlan = rows[0];
  } catch (error) {
    console.error("Unable to find the latest saved plan:", error);
    return <EmptyState
      title="Review orders is temporarily unavailable"
      icon="alert"
      action={<Link className="btn-secondary" href="/review-orders">Try again</Link>}
    >
      <p>StyleFlow could not check your saved plans. Confirm the database is connected, then try again.</p>
    </EmptyState>;
  }

  if (latestPlan) redirect(`/results/${encodeURIComponent(latestPlan.id)}`);

  return <EmptyState
    title="No saved plan to review"
    icon="purchaseOrder"
    action={<Link className="btn-primary" href="/"><Icon name="plus"/>Build a plan</Link>}
  >
    <p>Review orders opens your latest completed plan. Build a plan first, then come back here to check quantities, resolve supplier issues and create draft purchase orders.</p>
  </EmptyState>;
}
