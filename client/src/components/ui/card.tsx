import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Card({ className, children, ...rest }: { className?: string; children?: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("rounded-lg border border-border bg-card shadow-sm", className)} {...rest}>
      {children}
    </div>
  );
}

export function CardHeader({ className, children }: { className?: string; children?: ReactNode }) {
  return <div className={cn("flex flex-col space-y-1.5 p-4", className)}>{children}</div>;
}

export function CardTitle({ className, children }: { className?: string; children?: ReactNode }) {
  return <h3 className={cn("font-semibold leading-none tracking-tight", className)}>{children}</h3>;
}

export function CardContent({ className, children }: { className?: string; children?: ReactNode }) {
  return <div className={cn("p-4 pt-0", className)}>{children}</div>;
}
