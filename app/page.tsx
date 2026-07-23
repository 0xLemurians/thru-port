import AppFlow from "@/components/AppFlow";

export default function Home() {
  return (
    <main className="page">
      <header className="header">
        <span className="brand" aria-label="thru-web">
          <span className="brand-mark">t</span>
          thru-web
        </span>
        <span className="badge">ALPHANET · TESTNET</span>
      </header>

      <section className="hero">
        <p className="eyebrow">Browser-native · No CLI · No extensions</p>
        <h1>
          Create, fund, and start coding for <em>Thru</em> — from your browser
        </h1>
        <p>
          Generate or import an account locally, request AlphaNet test units,
          and explore C templates in a browser editor. Build and deploy are not
          connected yet.
        </p>
      </section>

      <AppFlow />

      <p className="footnote">
        This is Alphanet testnet. Test tokens have no monetary value and the
        network may be reset at any time.
      </p>
    </main>
  );
}
