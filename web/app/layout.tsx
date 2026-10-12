import type { Metadata } from "next";
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
      <body className="min-h-[100dvh] bg-[#0E0E0F] text-[#F5F3EE] antialiased">{children}</body>
    </html>
  );
}
