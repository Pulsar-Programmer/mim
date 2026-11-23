import type { Metadata, Viewport } from "next";
import { Figtree } from "next/font/google";
import localFont from "next/font/local";
import type { ReactNode } from "react";
import "./globals.css";

const body = Figtree({ subsets: ["latin"], variable: "--font-body" });
const pixel = localFont({ src: "./fonts/Minecraftia.ttf", variable: "--font-pixel" });

export const metadata: Metadata = {
  title: "MIM: Minecraft Installation Manager",
  description:
    "Create, link, and upgrade your Minecraft installations in one desktop app. Free for macOS, Windows, and Linux.",
  icons: { icon: "/img/icon.png", apple: "/img/icon.png" },
};

export const viewport: Viewport = { themeColor: "#17111f" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${body.variable} ${pixel.variable}`}>
      <body>{children}</body>
    </html>
  );
}
