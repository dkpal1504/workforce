import { useEffect } from "react";
import { useTheme } from "../theme/ThemeContext";
import type { ThemeId } from "../theme/themes";
import "./ThemePanel.css";

export function ThemePanel() {
  const { theme, themes, setTheme, panelOpen, closePanel } = useTheme();

  useEffect(() => {
    if (!panelOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePanel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panelOpen, closePanel]);

  return (
    <>
      <div
        className={`theme-backdrop ${panelOpen ? "is-open" : ""}`}
        onClick={closePanel}
        aria-hidden={!panelOpen}
      />
      <aside
        className={`theme-panel ${panelOpen ? "is-open" : ""}`}
        aria-hidden={!panelOpen}
        aria-label="Theme panel"
      >
        <header className="theme-panel__header">
          <div>
            <p className="theme-panel__eyebrow">Appearance</p>
            <h2>Theme panel</h2>
            <p className="theme-panel__sub">Choose a look that fits the shift floor or the boardroom.</p>
          </div>
          <button type="button" className="theme-panel__close" onClick={closePanel} aria-label="Close theme panel">
            ×
          </button>
        </header>

        <div className="theme-panel__list">
          {themes.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`theme-card ${theme === t.id ? "is-active" : ""}`}
              onClick={() => setTheme(t.id as ThemeId)}
            >
              <span className="theme-card__swatches" data-preview={t.id} aria-hidden>
                <i style={{ background: "var(--preview-1)" }} />
                <i style={{ background: "var(--preview-2)" }} />
                <i style={{ background: "var(--preview-3)" }} />
              </span>
              <span className="theme-card__copy">
                <strong>{t.name}</strong>
                <span>{t.tagline}</span>
              </span>
              {theme === t.id && <span className="theme-card__check">Active</span>}
            </button>
          ))}
        </div>
      </aside>
    </>
  );
}
