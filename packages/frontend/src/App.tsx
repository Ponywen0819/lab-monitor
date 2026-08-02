import { NavLink, Route, Routes } from "react-router-dom";
import { Dashboard } from "./pages/Dashboard";
import { HostDetail } from "./pages/HostDetail";
import { RemoteInstall } from "./pages/RemoteInstall";
import { Settings } from "./pages/Settings";
import { useHosts } from "./ws/WsProvider";

export default function App() {
  const { forbidden } = useHosts();

  if (forbidden) {
    return (
      <div className="app-shell">
        <header className="app-header">
          <h1>Lab Monitor</h1>
        </header>
        <main className="app-main">
          <p className="empty-state">
            Access denied: this network isn't allowed to reach the collector. Contact whoever manages
            ALLOWED_CIDRS if you believe this is a mistake.
          </p>
        </main>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>Lab Monitor</h1>
        <nav className="app-nav">
          <NavLink to="/" end>
            Dashboard
          </NavLink>
          <NavLink to="/install">Remote Install</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
      </header>

      <main className="app-main">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/hosts/:id" element={<HostDetail />} />
          <Route path="/install" element={<RemoteInstall />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>
    </div>
  );
}
