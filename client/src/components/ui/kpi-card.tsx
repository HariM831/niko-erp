import type { ComponentType } from "react";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";

/**
 * The KPI card the ported screens use.
 *
 * Values never wrap or truncate — a number that does not fit means the row
 * needs to scroll, not that the digits should break mid-number.
 */
export function KpiCard({
  label,
  value,
  sub,
  icon: Icon,
  accent = "bg-primary",
  variant = "default",
  onClick,
  className,
}: {
  label: string;
  value: string | number;
  sub?: string;
  icon?: ComponentType<{ className?: string }>;
  /** Tailwind bg-* for the icon square — "bg-success", "bg-info", … */
  accent?: string;
  variant?: "default" | "compact";
  onClick?: () => void;
  className?: string;
  "data-testid"?: string;
}) {
  return (
    <Card
      className={cn("relative overflow-hidden border-0 transition-shadow hover:shadow-md", onClick && "cursor-pointer", className)}
      onClick={onClick}
    >
      <CardContent className={cn("pt-0", variant === "default" ? "p-5" : "p-3.5")}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {label}
            </p>
            <p
              className={cn(
                "whitespace-nowrap font-bold leading-tight text-foreground",
                variant === "default" ? "text-2xl" : "text-lg",
              )}
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {value}
            </p>
            {sub && <p className="mt-0.5 text-[11px] text-muted-foreground">{sub}</p>}
          </div>
          {Icon && (
            <div
              className={cn(
                "flex flex-shrink-0 items-center justify-center rounded-lg",
                variant === "default" ? "h-10 w-10" : "h-8 w-8",
                accent,
              )}
            >
              <Icon className={cn("text-white", variant === "default" ? "h-5 w-5" : "h-4 w-4")} />
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
