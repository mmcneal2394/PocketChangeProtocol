import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://pcprotocol.dev"),
  title: "PocketChange Protocol",
  description:
    "PocketChange Protocol demo site for the Slopfest sniper, capital allocator, and arb scout stack.",
  openGraph: {
    title: "PocketChange Protocol",
    description:
      "PocketChange Protocol demo site for the Slopfest sniper, capital allocator, and arb scout stack.",
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
