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
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
