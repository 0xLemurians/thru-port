export default function PortTokenLayout({
  sidebar,
  workspace,
}: {
  sidebar: React.ReactNode;
  workspace: React.ReactNode;
}) {
  return (
    <div className="pc-token-layout pc-token-layout-simplified">
      <aside className="pc-token-panel pc-token-sidebar">{sidebar}</aside>
      <main className="pc-token-panel pc-token-workspace">{workspace}</main>
    </div>
  );
}
