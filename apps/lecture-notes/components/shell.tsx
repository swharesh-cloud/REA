"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <>
      <header className="topbar">
        <Link className="brand" href="/">
          Lecture Notes
        </Link>
        <nav aria-label="Primary">
          <Link href="/" aria-current={pathname === "/" ? "page" : undefined}>
            Record
          </Link>
          <Link
            href="/lectures"
            aria-current={pathname.startsWith("/lectures") ? "page" : undefined}
          >
            Library
          </Link>
        </nav>
      </header>
      <main className="main">{children}</main>
    </>
  );
}
