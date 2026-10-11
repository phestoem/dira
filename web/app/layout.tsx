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
      <body>{children}</body>
    </html>
  );
}
