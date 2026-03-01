import en from "./locales/en";
import ja from "./locales/ja";

export type AppLanguage = "en" | "ja";

const LANGUAGE_STORAGE_KEY = "matchup-coach-language";

export const COPY = {
  en,
  ja
} as const;

export function detectInitialLanguage(): AppLanguage {
  if (typeof window === "undefined") return "en";
  const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
  if (stored === "en" || stored === "ja") return stored;
  return window.navigator.language.toLowerCase().startsWith("ja") ? "ja" : "en";
}

export function persistLanguage(language: AppLanguage): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
}

export function formatTemplate(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(params[key] ?? `{${key}}`));
}
