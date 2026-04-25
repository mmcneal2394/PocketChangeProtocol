import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://pcprotocol.dev"),
  title: "PocketChange Protocol",
  description:
    "PocketChange ($PCP) is the decentralized arbitrage protocol on Solana, with a live public site, backend proxy surface, and readiness dashboard.",
  openGraph: {
    title: "PocketChange Protocol",
    description:
      "PocketChange ($PCP) is the decentralized arbitrage protocol on Solana, with a live public site, backend proxy surface, and readiness dashboard.",
    url: "https://pcprotocol.dev",
    siteName: "PocketChange Protocol",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
