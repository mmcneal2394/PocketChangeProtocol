"use client";

import { usePathname } from "next/navigation";
import Sidebar from "./Sidebar";
import AppWalletProvider from "./AppWalletProvider";
import React from "react";

export default function AppWrapper({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isMarketing = pathname === "/";

  if (isMarketing) {
    return (
      <AppWalletProvider>
        <main>{children}</main>
      </AppWalletProvider>
    );
  }

  return (
    <AppWalletProvider>
      <Sidebar />
      <main style={{ marginLeft: "280px", padding: "32px", width: "calc(100% - 280px)", minHeight: "100vh" }}>
        {children}
      </main>
    </AppWalletProvider>
  );
}
