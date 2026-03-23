"use client";

import { usePathname } from "next/navigation";
import Sidebar from "./Sidebar";
import AppWalletProvider from "./AppWalletProvider";
import React, { useState } from "react";
import { Menu } from "@mui/icons-material";

export default function AppWrapper({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isMarketing = pathname === "/";
  const [sidebarOpen, setSidebarOpen] = useState(false);

  if (isMarketing) {
    return (
      <AppWalletProvider>
        <main>{children}</main>
      </AppWalletProvider>
    );
  }

  return (
    <AppWalletProvider>
      <Sidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <main className="main-content" style={{ marginLeft: "280px", padding: "32px", width: "calc(100% - 280px)", minHeight: "100vh" }}>
        <div className="mobile-menu-btn" onClick={() => setSidebarOpen(true)} style={{ marginBottom: "16px" }}>
          <Menu />
        </div>
        {children}
      </main>
    </AppWalletProvider>
  );
}
