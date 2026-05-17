import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

export type ComposeMode = "new" | "reply" | "reply-all" | "forward" | "test";

export interface ComposePrefill {
  mode: ComposeMode;
  from?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  text?: string;
  html?: string;
  bodyMode?: "text" | "html";
  inReplyTo?: string | null;
  references?: string[];
  // For test mode, the domain we're verifying.
  testDomain?: string;
}

interface Ctx {
  open: boolean;
  prefill: ComposePrefill | null;
  openCompose: (p: ComposePrefill) => void;
  close: () => void;
}

const ComposeContext = createContext<Ctx | null>(null);

export function ComposeProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [prefill, setPrefill] = useState<ComposePrefill | null>(null);

  const openCompose = useCallback((p: ComposePrefill) => {
    setPrefill(p);
    setOpen(true);
  }, []);
  const close = useCallback(() => {
    setOpen(false);
    // Keep `prefill` around briefly so closing animation can still read it;
    // but we wipe on next open anyway. Simplest is to clear immediately.
    setPrefill(null);
  }, []);

  const value = useMemo(() => ({ open, prefill, openCompose, close }), [
    open,
    prefill,
    openCompose,
    close,
  ]);
  return <ComposeContext.Provider value={value}>{children}</ComposeContext.Provider>;
}

export function useCompose(): Ctx {
  const ctx = useContext(ComposeContext);
  if (!ctx) throw new Error("useCompose must be used within ComposeProvider");
  return ctx;
}
