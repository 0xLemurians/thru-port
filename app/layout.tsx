import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "thru-web — AlphaNet Onboarding & C Editor",
  description:
    "Browser-native Thru AlphaNet account onboarding, faucet access, and C template editing.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      {/*
        suppressHydrationWarning on <body>: some browser security extensions
        (e.g. antivirus tools) inject attributes like `bis_skin_checked` into
        the DOM before React hydrates. This is not an app bug — it's a known,
        documented false-positive case Next.js itself calls out. Suppressing
        it here only silences that specific mismatch; it does not hide real
        hydration bugs elsewhere in the tree.
      */}
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
