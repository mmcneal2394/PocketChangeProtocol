"use client";

import { usePathname } from "next/navigation";
import Sidebar from "./Sidebar";
import AppWalletProvider from "./AppWalletProvider";
<<<<<<< HEAD
import React, { useState } from "react";
import { Menu } from "@mui/icons-material";
=======
import React from "react";
>>>>>>> b98063db64e327d63401fc99bce9fd880aa4d97f

export default function AppWrapper({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isMarketing = pathname === "/";
<<<<<<< HEAD
  const [sidebarOpen, setSidebarOpen] = useState(false);
=======
>>>>>>> b98063db64e327d63401fc99bce9fd880aa4d97f

  if (isMarketing) {
    return (
      <AppWalletProvider>
        <main>{children}</main>
      </AppWalletProvider>
    );
  }

  return (
    <AppWalletProvider>
<<<<<<< HEAD
      <Sidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <main className="main-content" style={{ marginLeft: "280px", padding: "32px", width: "calc(100% - 280px)", minHeight: "100vh" }}>
        <div className="mobile-menu-btn" onClick={() => setSidebarOpen(true)} style={{ marginBottom: "16px" }}>
          <Menu />
        </div>
=======
      <Sidebar />
      <main style={{ marginLeft: "280px", padding: "32px", width: "calc(100% - 280px)", minHeight: "100vh" }}>
>>>>>>> b98063db64e327d63401fc99bce9fd880aa4d97f
        {children}
      </main>
    </AppWalletProvider>
  );
}
