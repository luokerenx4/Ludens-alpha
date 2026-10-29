import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Ludens · 运行控制台",
  description: "画面、活动日志与运行性能，共用一个本地控制台。",
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" className="dark">
      <body>{children}</body>
    </html>
  );
}
