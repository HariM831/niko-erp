import {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  useContext,
  useState,
  type ReactNode,
} from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

const Ctx = createContext<{ open: boolean; setOpen: (v: boolean) => void } | null>(null);

/** Works controlled (open + onOpenChange) or on its own. */
export function Dialog({
  open,
  onOpenChange,
  children,
}: {
  open?: boolean;
  onOpenChange?: (v: boolean) => void;
  children?: ReactNode;
}) {
  const [inner, setInner] = useState(false);
  const current = open ?? inner;
  const setOpen = (v: boolean) => {
    if (open === undefined) setInner(v);
    onOpenChange?.(v);
  };
  return <Ctx.Provider value={{ open: current, setOpen }}>{children}</Ctx.Provider>;
}

export function DialogTrigger({ asChild, children }: { asChild?: boolean; children: ReactNode }) {
  const ctx = useContext(Ctx)!;
  const child = Children.only(children);
  if (asChild && isValidElement(child)) {
    const el = child as React.ReactElement<{ onClick?: (e: unknown) => void }>;
    return cloneElement(el, {
      onClick: (e: unknown) => {
        el.props.onClick?.(e);
        ctx.setOpen(true);
      },
    } as never);
  }
  return <button onClick={() => ctx.setOpen(true)}>{children}</button>;
}

export function DialogContent({ className, children }: { className?: string; children?: ReactNode }) {
  const ctx = useContext(Ctx)!;
  if (!ctx.open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-black/50" onClick={() => ctx.setOpen(false)} />
      <div
        className={cn(
          "relative z-10 w-full max-w-lg rounded-lg border border-border bg-card p-5 shadow-2xl",
          className,
        )}
      >
        <button
          onClick={() => ctx.setOpen(false)}
          className="absolute right-3 top-3 p-1 text-muted-foreground hover:text-foreground"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>
        {children}
      </div>
    </div>
  );
}

export function DialogHeader({ className, children }: { className?: string; children?: ReactNode }) {
  return <div className={cn("mb-2 flex flex-col gap-1", className)}>{children}</div>;
}

export function DialogTitle({ className, children }: { className?: string; children?: ReactNode }) {
  return <h2 className={cn("text-base font-semibold text-foreground", className)}>{children}</h2>;
}
