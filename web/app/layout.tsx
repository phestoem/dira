import type { Metadata } from "next";
import AppShell from "@/components/AppShell";
import BottomNav from "@/components/BottomNav";
import CommandBar from "@/components/CommandBar";
import "./globals.css";

export const metadata: Metadata = {
  title: "DIRA",
  description: "A context-first personal intelligence system",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="min-h-[100dvh] bg-[#0E0E0F] text-[#F5F3EE] antialiased">
        <AppShell>{children}</AppShell>
        <CommandBar />
        <BottomNav />
      </body>
    </html>
  );
}
