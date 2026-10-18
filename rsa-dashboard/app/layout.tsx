import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "RSA · 观察台",
  description: "Recursive Self-Adaptation — 本地运行观察与调试",
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
