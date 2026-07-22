import { NavLink, Route, Routes } from "react-router-dom";
import { Dashboard } from "./pages/Dashboard";
import { HostDetail } from "./pages/HostDetail";

export default function App() {
  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>Lab Monitor</h1>
        <nav className="app-nav">
          <NavLink to="/" end>
            Dashboard
          </NavLink>
          {/*
            Sibling task: add two more entries here, e.g.
            <NavLink to="/install">Remote Install</NavLink>
            <NavLink to="/settings">Settings</NavLink>
          */}
        </nav>
      </header>

      <main className="app-main">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/hosts/:id" element={<HostDetail />} />
          {/*
            Sibling task: add two more routes here, e.g.
            <Route path="/install" element={<RemoteInstall />} />
            <Route path="/settings" element={<Settings />} />
          */}
        </Routes>
      </main>
    </div>
  );
}
