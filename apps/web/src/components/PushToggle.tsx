import { useQuery } from "@tanstack/react-query";
import { Bell, BellOff } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/api";
import { FOCUS_RING } from "@/components/ui";
import { cn } from "@/lib/utils";

function urlBase64ToUint8Array(value: string) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Header toggle for Web Push. Hidden unless the browser supports it and the
 * deployment has VAPID keys; the service worker is registered in main.tsx.
 */
export function PushToggle() {
  const key = useQuery({ queryKey: ["push-key"], queryFn: api.getPushKey });
  const [supported, setSupported] = useState(false);
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
    setSupported(true);
    let cancelled = false;
    navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => {
        if (!cancelled) setSubscribed(Boolean(sub));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  if (!supported || key.data?.enabled !== true) return null;

  async function enable() {
    setBusy(true);
    try {
      const permission =
        Notification.permission === "granted"
          ? "granted"
          : await Notification.requestPermission();
      if (permission !== "granted") {
        throw new Error("Notification permission was denied.");
      }
      const publicKey = key.data?.public_key;
      if (!publicKey) throw new Error("Push is not configured.");

      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
      const json = subscription.toJSON() as {
        endpoint?: string;
        expirationTime?: number | null;
        keys?: { p256dh?: string; auth?: string };
      };
      if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
        throw new Error("The browser returned an incomplete subscription.");
      }
      await api.subscribePush({
        endpoint: json.endpoint,
        expirationTime: json.expirationTime ?? null,
        keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
      });
      setSubscribed(true);
    } catch (err) {
      console.warn("push subscribe failed", err);
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        const endpoint = subscription.endpoint;
        await subscription.unsubscribe();
        await api.unsubscribePush(endpoint);
      }
      setSubscribed(false);
    } catch (err) {
      console.warn("push unsubscribe failed", err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={subscribed ? disable : enable}
      disabled={busy}
      title={subscribed ? "Disable notifications" : "Enable notifications"}
      aria-label={subscribed ? "Disable notifications" : "Enable notifications"}
      className={cn(
        "inline-flex items-center gap-1 rounded p-1 hover:bg-zinc-200 disabled:opacity-50 dark:hover:bg-zinc-800",
        FOCUS_RING,
      )}
    >
      {subscribed ? (
        <Bell className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
      ) : (
        <BellOff className="h-3.5 w-3.5" />
      )}
    </button>
  );
}
