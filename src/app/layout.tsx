import type { Metadata } from 'next';
import './globals.css';
import AppWrapper from '@/components/AppWrapper';

export const metadata: Metadata = {
  metadataBase: new URL('https://pcprotocol.dev'),
  title: 'PocketChange | DeFi Arbitrage Vault',
  description: 'Turn your pocket change into institutional-grade arbitrage returns on Solana.',
  openGraph: {
    title: 'PocketChange | DeFi Arbitrage Vault',
    description: 'Turn your pocket change into institutional-grade arbitrage returns on Solana.',
    url: 'https://pcprotocol.dev',
    siteName: 'PocketChange Protocol',
    images: [
      {
        url: 'https://cdn.helius-rpc.com/cdn-cgi/image//https://ipfs.io/ipfs/QmQwvUsgwBUa8PmKhTUgG6o1LL8PvUuo7XtkcVBNtQqry4',
        width: 800,
        height: 600,
        alt: 'PocketChange Protocol Banner',
      },
    ],
    locale: 'en_US',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'PocketChange | DeFi Arbitrage Vault',
    description: 'Turn your pocket change into institutional-grade arbitrage returns on Solana.',
    images: ['https://cdn.helius-rpc.com/cdn-cgi/image//https://ipfs.io/ipfs/QmQwvUsgwBUa8PmKhTUgG6o1LL8PvUuo7XtkcVBNtQqry4'],
  },
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
        <AppWrapper>
            {children}
        </AppWrapper>
      </body>
    </html>
  );
}
