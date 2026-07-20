// Pre-paint theme bootstrap. Loaded as a plain <script src> from index.html
// (CSP `script-src 'self'` forbids inline scripts) BEFORE the module bundle,
// so the correct theme class is on <html> before first paint — no flash.
// Keep in sync with src/lib/theme.ts.
(function () {
  try {
    var stored = localStorage.getItem("theme");
    var theme = stored === "light" || stored === "dark" ? stored : "system";
    var dark =
      theme === "dark" ||
      (theme === "system" &&
        window.matchMedia("(prefers-color-scheme: dark)").matches);
    var root = document.documentElement;
    root.classList.toggle("dark", dark);
    // Native scrollbars / form controls follow the app theme, not the OS.
    root.style.colorScheme = dark ? "dark" : "light";
  } catch (e) {
    /* localStorage or matchMedia unavailable — leave the light default */
  }
})();
