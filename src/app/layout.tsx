import type { Metadata, Viewport } from "next";
import { Cinzel, Geist, Geist_Mono } from "next/font/google";
import { Toaster } from "@/components/ui/toast";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
const cinzel = Cinzel({ variable: "--font-cinzel", subsets: ["latin"] });

export const metadata: Metadata = {
  title: { default: "CRM Orienta", template: "%s · CRM Orienta" },
  description: "Gestão comercial do Colégio Técnico Orienta",
  applicationName: "CRM Orienta",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { themeColor: "#021c37" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="pt-BR" className={`${geistSans.variable} ${geistMono.variable} ${cinzel.variable} h-full`}>
      <body className="min-h-full">
        <Toaster>{children}</Toaster>
      </body>
    </html>
  );
}
