import type { Metadata } from 'next';
import './globals.css';
import Sidebar from '@/components/Sidebar';
import AppWalletProvider from '@/components/AppWalletProvider';

export const metadata: Metadata = {
  title: 'PocketChange | DeFi Arbitrage Vault',
  description: 'Turn your pocket change into institutional-grade arbitrage returns on Solana.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </head>
      <body suppressHydrationWarning>
        <AppWalletProvider>
          <Sidebar />
          <main style={{ marginLeft: "280px", padding: "32px", width: "calc(100% - 280px)", minHeight: "100vh" }}>
            {children}
          </main>
        </AppWalletProvider>
      </body>
    </html>
  );
}
