import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { Shell } from "../components/shell";
import "./globals.css";

export const metadata: Metadata = {
  title: "Lecture Notes",
  description:
    "Record a lecture in the browser, follow a near-live transcript, and keep organized AI notes.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#10140f",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
