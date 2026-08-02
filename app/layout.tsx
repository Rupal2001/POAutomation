import type { Metadata } from "next";
import "./globals.css";
import Nav from "@/components/Nav";

export const metadata: Metadata = {
  title: "StyleFlow — Myntra Buying Operations",
  description: "Fashion demand forecasting, replenishment and purchase-order control.",
  icons: { icon: "/brand/myntra-mark.png", apple: "/brand/myntra-mark.png" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en-IN" data-scroll-behavior="smooth"><body className="font-body bg-paper text-ink">
    <a className="skip-link" href="#main-content">Skip to main content</a>
    <Nav/>
    <main id="main-content" className="app-main" tabIndex={-1}>{children}</main>
  </body></html>;
}
