import type { LabelHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Label({
  className,
  children,
  ...rest
}: LabelHTMLAttributes<HTMLLabelElement> & { children?: ReactNode }) {
  return (
    <label className={cn("mb-1 block text-sm font-medium text-foreground", className)} {...rest}>
      {children}
    </label>
  );
}
