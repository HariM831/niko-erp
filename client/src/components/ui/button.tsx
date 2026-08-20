import { cloneElement, isValidElement, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/utils";

type Variant = "default" | "ghost" | "outline" | "secondary" | "destructive" | "link";
type Size = "default" | "sm" | "icon";

const VARIANT: Record<Variant, string> = {
  default: "bg-primary text-white hover:opacity-90",
  ghost: "hover:bg-muted text-foreground",
  outline: "border border-border bg-card hover:bg-muted text-foreground",
  secondary: "bg-secondary text-foreground hover:opacity-90",
  destructive: "bg-destructive text-white hover:opacity-90",
  link: "text-primary underline-offset-4 hover:underline",
};

const SIZE: Record<Size, string> = {
  default: "h-10 px-4 py-2",
  sm: "h-9 px-3 text-sm",
  icon: "h-10 w-10",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  /** Render the single child instead of a <button>, keeping the handlers. */
  asChild?: boolean;
  children?: ReactNode;
}

export function Button({
  variant = "default",
  size = "default",
  asChild,
  className,
  children,
  ...rest
}: ButtonProps) {
  const classes = cn(
    "inline-flex items-center justify-center gap-1 rounded-lg font-medium transition-colors disabled:pointer-events-none disabled:opacity-50",
    VARIANT[variant],
    SIZE[size],
    className,
  );
  if (asChild && isValidElement(children)) {
    const child = children as React.ReactElement<{ className?: string }>;
    return cloneElement(child, { ...rest, className: cn(classes, child.props.className) } as never);
  }
  return (
    <button className={classes} {...rest}>
      {children}
    </button>
  );
}
