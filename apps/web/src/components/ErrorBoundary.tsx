import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * The LAST line of defence around a screen: a render error becomes a readable message instead of a
 * white page.
 *
 * WHY THIS EXISTS: a section that reads a field the server did not send throws DURING render, and
 * React then unmounts the whole tree — the operator sees a blank page with no way to tell whether
 * the app crashed, their session died, or the screen is merely empty. That happened here: an older
 * API (the dev server had not reloaded) omitted a new array, one `.length` threw, and the dashboard
 * went white. The real fix is to normalise the response where it is fetched; this boundary is the
 * safety net that makes the NEXT such mistake visible instead of silent.
 *
 * IT DOES NOT SWALLOW THE ERROR: the message names it, and the detail goes to the console with the
 * component stack for support. It also states that nothing was written, because a blank page after a
 * click reads as "did that save?" to a user.
 *
 * The parent gives it a `key` of the current path (see AppLayout), so navigating away clears the
 * error: a boundary that stayed in its failed state would make one bad screen poison the whole app.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep everything support needs in one console entry: the error, its stack, and where in the
    // tree it happened.
    console.error("[ui] this screen failed to render:", error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;

    return (
      <div className="error-banner" role="alert" style={{ margin: "24px 0" }}>
        <strong>This screen could not be drawn.</strong> It stopped while rendering, so nothing below
        it is shown. <em>Nothing was saved or changed.</em>
        <div style={{ marginTop: 8, fontFamily: "var(--font-mono, monospace)", fontSize: 13 }}>
          {this.state.error.message}
        </div>
        <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => this.setState({ error: null })}
          >
            Try again
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => window.location.reload()}>
            Reload the page
          </button>
        </div>
        <p className="muted" style={{ marginBottom: 0, marginTop: 10 }}>
          If it happens again, quote the message above — the browser console has the component
          stack, which is what identifies the section at fault.
        </p>
      </div>
    );
  }
}
