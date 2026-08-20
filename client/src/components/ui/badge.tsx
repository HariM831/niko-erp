import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type Variant = "default" | "secondary" | "outline" | "destructive";

const VARIANT: Record<Variant, string> = {
  default: "bg-primary text-white",
  secondary: "bg-secondary text-foreground",
  outline: "border border-border text-foreground",
  destructive: "bg-destructive text-white",
};

export function Badge({
  variant = "default",
  className,
  children,
}: {
  variant?: Variant;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-2 py-0.5 text-xs font-medium",
        VARIANT[variant],
        className,
      )}
    >
      {children}
    </span>
  );
}
