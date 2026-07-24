export default function PortTokenLayout({
  sidebar,
  workspace,
  quickActions,
}: {
  sidebar: React.ReactNode;
  workspace: React.ReactNode;
  quickActions: React.ReactNode;
}) {
  return (
    <div className="pc-token-layout">
      <aside className="pc-token-panel pc-token-sidebar">{sidebar}</aside>
      <main className="pc-token-panel pc-token-workspace">{workspace}</main>
      <aside className="pc-token-panel pc-token-quick-actions">{quickActions}</aside>
    </div>
  );
}
