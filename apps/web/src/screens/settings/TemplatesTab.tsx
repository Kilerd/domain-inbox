import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, FileText, Pencil, Plus, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { api, type Template, type TemplateRender } from "@/api";
import { Button, EmptyState, ErrorText, Input, Panel, Textarea } from "@/components/ui";

interface DraftForm {
  name: string;
  subject: string;
  html: string;
  text: string;
}

const EMPTY_DRAFT: DraftForm = { name: "", subject: "", html: "", text: "" };

export function TemplatesTab() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["templates"], queryFn: api.listTemplates });

  // editing === null  → no editor open
  // editing === "new" → create form
  // editing === id    → editing existing
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftForm>(EMPTY_DRAFT);
  const [err, setErr] = useState<string | null>(null);
  const [previewVarsRaw, setPreviewVarsRaw] = useState<string>("{}");
  const [preview, setPreview] = useState<TemplateRender | null>(null);

  function startCreate() {
    setEditing("new");
    setDraft(EMPTY_DRAFT);
    setPreview(null);
    setErr(null);
  }

  function startEdit(t: Template) {
    setEditing(t.id);
    setDraft({
      name: t.name,
      subject: t.subject ?? "",
      html: t.html ?? "",
      text: t.text ?? "",
    });
    setPreview(null);
    setErr(null);
  }

  function close() {
    setEditing(null);
    setPreview(null);
    setErr(null);
  }

  const saveMut = useMutation({
    mutationFn: async () => {
      const payload = {
        name: draft.name.trim(),
        subject: draft.subject || null,
        html: draft.html || null,
        text: draft.text || null,
      };
      if (editing === "new") return api.createTemplate(payload);
      if (editing) return api.updateTemplate(editing, payload);
      throw new Error("no editor state");
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["templates"] });
      close();
    },
    onError: (e: unknown) => setErr(String(e)),
  });

  const delMut = useMutation({
    mutationFn: (id: string) => api.deleteTemplate(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["templates"] }),
  });

  const previewMut = useMutation({
    mutationFn: async () => {
      if (!editing || editing === "new") throw new Error("save first to preview");
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(previewVarsRaw || "{}");
      } catch (e) {
        throw new Error("preview vars must be JSON: " + (e as Error).message);
      }
      return api.renderTemplate(editing, data);
    },
    onSuccess: (r) => setPreview(r),
    onError: (e: unknown) => setErr(String(e)),
  });

  const sortedTemplates = useMemo(
    () => list.data ?? [],
    [list.data],
  );

  return (
    <div className="space-y-4">
      <Panel
        title="Templates"
        description="Send-time substitution uses Mustache-style `{{var}}` (HTML-escaped in `html`) and `{{{var}}}` (raw). API: `POST /api/v1/emails { template: 'tpl_…', template_data: { … } }`."
      >
        <div className="mb-3 flex justify-end">
          <Button variant="primary" onClick={startCreate}>
            <Plus className="h-4 w-4" />
            <span className="ml-1">New template</span>
          </Button>
        </div>
        {list.isLoading && <p className="text-sm text-zinc-500">Loading…</p>}
        {sortedTemplates.length === 0 && !list.isLoading && (
          <EmptyState icon={FileText} className="py-6">No templates yet.</EmptyState>
        )}
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {sortedTemplates.map((t) => (
            <li key={t.id} className="flex items-start gap-3 py-2.5">
              <FileText className="mt-0.5 h-4 w-4 text-zinc-500" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{t.name}</p>
                <p className="mt-0.5 truncate text-xs text-zinc-500">
                  {t.subject || <em className="italic text-zinc-400">(no subject)</em>}
                </p>
                <p className="mt-0.5 text-[10px] font-mono text-zinc-400">{t.id}</p>
              </div>
              <Button variant="ghost" onClick={() => startEdit(t)}>
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  if (confirm(`Delete template "${t.name}"?`)) delMut.mutate(t.id);
                }}
                disabled={delMut.isPending}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      </Panel>

      {editing && (
        <Panel
          title={editing === "new" ? "New template" : "Edit template"}
          description={editing === "new" ? undefined : `id: ${editing}`}
        >
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-zinc-500">Name</label>
              <Button variant="ghost" onClick={close}>
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
            <Input
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              placeholder="welcome-email"
            />

            <label className="block text-xs font-medium text-zinc-500">Subject</label>
            <Input
              value={draft.subject}
              onChange={(e) => setDraft((d) => ({ ...d, subject: e.target.value }))}
              placeholder="Hi {{name}}, welcome to {{product}}"
            />

            <label className="block text-xs font-medium text-zinc-500">HTML body</label>
            <Textarea
              value={draft.html}
              onChange={(e) => setDraft((d) => ({ ...d, html: e.target.value }))}
              rows={8}
              placeholder="<p>Hello {{name}}!</p>"
              className="font-mono text-xs"
            />

            <label className="block text-xs font-medium text-zinc-500">Text body</label>
            <Textarea
              value={draft.text}
              onChange={(e) => setDraft((d) => ({ ...d, text: e.target.value }))}
              rows={4}
              placeholder="Hello {{name}}!"
              className="font-mono text-xs"
            />

            <div className="flex gap-2">
              <Button
                variant="primary"
                onClick={() => saveMut.mutate()}
                disabled={!draft.name.trim() || (!draft.html && !draft.text) || saveMut.isPending}
              >
                {saveMut.isPending ? "Saving…" : "Save"}
              </Button>
              {editing !== "new" && (
                <Button
                  variant="ghost"
                  onClick={() => previewMut.mutate()}
                  disabled={previewMut.isPending}
                >
                  <Eye className="h-3.5 w-3.5" />
                  <span className="ml-1">Preview</span>
                </Button>
              )}
            </div>
            {err && <ErrorText>{err}</ErrorText>}
          </div>

          {editing !== "new" && (
            <div className="mt-4 border-t border-zinc-200 pt-3 dark:border-zinc-800">
              <label className="block text-xs font-medium text-zinc-500">
                Preview variables (JSON)
              </label>
              <Textarea
                value={previewVarsRaw}
                onChange={(e) => setPreviewVarsRaw(e.target.value)}
                rows={3}
                className="mt-1 font-mono text-xs"
              />
              {preview && (
                <div className="mt-3 space-y-2 rounded-md bg-zinc-50 p-3 dark:bg-zinc-900/50">
                  <div>
                    <p className="text-xs font-medium text-zinc-500">Subject</p>
                    <p className="text-sm">{preview.subject ?? <em>—</em>}</p>
                  </div>
                  {preview.html && (
                    <div>
                      <p className="text-xs font-medium text-zinc-500">HTML</p>
                      <iframe
                        title="template-preview"
                        className="mt-1 w-full rounded border border-zinc-200 bg-white dark:border-zinc-700"
                        style={{ height: 220 }}
                        sandbox=""
                        srcDoc={preview.html}
                      />
                    </div>
                  )}
                  {preview.text && (
                    <div>
                      <p className="text-xs font-medium text-zinc-500">Text</p>
                      <pre className="whitespace-pre-wrap font-mono text-xs">
                        {preview.text}
                      </pre>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </Panel>
      )}
    </div>
  );
}
