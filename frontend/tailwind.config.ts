import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // ── Semantic theme tokens ──
        base:  "rgb(var(--base) / <alpha-value>)",
        s1:    "rgb(var(--s1)   / <alpha-value>)",
        s2:    "rgb(var(--s2)   / <alpha-value>)",
        s3:    "rgb(var(--s3)   / <alpha-value>)",
        bd:    "rgb(var(--bd)   / <alpha-value>)",
        t1:    "rgb(var(--t1)   / <alpha-value>)",
        t2:    "rgb(var(--t2)   / <alpha-value>)",
        t3:    "rgb(var(--t3)   / <alpha-value>)",
        ac: {
          DEFAULT: "rgb(var(--ac)    / <alpha-value>)",
          lo:      "rgb(var(--ac-lo) / <alpha-value>)",
          hi:      "rgb(var(--ac-hi) / <alpha-value>)",
        },
        // ── Semantic status colors (theme-aware) ──
        ok:   "rgb(var(--c-ok)   / <alpha-value>)",
        warn: "rgb(var(--c-warn) / <alpha-value>)",
        err:  "rgb(var(--c-err)  / <alpha-value>)",

        // ── Legacy palette ──
        chick:  { 50: "#fffdf4", 100: "#fff9da", 200: "#fff1a8", 300: "#ffe56f", 400: "#ffd94a" },
        spring: { 50: "#dcfce7", 100: "#86efac", 200: "#22c55e", 300: "#15803d" },
        orange: { 400: "#ff9d2e", 500: "#ff8a1d", 600: "#ff7a00" },
        ink:    { 900: "#5c4210", 700: "#7c642f", 500: "#9a8752" },
        surface: {
          950: "#080811", 900: "#0e0e1c", 800: "#14142a",
          700: "#1c1c35", 600: "#26263f", 500: "#32325a",
        },
      },
      boxShadow: {
        glow:     "0 0 32px rgb(var(--ac) / 0.35)",
        "glow-sm":"0 0 14px rgb(var(--ac) / 0.25)",
      },
      borderRadius: { "4xl": "2rem" },
      fontFamily: {
        sans: ["Verdana", '"Noto Sans KR"', "sans-serif"],
      },
    },
  },
  plugins: [],
} satisfies Config;
