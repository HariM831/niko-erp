import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A native <select> wearing the Radix API.
 *
 * The pages being ported are written against Radix's shape — a trigger, a
 * content wrapper and item children. Rather than reproduce a popup listbox,
 * this walks those children for their values and labels and renders one real
 * <select>. On a phone that is also the better control: it opens the OS picker.
 */
interface ItemProps {
  value: string;
  children?: ReactNode;
  disabled?: boolean;
}

function collectItems(node: ReactNode, out: ItemProps[] = []): ItemProps[] {
  Children.forEach(node, (child) => {
    if (!isValidElement(child)) return;
    const el = child as ReactElement<Record<string, unknown>>;
    if (el.type === SelectItem) {
      out.push(el.props as unknown as ItemProps);
      return;
    }
    if (el.props && "children" in el.props) collectItems(el.props.children as ReactNode, out);
  });
  return out;
}

function findPlaceholder(node: ReactNode): string | undefined {
  let found: string | undefined;
  Children.forEach(node, (child) => {
    if (found || !isValidElement(child)) return;
    const el = child as ReactElement<Record<string, unknown>>;
    if (el.type === SelectValue) {
      found = el.props.placeholder as string | undefined;
      return;
    }
    if (el.props && "children" in el.props) {
      const inner = findPlaceholder(el.props.children as ReactNode);
      if (inner) found = inner;
    }
  });
  return found;
}

function findTriggerClass(node: ReactNode): string | undefined {
  let found: string | undefined;
  Children.forEach(node, (child) => {
    if (found || !isValidElement(child)) return;
    const el = child as ReactElement<Record<string, unknown>>;
    if (el.type === SelectTrigger) found = el.props.className as string | undefined;
  });
  return found;
}

export function Select({
  value,
  onValueChange,
  disabled,
  children,
}: {
  value?: string;
  onValueChange?: (v: string) => void;
  disabled?: boolean;
  children?: ReactNode;
}) {
  const items = collectItems(children);
  const placeholder = findPlaceholder(children);
  return (
    <select
      value={value ?? ""}
      disabled={disabled}
      onChange={(e) => onValueChange?.(e.target.value)}
      className={cn(
        "flex h-10 w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground",
        "focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50",
        findTriggerClass(children),
      )}
    >
      {placeholder && (
        <option value="" disabled>
          {placeholder}
        </option>
      )}
      {items.map((it) => (
        <option key={it.value} value={it.value} disabled={it.disabled}>
          {typeof it.children === "string" ? it.children : String(it.children ?? it.value)}
        </option>
      ))}
    </select>
  );
}

/* These render nothing on their own — Select reads them. Keeping the same
   names means a ported page needs no edits. */
export function SelectTrigger(_: { className?: string; children?: ReactNode }) {
  return null;
}
export function SelectValue(_: { placeholder?: string }) {
  return null;
}
export function SelectContent(_: { children?: ReactNode }) {
  return null;
}
export function SelectItem(_: ItemProps) {
  return null;
}
