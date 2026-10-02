/**
 * Applies the stored theme before first paint.
 *
 * This runs synchronously in <head>, ahead of React. Anything later produces a
 * flash of the wrong theme — a white rectangle in a dark room, on every page
 * load, which is the kind of detail people feel without being able to name.
 */
const THEME_SCRIPT = `
(function () {
  try {
    var stored = localStorage.getItem("velo-theme");
    if (stored === "light" || stored === "dark") {
      document.documentElement.setAttribute("data-theme", stored);
    }
    // No stored choice: the tokens follow prefers-color-scheme on their own.
  } catch (e) {
    // Private mode, blocked storage. The system preference still applies.
  }
})();
`;

export function ThemeScript() {
  // dangerouslySetInnerHTML is safe here: THEME_SCRIPT is a static, non-interpolated constant.
  return <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />;
}
