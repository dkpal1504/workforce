import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "./auth/AuthContext";
import { ThemeProvider } from "./theme/ThemeContext";
import { DEFAULT_THEME, THEME_STORAGE_KEY, applyThemeToDocument, isThemeId } from "./theme/themes";
import { App } from "./App";
import "./styles/global.css";

try {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  applyThemeToDocument(isThemeId(stored) ? stored : DEFAULT_THEME);
} catch {
  applyThemeToDocument(DEFAULT_THEME);
}

const queryClient = new QueryClient();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ThemeProvider>
          <AuthProvider>
            <App />
          </AuthProvider>
        </ThemeProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>
);
