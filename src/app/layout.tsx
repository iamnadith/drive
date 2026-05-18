import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import { AuthProvider } from "@/components/auth-provider";
import { SuperAdminGate } from "@/components/superadmin-gate";
import { ThemeProvider } from "@/components/theme-provider";

const geistSans = Inter({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = JetBrains_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Cloud Storage Panel",
  description: "R2 Migration System & Control Plane",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <div className="site-shell">
          <div aria-hidden="true" className="site-ambient">
            <div className="site-ambient-orb site-ambient-orb-1" />
            <div className="site-ambient-orb site-ambient-orb-2" />
            <div className="site-ambient-orb site-ambient-orb-3" />
            <div className="site-ambient-orb site-ambient-orb-4" />
          </div>
          <div className="site-content">
            <ThemeProvider>
              <AuthProvider>
                <SuperAdminGate>{children}</SuperAdminGate>
              </AuthProvider>
              <Toaster />
            </ThemeProvider>
          </div>
        </div>
      </body>
    </html>
  );
}
