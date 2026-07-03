import { Route, Routes } from "react-router-dom";
import NavBar from "./components/NavBar";
import SiteFooter from "./components/SiteFooter";
import DocsLayout from "./layouts/DocsLayout";
import CliPage from "./pages/docs/CliPage";
import GettingStartedPage from "./pages/docs/GettingStartedPage";
import GraphSpecPage from "./pages/docs/GraphSpecPage";
import HitlPage from "./pages/docs/HitlPage";
import ImplementationStatusPage from "./pages/docs/ImplementationStatusPage";
import McpPage from "./pages/docs/McpPage";
import NodeTypesPage from "./pages/docs/NodeTypesPage";
import ProgrammaticApiPage from "./pages/docs/ProgrammaticApiPage";
import ProvidersPage from "./pages/docs/ProvidersPage";
import SkillsPage from "./pages/docs/SkillsPage";
import ExamplesPage from "./pages/ExamplesPage";
import HomePage from "./pages/HomePage";

export default function App() {
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <NavBar />
      <main className="flex-1">
        <Routes>
          <Route index element={<HomePage />} />
          <Route path="examples" element={<ExamplesPage />} />
          <Route path="docs" element={<DocsLayout />}>
            <Route index element={<GettingStartedPage />} />
            <Route path="cli" element={<CliPage />} />
            <Route path="skills" element={<SkillsPage />} />
            <Route path="mcp" element={<McpPage />} />
            <Route path="examples" element={<ExamplesPage />} />
            <Route path="programmatic-api" element={<ProgrammaticApiPage />} />
            <Route path="hitl" element={<HitlPage />} />
            <Route path="providers" element={<ProvidersPage />} />
            <Route path="graph-spec" element={<GraphSpecPage />} />
            <Route path="node-types" element={<NodeTypesPage />} />
            <Route path="implementation-status" element={<ImplementationStatusPage />} />
          </Route>
        </Routes>
      </main>
      <SiteFooter />
    </div>
  );
}
