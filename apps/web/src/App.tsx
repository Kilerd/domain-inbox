import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { api, ApiError } from "@/api";
import { ComposeDrawer } from "@/components/ComposeDrawer";
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
      <div className="flex min-h-screen items-center justify-center text-sm text-zinc-500">
        loading…
      </div>
    );
  }
  if (me.error instanceof ApiError && me.error.status === 401) {
    return <LoginScreen />;
  }
  if (!me.data) {
    return <LoginScreen />;
  }
  return <RouterProvider router={router} />;
}
