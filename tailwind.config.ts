import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#241821",
        paper: "#F7F7FA",
        ledger: "#8A123A",
        ledgerlight: "#A7194B",
        accent: "#FF3F6C",
        wheat: "#F29A52",
        ok: "#087A55",
        warn: "#A55B00",
        urgent: "#B42318",
        line: "#E9E5EA",
        plum: "#4A1835",
      },
      fontFamily: {
        display: ["var(--font-display)", "sans-serif"],
        body: ["var(--font-body)", "sans-serif"],
        mono: ["var(--font-mono)", "monospace"],
      },
    },
  },
  plugins: [],
};
export default config;
