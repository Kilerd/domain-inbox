import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { api } from "@/api";
import { ApiKeysTab } from "./settings/ApiKeysTab";
import { DomainsTab } from "./settings/DomainsTab";
import { MembersTab } from "./settings/MembersTab";
import { WebhooksTab } from "./settings/WebhooksTab";
import { cn } from "@/lib/utils";

type Tab = "domains" | "api-keys" | "webhooks" | "members";
const VALID_TABS: Tab[] = ["domains", "api-keys", "webhooks", "members"];

// Templates + Suppressions used to live here but are content/data screens
// rather than config knobs — promoted to top-level navbar in App.tsx.
const TABS: { id: Tab; label: string; ownerOnly?: boolean }[] = [
  { id: "domains", label: "Domains" },
  { id: "api-keys", label: "API Keys" },
  { id: "webhooks", label: "Webhooks" },
  { id: "members", label: "Members", ownerOnly: true },
];

export function SettingsScreen() {
  const params = useParams({ from: "/settings/$tab" });
  const tab: Tab = (VALID_TABS as string[]).includes(params.tab)
    ? (params.tab as Tab)
    : "domains";

  // Owner-gated tabs: probe via the members endpoint, which 403s for non-owners.
  const ownerProbe = useQuery({
    queryKey: ["members-probe"],
    queryFn: () => api.listMembers().then(() => true).catch(() => false),
    staleTime: 5 * 60_000,
  });
  const isOwner = ownerProbe.data === true;
  const visible = TABS.filter((t) => !t.ownerOnly || isOwner);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-6">
        <h1 className="mb-4 text-lg font-medium">Settings</h1>
        <div className="mb-6 flex border-b border-zinc-200 dark:border-zinc-800">
          {visible.map((t) => (
            <Link
              key={t.id}
              to="/settings/$tab"
              params={{ tab: t.id }}
              className={cn(
                "border-b-2 px-4 py-2 text-sm font-medium transition-colors",
                tab === t.id
                  ? "border-blue-600 text-blue-700 dark:border-blue-500 dark:text-blue-300"
                  : "border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200",
              )}
            >
              {t.label}
            </Link>
          ))}
        </div>

        {tab === "domains" && <DomainsTab />}
        {tab === "api-keys" && <ApiKeysTab />}
        {tab === "webhooks" && <WebhooksTab />}
        {tab === "members" && <MembersTab />}
      </div>
    </div>
  );
}
