// Route tree for the SPA. TanStack Router code-based API (no codegen plugin)
// since the route list is short and flat.
//
// Convention:
//   /                       → redirect to /inbox
//   /inbox                  → InboxScreen (the three-pane mail UI keeps its
//                              own internal thread selection in URL search
//                              params it already manages)
//   /activity               → redirect to /activity/sending
//   /activity/sending       → Emails table for outbound
//   /activity/receiving     → Emails table for inbound
//   /activity/metrics       → chart + rate cards
//   /templates              → TemplatesScreen
//   /suppressions           → SuppressionsScreen
//   /settings               → redirect to /settings/domains
//   /settings/<tab>         → SettingsScreen with the matching tab

import {
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  redirect,
} from "@tanstack/react-router";
import { AppShell } from "@/components/AppShell";

// Each screen is its own chunk. The shell (header, router, auth gate) stays in
// the entry bundle; opening Activity/Settings/Templates does not parse the
// inbox tree (or vice versa).
function RoutePending() {
  return (
    <div className="flex flex-1 items-center justify-center p-6 text-sm text-zinc-500">
      Loading…
    </div>
  );
}

const rootRoute = createRootRoute({
  // AppShell renders the header + Outlet; Outlet hosts the matched child route.
  component: () => (
    <AppShell>
      <Outlet />
    </AppShell>
  ),
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/inbox" });
  },
});

const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/inbox",
  component: lazyRouteComponent(
    () => import("@/screens/InboxScreen"),
    "InboxScreen",
  ),
});

const activityIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/activity",
  beforeLoad: () => {
    throw redirect({ to: "/activity/$tab", params: { tab: "sending" } });
  },
});

export type ActivityTab = "sending" | "receiving" | "metrics";

interface ActivitySearch {
  email?: string;
}

const activityTabRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/activity/$tab",
  component: lazyRouteComponent(
    () => import("@/screens/ActivityScreen"),
    "ActivityScreen",
  ),
  // `email` query param (selected outbound) survives refresh and is shareable.
  validateSearch: (raw: Record<string, unknown>): ActivitySearch => {
    const email = raw.email;
    return { email: typeof email === "string" ? email : undefined };
  },
});

const templatesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/templates",
  component: lazyRouteComponent(
    () => import("@/screens/TemplatesScreen"),
    "TemplatesScreen",
  ),
});

const suppressionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/suppressions",
  component: lazyRouteComponent(
    () => import("@/screens/SuppressionsScreen"),
    "SuppressionsScreen",
  ),
});

const settingsIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  beforeLoad: () => {
    throw redirect({ to: "/settings/$tab", params: { tab: "domains" } });
  },
});

export type SettingsTab = "domains" | "api-keys" | "webhooks" | "members";

const settingsTabRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/$tab",
  component: lazyRouteComponent(
    () => import("@/screens/SettingsScreen"),
    "SettingsScreen",
  ),
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  inboxRoute,
  activityIndexRoute,
  activityTabRoute,
  templatesRoute,
  suppressionsRoute,
  settingsIndexRoute,
  settingsTabRoute,
]);

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  defaultPendingComponent: RoutePending,
  defaultPendingMs: 100,
  defaultPendingMinMs: 200,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
