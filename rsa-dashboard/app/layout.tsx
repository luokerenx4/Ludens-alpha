import type { Metadata } from "next";
import "./globals.css";
import "@/components/observation-panel.css";
import "@/components/observation-media.css";
import { LocaleProvider } from "@/lib/locale";
export const metadata: Metadata = {
  title: "Ludens Console",
  description: "Frames, activity log and run performance in one local console.",
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="dark">
      <body><LocaleProvider>{children}</LocaleProvider></body>
    </html>
  );
}
