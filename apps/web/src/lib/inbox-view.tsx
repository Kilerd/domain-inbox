import { createContext, useContext, useMemo, useReducer, type ReactNode } from "react";
import type { InboxView } from "@/api";

export interface ViewState {
  view: InboxView;
  domainId: string | null;
  aliasId: string | null;
  query: string;
}

type Action =
  | { type: "set-view"; view: InboxView }
  | { type: "set-domain"; domainId: string | null }
  | { type: "set-alias"; aliasId: string | null; domainId?: string }
  | { type: "set-query"; query: string }
  | { type: "reset" };

const INITIAL: ViewState = {
  view: "inbox",
  domainId: null,
  aliasId: null,
  query: "",
};

function reducer(state: ViewState, action: Action): ViewState {
  switch (action.type) {
    case "set-view":
      // Switching system view keeps the current domain scope but clears the
      // alias narrow-down — alias filter is more specific than view.
      return { ...state, view: action.view, aliasId: null };
    case "set-domain":
      // Switching domain resets alias; keeps current system view.
      return { ...state, domainId: action.domainId, aliasId: null };
    case "set-alias":
      return {
        ...state,
        domainId: action.domainId ?? state.domainId,
        aliasId: action.aliasId,
      };
    case "set-query":
      return { ...state, query: action.query };
    case "reset":
      return INITIAL;
  }
}

interface Ctx {
  state: ViewState;
  setView: (v: InboxView) => void;
  selectDomain: (id: string | null) => void;
  selectAlias: (id: string | null, domainId?: string) => void;
  setQuery: (q: string) => void;
  reset: () => void;
}

const InboxViewContext = createContext<Ctx | null>(null);

export function InboxViewProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, INITIAL);
  const value = useMemo<Ctx>(
    () => ({
      state,
      setView: (v) => dispatch({ type: "set-view", view: v }),
      selectDomain: (id) => dispatch({ type: "set-domain", domainId: id }),
      selectAlias: (id, domainId) => dispatch({ type: "set-alias", aliasId: id, domainId }),
      setQuery: (q) => dispatch({ type: "set-query", query: q }),
      reset: () => dispatch({ type: "reset" }),
    }),
    [state],
  );
  return <InboxViewContext.Provider value={value}>{children}</InboxViewContext.Provider>;
}

export function useInboxView(): Ctx {
  const ctx = useContext(InboxViewContext);
  if (!ctx) throw new Error("useInboxView must be used within InboxViewProvider");
  return ctx;
}
