import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { CatalogContext, Layout, useLoad, ErrorBox, Empty } from "./shared";
import { Explorer } from "./Explorer";
import { CoursePage } from "./CoursePage";
import { Admin } from "./Admin";
import type { Catalog } from "./types";
import "./styles.css";
import { AuthContext } from "./auth";
function App() {
  const [password, setPassword] = useState("");
  const catalog = useLoad(async (signal) => {
    const response = await fetch("/catalog/index.json", { signal });
    if (!response.ok) throw new Error("The saved catalog could not be loaded.");
    return (await response.json()) as Catalog;
  }, "catalog");
  return (
    <AuthContext.Provider value={{ password, setPassword }}>
      <Layout>
        {catalog.error ? (
          <main className="shell page">
            <ErrorBox message={catalog.error} retry={catalog.retry} />
          </main>
        ) : !catalog.data ? (
          <main className="shell page" role="status">
            Loading the course catalog…
          </main>
        ) : (
          <CatalogContext.Provider value={catalog.data}>
            <Routes>
              <Route path="/" element={<Explorer />} />
              <Route path="/courses/:id" element={<CoursePage />} />
              <Route
                path="/admin"
                element={<Navigate to="/admin/sections" replace />}
              />
              <Route path="/admin/:collection" element={<Admin />} />
              <Route
                path="*"
                element={
                  <main className="shell page">
                    <Empty title="Page not found">
                      Use the course explorer to find your next class.
                    </Empty>
                  </main>
                }
              />
            </Routes>
          </CatalogContext.Provider>
        )}
      </Layout>
    </AuthContext.Provider>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
