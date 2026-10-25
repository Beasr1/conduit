import { HealthBadge } from "@/components/health-badge";

export function App() {
  return (
    <main className="shell">
      <header className="shell-header">
        <h1>Conduit</h1>
        <HealthBadge />
      </header>
      <p className="muted">Compose APIs into APIs.</p>
    </main>
  );
}
