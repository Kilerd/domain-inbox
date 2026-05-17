import { TemplatesTab } from "./settings/TemplatesTab";

// Top-level Templates page. Wraps the existing tab content in the same
// full-width chrome that Activity uses, so the list screens feel consistent.
export function TemplatesScreen() {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-6">
        <h1 className="mb-4 text-lg font-medium">Templates</h1>
        <TemplatesTab />
      </div>
    </div>
  );
}
