"use client";

// Dark mode switch for the staff and eval pages. Shares the chat's saved display prefs.

import { useEffect, useState } from "react";
import Icon from "./Icon";

const PREFS_KEY = "bsd-prefs";

function readPrefs(): Record<string, unknown> {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
  } catch {
    return {};
  }
}

export default function ThemeToggle() {
  const [dark, setDark] = useState(false);

  useEffect(() => setDark(!!readPrefs().darkMode), []);

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }, [dark]);

  const toggle = () => {
    const next = !dark;
    setDark(next);
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ ...readPrefs(), darkMode: next }));
    } catch {
      /* storage unavailable (private mode) — fine */
    }
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={dark}
      className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-border px-3 text-sm hover:bg-surface-2"
    >
      <Icon name={dark ? "sun" : "moon"} className="size-4" />
      {dark ? "Light mode" : "Dark mode"}
    </button>
  );
}
