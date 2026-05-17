import { Inbox, Mail } from "lucide-react";
import { useState } from "react";
import { api, ApiError } from "@/api";
import { Button, ErrorText, Input } from "@/components/ui";

export function LoginScreen() {
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const value = email.trim();
    if (!value) return;
    setSubmitting(true);
    setErr(null);
    try {
      await api.requestLogin(value);
      setSubmitted(value);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 px-4 dark:bg-zinc-950">
      <div className="w-full max-w-sm rounded-xl border border-zinc-200 bg-white p-8 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mb-6 flex items-center gap-2">
          <Inbox className="h-5 w-5 text-zinc-700 dark:text-zinc-300" />
          <span className="font-semibold">domain-inbox</span>
        </div>

        {!submitted ? (
          <>
            <h1 className="text-lg font-semibold">Sign in</h1>
            <p className="mt-1 text-sm text-zinc-500">
              We'll email you a one-time sign-in link.
            </p>
            <form className="mt-4 space-y-3" onSubmit={onSubmit}>
              <Input
                type="email"
                inputMode="email"
                autoFocus
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={submitting}
                required
              />
              <Button
                variant="primary"
                type="submit"
                disabled={submitting || !email.trim()}
                className="w-full"
              >
                {submitting ? "Sending…" : "Send sign-in link"}
              </Button>
            </form>
            {err && <ErrorText>{err}</ErrorText>}
          </>
        ) : (
          <>
            <Mail className="mx-auto h-10 w-10 text-blue-600 dark:text-blue-400" />
            <h1 className="mt-4 text-center text-lg font-semibold">
              Check your inbox
            </h1>
            <p className="mt-1 text-center text-sm text-zinc-500">
              If <code className="font-mono">{submitted}</code> is invited, a
              sign-in link has been sent. The link expires in 15 minutes.
            </p>
            <button
              type="button"
              onClick={() => {
                setSubmitted(null);
                setEmail("");
              }}
              className="mt-6 block w-full text-center text-sm text-zinc-500 hover:underline"
            >
              Use a different email
            </button>
          </>
        )}
      </div>
    </div>
  );
}
