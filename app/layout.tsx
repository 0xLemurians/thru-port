import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Thru Port — AlphaNet Wallet & Token Studio",
  description:
    "Create a Thru AlphaNet wallet, manage tokens, and send testnet assets directly from your browser.",
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
