import type { Metadata, Viewport } from "next";
import { Noto_Sans_Mono } from "next/font/google";
import { PwaRegistration } from "@/components/PwaRegistration";
import { SKIN_INIT_SCRIPT } from "@/lib/skin";
import { THEME_INIT_SCRIPT } from "@/lib/theme";
import "katex/dist/katex.min.css";
import "@fontsource/fusion-pixel-12px-proportional-sc/400.css";
import "@fontsource/fusion-pixel-12px-monospaced-sc/400.css";
import "./globals.css";
import "./settings.css";
import "./sidebar.css";
import "./sidebar-menu.css";
import "./skin-pixel.css";

const notoSansMono = Noto_Sans_Mono({
  subsets: ["latin", "cyrillic"],
  variable: "--font-noto-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Pi Web",
  description: "Pi Web interface for the pi coding agent",
  applicationName: "Pi Web",
  icons: {
    icon: [
      {
        url: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
      },
    ],
    apple: [
      {
        url: "/icons/apple-touch-icon.png",
        sizes: "180x180",
        type: "image/png",
      },
    ],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Pi Web",
  },
  formatDetection: {
    telephone: false,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#1a1a1a" },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" translate="no" className={`${notoSansMono.variable} notranslate`} suppressHydrationWarning>
      <head>
        <link rel="manifest" href="/manifest.webmanifest" crossOrigin="use-credentials" />
        <meta name="google" content="notranslate" />
        {/* Runs before first paint. Some browser extensions rewrite head scripts after that
            (blank the body, add a src); theme and skin are already applied, so ignore the mismatch. */}
        <script
          suppressHydrationWarning
          dangerouslySetInnerHTML={{
            __html: THEME_INIT_SCRIPT + SKIN_INIT_SCRIPT,
          }}
        />
      </head>
      <body translate="no" className="notranslate" suppressHydrationWarning>
        {children}
        <PwaRegistration />
      </body>
    </html>
  );
}
