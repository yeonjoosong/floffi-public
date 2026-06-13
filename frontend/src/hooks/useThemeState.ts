import { useEffect, useRef, useState } from "react";
import { applyTheme, loadTheme, saveTheme } from "../lib/theme";
import { getActiveWorkspaceID as getActiveWorkspaceIDLib } from "../lib/workspaces";
import type { ThemeMode, ThemeState } from "../lib/theme";

export function useThemeState() {
  const [themeState, setThemeState] = useState<ThemeState>(() => loadTheme());
  const mqRef = useRef<MediaQueryList | null>(null);

  useEffect(() => {
    applyTheme(themeState);
    saveTheme(themeState, getActiveWorkspaceIDLib());

    if (themeState.mode === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      mqRef.current = mq;
      const handler = () => applyTheme(themeState);
      mq.addEventListener("change", handler);
      return () => mq.removeEventListener("change", handler);
    }

    if (mqRef.current) {
      mqRef.current = null;
    }
  }, [themeState]);

  return {
    themeState,
    setThemeState,
    loadStoredTheme(workspaceId: string) {
      setThemeState(loadTheme(workspaceId));
    },
    handleThemeModeChange(mode: ThemeMode) {
      setThemeState((prev) => ({ ...prev, mode }));
    },
    handleAccentColorChange(color: string) {
      setThemeState((prev) => ({ ...prev, accentColor: color }));
    },
    handleKitschNameChange(name: string) {
      setThemeState((prev) => ({ ...prev, kitschName: name }));
    },
    handleKitschTextColorChange(color: string) {
      setThemeState((prev) => ({ ...prev, kitschTextColor: color }));
    },
    handleToyChassisColorChange(color: string) {
      setThemeState((prev) => ({ ...prev, toyChassisColor: color }));
    },
    handleBaseColorChange(color: string) {
      setThemeState((prev) => ({ ...prev, baseColor: color }));
    },
    handleTextColorChange(color: string) {
      setThemeState((prev) => ({ ...prev, textColor: color }));
    },
  };
}
