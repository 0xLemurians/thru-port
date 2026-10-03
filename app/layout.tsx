import type { Metadata } from "next";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import "./globals.css";
import { THRU_NETWORK } from "@/lib/thru/network";

export const metadata: Metadata = {
  title: `Thru Port — ${THRU_NETWORK.displayName} Wallet & Token Studio`,
  description:
    `Create a Thru ${THRU_NETWORK.displayName} wallet, manage tokens, and send testnet assets directly from your browser.`,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              try {
                var savedColor = localStorage.getItem("thru-port-color-mode");
                if (savedColor === "light") {
                  document.documentElement.setAttribute('data-theme', 'light');
                } else {
                  document.documentElement.setAttribute('data-theme', 'dark');
                }
              } catch (e) {}
            `,
          }}
        />
      </head>
      <body>
        {children}
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
