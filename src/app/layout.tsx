import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import { AmbientThemeProvider } from "@/components/ambient-theme-provider";
import { AuthProvider } from "@/components/auth-provider";
import { SiteHeader } from "@/components/site-header";
import { SiteAmbient } from "@/components/site-ambient";
import { SuperAdminGate } from "@/components/superadmin-gate";
import { ThemeProvider } from "@/components/theme-provider";
import { getAmbientThemeSettings } from "@/lib/ambient-theme-store";

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

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const ambientThemeSettings = await getAmbientThemeSettings().catch(() => undefined)

  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <ThemeProvider>
          <AmbientThemeProvider initialState={ambientThemeSettings}>
            <div className="site-shell">
              <SiteAmbient />
              <div className="site-content">
                <AuthProvider>
                  <SiteHeader />
                  <SuperAdminGate>{children}</SuperAdminGate>
                </AuthProvider>
                <Toaster />
              </div>
            </div>
          </AmbientThemeProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
