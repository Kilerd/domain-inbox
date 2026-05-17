import { Paperclip, X } from "lucide-react";
import { useRef, useState } from "react";
import { cn } from "@/lib/utils";

export interface ComposeAttachment {
  filename: string;
  content: string; // base64 string (no data: prefix)
  content_type: string;
  size_bytes: number;
}

const MAX_SINGLE_BYTES = 5 * 1024 * 1024; // 5 MiB per file
const MAX_TOTAL_BYTES = 20 * 1024 * 1024; // 20 MiB combined

function arrayBufferToBase64(buf: ArrayBuffer): string {
  // Chunk to avoid call-stack issues on large files.
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + chunk)),
    );
  }
  return btoa(binary);
}

async function readFile(file: File): Promise<ComposeAttachment> {
  const buf = await file.arrayBuffer();
  return {
    filename: file.name,
    content: arrayBufferToBase64(buf),
    content_type: file.type || "application/octet-stream",
    size_bytes: file.size,
  };
}

interface Props {
  attachments: ComposeAttachment[];
  onChange: (next: ComposeAttachment[]) => void;
}

export function AttachmentDropzone({ attachments, onChange }: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function addFiles(files: FileList | File[]) {
    setErr(null);
    const accepted: ComposeAttachment[] = [];
    let currentTotal = attachments.reduce((n, a) => n + a.size_bytes, 0);
    for (const f of Array.from(files)) {
      if (f.size > MAX_SINGLE_BYTES) {
        setErr(`${f.name} exceeds 5 MiB per-file limit`);
        continue;
      }
      if (currentTotal + f.size > MAX_TOTAL_BYTES) {
        setErr(`total attachments would exceed 20 MiB`);
        continue;
      }
      const att = await readFile(f);
      accepted.push(att);
      currentTotal += f.size;
    }
    if (accepted.length) onChange([...attachments, ...accepted]);
  }

  function remove(idx: number) {
    onChange(attachments.filter((_, i) => i !== idx));
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <span className="block text-[11px] font-medium uppercase tracking-wide text-zinc-500">
          Attachments
        </span>
        <span className="text-[10px] text-zinc-500">5 MiB/file · 20 MiB total</span>
      </div>
      <div
        onDragEnter={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer.files?.length) {
            void addFiles(e.dataTransfer.files);
          }
        }}
        className={cn(
          "mt-1 rounded-md border border-dashed px-3 py-2 text-xs transition-colors",
          dragOver
            ? "border-blue-500 bg-blue-50 dark:bg-blue-950/40"
            : "border-zinc-300 dark:border-zinc-700",
        )}
      >
        {attachments.length === 0 ? (
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="block w-full text-center text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
          >
            <Paperclip className="mr-1 inline h-3 w-3" />
            Drop files here, or click to browse
          </button>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {attachments.map((a, i) => (
              <span
                key={i}
                className="inline-flex max-w-[200px] items-center gap-1 rounded bg-zinc-100 px-2 py-1 dark:bg-zinc-800"
              >
                <Paperclip className="h-3 w-3 shrink-0 text-zinc-500" />
                <span className="truncate" title={a.filename}>
                  {a.filename}
                </span>
                <span className="shrink-0 text-zinc-500">
                  ({Math.ceil(a.size_bytes / 1024)} KB)
                </span>
                <button
                  type="button"
                  onClick={() => remove(i)}
                  className="text-zinc-400 hover:text-red-600"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-1 rounded border border-zinc-200 px-2 py-1 text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              + add
            </button>
          </div>
        )}
      </div>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) void addFiles(e.target.files);
          e.target.value = "";
        }}
      />
      {err && <p className="mt-1 text-xs text-red-600">{err}</p>}
    </div>
  );
}
