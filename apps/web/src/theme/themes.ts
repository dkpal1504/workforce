export type ThemeId = "harbor" | "atlas" | "daybreak" | "forge" | "nocturne";

export type ThemeMeta = {
  id: ThemeId;
  name: string;
  tagline: string;
};

export const THEMES: ThemeMeta[] = [
  { id: "harbor", name: "Harbor", tagline: "Teal steel — shipyard clarity" },
  { id: "atlas", name: "Atlas", tagline: "Sapphire graphite — ops dashboard" },
  { id: "daybreak", name: "Daybreak", tagline: "Olive mist — calm daylight" },
  { id: "forge", name: "Forge", tagline: "Ember stone — workshop warmth" },
  { id: "nocturne", name: "Nocturne", tagline: "Night watch — low-glare focus" },
];

export const DEFAULT_THEME: ThemeId = "harbor";
export const THEME_STORAGE_KEY = "workforce_theme";

export function isThemeId(value: string | null): value is ThemeId {
  return THEMES.some((t) => t.id === value);
}

export function applyThemeToDocument(theme: ThemeId) {
  document.documentElement.setAttribute("data-theme", theme);
}
