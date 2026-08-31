export type Theme = "light" | "dark";

export interface ThemeOption {
  id: Theme;
  label: string;
  hint: string;
  /** Swatch colours: background, surface, accent. */
  swatch: [string, string, string];
}

export const THEMES: ThemeOption[] = [
  {
    id: "light",
    label: "Paper",
    hint: "Linen and avocado.",
    swatch: ["#f2ece5", "#faf6f0", "#c0c26b"],
  },
  {
    id: "dark",
    label: "Ink",
    hint: "Plum and avocado.",
    swatch: ["#372f36", "#433a42", "#c0c26b"],
  },
];

/* Dusk was a third theme with its own palette, which is what made the same
 * card three different colours. It is gone; anyone left holding it lands on
 * dark, the one it was a variation of. */
const CLASSES = [...THEMES.map((t) => `theme-${t.id}`), "theme-dusk"];

const STORAGE_KEY = "theme";

/** What the page is showing right now, read from the class the boot script
 * (or a later choice) put on <html>. */
export function currentTheme(): Theme {
  const root = document.documentElement;
  const found = THEMES.find((t) => root.classList.contains(`theme-${t.id}`));
  return found?.id ?? "light";
}

export function setTheme(theme: Theme): void {
  const root = document.documentElement;
  root.classList.remove(...CLASSES);
  root.classList.add(`theme-${theme}`);
  localStorage.setItem(STORAGE_KEY, theme);

  // Keep the browser chrome in step with the page.
  const meta = document.querySelector('meta[name="theme-color"]');
  const option = THEMES.find((t) => t.id === theme);
  if (meta && option) meta.setAttribute("content", option.swatch[0]);
}

/** Toolbar button: step through the themes in order. */
export function cycleTheme(): Theme {
  const order = THEMES.map((t) => t.id);
  const next = order[(order.indexOf(currentTheme()) + 1) % order.length];
  setTheme(next);
  return next;
}
