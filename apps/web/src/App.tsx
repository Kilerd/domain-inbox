import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { api, ApiError } from "@/api";
import { ComposeDrawer } from "@/components/ComposeDrawer";
import { Button } from "@/components/ui";
import { ComposeProvider } from "@/lib/compose-store";
import { LoginScreen } from "@/screens/LoginScreen";
import { router } from "@/routes";

const qc = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => {
        // Don't retry auth failures — we want to fall through to LoginScreen fast.
        if (error instanceof ApiError && error.status === 401) return false;
        return failureCount < 2;
      },
    },
  },
});

export function App() {
  return (
    <QueryClientProvider client={qc}>
      <ComposeProvider>
        <AuthGate />
        <ComposeDrawer />
      </ComposeProvider>
    </QueryClientProvider>
  );
}

function AuthGate() {
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });

  if (me.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-50 text-sm text-zinc-500 dark:bg-zinc-950">
        Loading…
      </div>
    );
  }
  if (me.error) {
    // Only a real 401 means "logged out". Anything else (500s, network
    // failures) gets a retry screen so transient outages don't masquerade
    // as a logout.
    if (me.error instanceof ApiError && me.error.status === 401) {
      return <LoginScreen />;
    }
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-zinc-50 dark:bg-zinc-950">
        <p className="text-sm text-zinc-500">Can&apos;t reach server.</p>
        <Button
          variant="secondary"
          onClick={() => me.refetch()}
          disabled={me.isFetching}
        >
          {me.isFetching ? "Retrying…" : "Retry"}
        </Button>
      </div>
    );
  }
  if (!me.data) {
    return <LoginScreen />;
  }
  return <RouterProvider router={router} />;
}
