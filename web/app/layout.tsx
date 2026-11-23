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

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#17111f" },
    { media: "(prefers-color-scheme: light)", color: "#fff6ea" },
  ],
};

// Runs before first paint so a saved or system theme never flashes the wrong colors.
const THEME = `(function(){var t;try{t=localStorage.getItem("mim-theme")}catch(e){}if(t!=="light"&&t!=="dark")t=matchMedia("(prefers-color-scheme: light)").matches?"light":"dark";document.documentElement.dataset.theme=t})()`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${body.variable} ${pixel.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
