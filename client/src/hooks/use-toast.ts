/**
 * `useToast` — the notification call the ported screens make.
 *
 * niko has no toast system, so for now these go to the console rather than
 * being swallowed: a save that quietly fails is worse than one that says so
 * somewhere. Wire this to a real toast when niko grows one.
 */
export interface ToastArgs {
  title?: string;
  description?: string;
  variant?: "default" | "destructive";
}

export function useToast() {
  return {
    toast: ({ title, description, variant }: ToastArgs) => {
      const line = [title, description].filter(Boolean).join(" — ");
      if (variant === "destructive") console.error("[toast]", line);
      else console.info("[toast]", line);
    },
  };
}
