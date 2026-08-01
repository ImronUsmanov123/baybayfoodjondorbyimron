import { useEffect, useState } from "react";
import { Download, X, Share, Plus } from "lucide-react";
import { useT } from "@/lib/i18n";
import {
  clearInstallPrompt,
  getInstallPrompt,
  isIosSafari,
  isStandalone,
  onInstallPrompt,
  type InstallPromptEvent,
} from "@/lib/install-prompt";

const DISMISSED_KEY = "osh.pwa.dismissed";

/**
 * Persistent "add to home screen" sheet.
 *
 * It docks to the bottom of the screen and stays there until the user either
 * installs the app or explicitly dismisses it — there is no auto-hide timer.
 */
export function InstallBanner() {
  const { t } = useT();
  const [deferred, setDeferred] = useState<InstallPromptEvent | null>(null);
  const [ios, setIos] = useState(false);
  const [dismissed, setDismissed] = useState(true);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (isStandalone()) return;
    let stored = false;
    try {
      stored = window.localStorage.getItem(DISMISSED_KEY) === "1";
    } catch {
      /* private mode */
    }
    if (stored) return;

    setDismissed(false);
    // The event may already have fired before this component mounted.
    setDeferred(getInstallPrompt());
    setIos(isIosSafari());
    // One frame later so the slide-up transition plays.
    const id = window.setTimeout(() => setMounted(true), 60);

    const off = onInstallPrompt((e) => setDeferred(e));
    return () => {
      window.clearTimeout(id);
      off();
    };
  }, []);

  const close = () => {
    setMounted(false);
    setDismissed(true);
    try {
      window.localStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      /* private mode */
    }
  };

  const install = async () => {
    if (!deferred) return;
    await deferred.prompt();
    await deferred.userChoice.catch(() => null);
    clearInstallPrompt();
    setDeferred(null);
    close();
  };

  if (dismissed || (!deferred && !ios)) return null;

  return (
    <div
      role="dialog"
      aria-live="polite"
      className={`fixed inset-x-0 bottom-0 z-[80] px-3 pb-3 pt-2 transition-transform duration-500 ${
        mounted ? "translate-y-0" : "translate-y-full"
      }`}
      style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))" }}
    >
      <div className="mx-auto max-w-md rounded-[1.75rem] bg-primary p-4 shadow-chunky ring-2 ring-amber/60">
        <div className="flex items-start gap-3">
          <div className="h-12 w-12 shrink-0 rounded-2xl bg-amber flex items-center justify-center">
            <Download className="h-6 w-6 text-amber-foreground" strokeWidth={2.5} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-base font-black leading-tight text-primary-foreground">
              {t("pwa_title")}
            </p>
            <p className="mt-1 text-xs font-semibold leading-snug text-primary-foreground/75">
              {ios && !deferred ? t("pwa_ios_hint") : t("pwa_body")}
            </p>
          </div>
          <button
            onClick={close}
            aria-label={t("cancel")}
            className="press h-9 w-9 shrink-0 rounded-full bg-primary-foreground/10 flex items-center justify-center"
          >
            <X className="h-4 w-4 text-primary-foreground" strokeWidth={3} />
          </button>
        </div>

        {ios && !deferred ? (
          <div className="mt-3 flex items-center justify-center gap-2 rounded-2xl bg-primary-foreground/10 px-3 py-2.5 text-[11px] font-bold text-primary-foreground">
            <Share className="h-4 w-4" strokeWidth={2.5} />
            <span>→</span>
            <Plus className="h-4 w-4" strokeWidth={2.5} />
            <span className="truncate">{t("pwa_install")}</span>
          </div>
        ) : (
          <button
            onClick={install}
            className="press mt-3 w-full rounded-2xl bg-amber py-3 text-sm font-black text-amber-foreground"
          >
            {t("pwa_install")}
          </button>
        )}
      </div>
    </div>
  );
}
