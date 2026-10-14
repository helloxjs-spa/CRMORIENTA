import { Badge } from "@/components/ui/badge";
import { SALE_STATUS_LABELS } from "@/lib/sales";
import type { SaleStatus } from "@/server/db/schema";

export function SaleStatusBadge({ status }: { status: SaleStatus }) {
  return <Badge tone={status === "ACTIVE" ? "success" : "danger"}>{SALE_STATUS_LABELS[status]}</Badge>;
}
