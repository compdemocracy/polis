/*
 * The two themes the page offers, chosen by ?theme=light|dark: the package's
 * neutral theme (white ground, the look of datamapplot's maps) as it is, and
 * the dark theme derived from it at the host (theme-dark.js).
 */
import neutral from "../../client-topic-map/theme-neutral.js";
import { darkTheme } from "./theme-dark.js";

/* The theme when the address names none. */
export const DEFAULT_THEME = "dark";

const THEMES = { light: neutral, dark: darkTheme(neutral) };

export function themeName(name) {
  return Object.prototype.hasOwnProperty.call(THEMES, name) ? name : DEFAULT_THEME;
}

export function themeFor(name) {
  return THEMES[themeName(name)];
}

/* The custom properties the page's own chrome takes from the theme, as the
   host page of the prototype sets them. */
export function chromeProperties(theme) {
  return {
    "--ground": theme.ground,
    "--ink": theme.ink,
    "--ink-muted": theme.inkMuted,
    "--rule": theme.rule,
    "--font-family": theme.font.family,
    "--ui-size": theme.font.uiSizePx + "px",
    "--small-size": theme.font.smallSizePx + "px",
    "--selected-ground": theme.list.selectedGround,
    "--hover-ground": theme.list.hoverGround,
  };
}
