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
      <section
        className="pc-token-panel pc-token-workspace"
        aria-label="Token workspace"
      >
        {workspace}
      </section>
    </div>
  );
}
