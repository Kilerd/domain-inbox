import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { api } from "@/api";
import { ApiKeysTab } from "./settings/ApiKeysTab";
import { DomainsTab } from "./settings/DomainsTab";
import { MembersTab } from "./settings/MembersTab";
import { RulesTab } from "./settings/RulesTab";
import { WebhooksTab } from "./settings/WebhooksTab";
import { cn } from "@/lib/utils";

type Tab = "domains" | "rules" | "api-keys" | "webhooks" | "members";
const VALID_TABS: Tab[] = ["domains", "rules", "api-keys", "webhooks", "members"];

// Templates + Suppressions used to live here but are content/data screens
// rather than config knobs — promoted to top-level navbar in App.tsx.
const TABS: { id: Tab; label: string; ownerOnly?: boolean }[] = [
  { id: "domains", label: "Domains" },
  { id: "rules", label: "Rules" },
  { id: "api-keys", label: "API Keys" },
  { id: "webhooks", label: "Webhooks" },
  { id: "members", label: "Members", ownerOnly: true },
];

export function SettingsScreen() {
  const params = useParams({ from: "/settings/$tab" });
  const tab: Tab = (VALID_TABS as string[]).includes(params.tab)
    ? (params.tab as Tab)
    : "domains";

  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const isOwner = me.data?.role === "owner";
  const visible = TABS.filter((t) => !t.ownerOnly || isOwner);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl px-4 py-4 sm:px-6 sm:py-6">
        <h1 className="mb-4 text-lg font-medium">Settings</h1>
        <div className="mb-6 flex overflow-x-auto border-b border-zinc-200 dark:border-zinc-800">
          {visible.map((t) => (
            <Link
              key={t.id}
              to="/settings/$tab"
              params={{ tab: t.id }}
              className={cn(
                "shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors sm:px-4",
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
        {tab === "rules" && <RulesTab />}
        {tab === "api-keys" && <ApiKeysTab />}
        {tab === "webhooks" && <WebhooksTab />}
        {tab === "members" && <MembersTab />}
      </div>
    </div>
  );
}
