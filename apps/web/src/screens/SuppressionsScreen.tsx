import { SuppressionsTab } from "./settings/SuppressionsTab";

// Top-level Suppressions page. Same full-width chrome as Activity / Templates
// so the data-heavy screens share one visual width.
export function SuppressionsScreen() {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-6">
        <h1 className="mb-4 text-lg font-medium">Suppressions</h1>
        <SuppressionsTab />
      </div>
    </div>
  );
}
