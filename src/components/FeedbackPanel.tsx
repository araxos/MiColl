import { useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { MessageSquare, Send, Check, Copy, Bug, Lightbulb, MessageCircle } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { isTauri } from "@/lib/tauri";
import * as api from "@/api/library";
import { useAccent } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import { version as PKG_VERSION } from "../../package.json";

/**
 * Feedback is sent through Web3Forms, which turns a POST into an email.
 * That way no mail password is in the app and the email address isn't either,
 * only this key. Get the key at https://web3forms.com and paste it here.
 */
const WEB3FORMS_KEY = "d4d2466b-af4a-4b73-9749-9daa771514d1";

/**
 * Alternative: your own URL (Cloudflare Worker / Vercel function) that forwards the JSON.
 * Only used when WEB3FORMS_KEY is empty.
 * Body: { category: "bug" | "idea" | "other", message: string,
 *         contact?: string, version: string }
 */
const FEEDBACK_ENDPOINT = "";

/** Last fallback: a form in the browser (e.g. Google Form). */
const FEEDBACK_FORM_URL = "";

const CATEGORIES = [
  { key: "bug", label: "Something's broken", Icon: Bug },
  { key: "idea", label: "An idea", Icon: Lightbulb },
  { key: "other", label: "Something else", Icon: MessageCircle },
] as const;

type Category = (typeof CATEGORIES)[number]["key"];

const MAX = 4000;

/**
 * Settings section to send feedback without an account.
 * Only the message, the category and the MiColl version are sent, no library data.
 */
export function FeedbackPanel() {
  const t = useT();
  const [category, setCategory] = useState<Category>("idea");
  const [message, setMessage] = useState("");
  const [contact, setContact] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const text = message.trim();

  // frosted glass on iridescent
  const irid = useAccent() === "iridescent";
  const chip = irid
    ? "border-white/20 bg-white/10 text-zinc-100 hover:bg-white/20"
    : "border-zinc-700 bg-zinc-900 text-zinc-300 micoll-hover";
  const field = irid
    ? "border-white/20 bg-white/10 text-zinc-50 backdrop-blur-md placeholder:text-zinc-300 focus:border-white/40"
    : "border-zinc-700 bg-zinc-950 text-zinc-100 placeholder:text-zinc-600 focus:border-brand-500/60";

  const send = async () => {
    if (!text) return;
    setErr(null);

    if (!WEB3FORMS_KEY && !FEEDBACK_ENDPOINT) {
      if (FEEDBACK_FORM_URL) {
        void api.openUrl(FEEDBACK_FORM_URL);
        return;
      }
      setErr(t("There's no feedback address set up yet — copy your message so it isn't lost."));
      return;
    }

    setBusy(true);
    try {
      const version = isTauri() ? await getVersion().catch(() => PKG_VERSION) : PKG_VERSION;
      const label = CATEGORIES.find((c) => c.key === category)?.label ?? category;
      const payload = WEB3FORMS_KEY
        ? {
            access_key: WEB3FORMS_KEY,
            // subject line = category + version
            subject: `MiColl feedback — ${label} (v${version})`,
            from_name: "MiColl",
            message: text,
            category,
            version,
            contact: contact.trim() || "(none — anonymous)",
          }
        : { category, message: text, contact: contact.trim() || undefined, version };

      const res = await fetch(WEB3FORMS_KEY ? "https://api.web3forms.com/submit" : FEEDBACK_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      // Web3Forms returns 200 with success: false on a bad key, so check the body too
      if (WEB3FORMS_KEY) {
        const body = (await res.json()) as { success?: boolean; message?: string };
        if (!body.success) throw new Error(body.message || "the form service rejected it");
      }
      setSent(true);
      setMessage("");
      setContact("");
    } catch (e) {
      setErr(`${e}`);
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard failed, nothing to say */
    }
  };

  return (
    <div>
      <h2 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-zinc-50">
        <MessageSquare className="h-6 w-6 text-brand-300" />
        {t("Feedback")}
      </h2>
      <p className="settings-desc mt-1 text-sm text-zinc-400">
        {t(
          "Tell me what’s broken or what you’d like MiColl to do. No account, no email address, no sign-in — the message is all that’s sent.",
        )}
      </p>

      {sent ? (
        <div className="mt-4 flex items-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-4 text-sm text-emerald-200">
          <Check className="h-4 w-4 shrink-0" />
          {t("Thanks — it arrived. Nothing about you was sent with it.")}
          <button
            onClick={() => setSent(false)}
            className="ml-auto text-emerald-300 underline decoration-emerald-500/50 underline-offset-2 hover:text-emerald-100"
          >
            {t("Write another")}
          </button>
        </div>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap gap-2">
            {CATEGORIES.map((c) => (
              <button
                key={c.key}
                onClick={() => setCategory(c.key)}
                className={cn(
                  "inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-sm transition-colors",
                  category === c.key
                    ? irid
                      ? "border-white/45 bg-white/25 text-white backdrop-blur-md"
                      : "border-brand-500/50 bg-brand-500/15 text-brand-100"
                    : chip,
                )}
              >
                <c.Icon className="h-4 w-4" />
                {t(c.label)}
              </button>
            ))}
          </div>

          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value.slice(0, MAX))}
            rows={5}
            placeholder={t("What happened, or what would you like to see?")}
            className={cn("mt-3 w-full resize-y rounded-xl border p-3 text-sm outline-none", field)}
          />
          {/* lighter text on iridescent */}
          <div className={cn("mt-1 text-right text-xs", irid ? "text-white/75" : "text-zinc-600")}>
            {message.length}/{MAX}
          </div>

          <label className="mt-2 block">
            <span className="text-xs text-zinc-400">
              {t("Somewhere to reply — optional. Leave it empty to stay anonymous.")}
            </span>
            <input
              value={contact}
              onChange={(e) => setContact(e.target.value)}
              placeholder={t("Discord tag, email… or nothing at all")}
              className={cn("mt-1 h-9 w-full rounded-lg border px-2.5 text-sm outline-none", field)}
            />
          </label>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button variant="primary" onClick={() => void send()} disabled={!text || busy}>
              <Send className="h-4 w-4" />
              {busy ? t("Sending…") : t("Send feedback")}
            </Button>
            <Button variant="outline" onClick={() => void copy()} disabled={!text}>
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              {copied ? t("Copied") : t("Copy instead")}
            </Button>
          </div>

          {err && <p className="mt-3 text-sm text-rose-300">{err}</p>}

          <p className="settings-desc mt-3 text-xs text-zinc-500">
            Sent with your message: which of the three buttons you picked, and the MiColl version —
            so a bug report says which build it came from. Nothing else. Not your name, not your
            library, not a single creator or file name. MiColl has no account system and no
            analytics, and this is the only thing in the app that ever leaves your machine. It’s
            delivered by a form service that turns the message into an email — so it travels through
            them, carrying only what’s listed above.
          </p>
        </>
      )}
    </div>
  );
}
