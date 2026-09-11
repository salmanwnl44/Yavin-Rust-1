// Sleek modern chevron
export function ChevronIcon({
  isExpanded,
  className = "size-3.5",
}: {
  isExpanded: boolean;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`${className} text-zinc-400 hover:text-zinc-200 transition-transform duration-150 ${
        isExpanded ? "rotate-90 text-zinc-200" : ""
      }`}
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

// Sleek rounded folder icon (Closed)
export function FolderClosedIcon({ name = "", className = "size-4" }) {
  const lower = name.toLowerCase();

  let badge = null;
  if (lower === "src") {
    badge = (
      <span className="absolute -bottom-0.5 -right-1 text-[8.5px] font-mono font-black text-amber-500 leading-none">
        &lt;&gt;
      </span>
    );
  } else if (lower === ".vscode") {
    badge = <span className="absolute -bottom-0.5 -right-0.5 size-1.5 rounded-full bg-blue-500" />;
  } else if (lower === "dist" || lower === "public") {
    badge = (
      <span className="absolute -bottom-0.5 -right-0.5 size-1.5 rounded-full bg-purple-400" />
    );
  } else if (lower === "node_modules") {
    badge = (
      <span className="absolute -bottom-0.5 -right-0.5 size-1.5 rounded-full bg-emerald-400" />
    );
  } else if (lower === "assets" || lower === "images" || lower === "styles" || lower === "icons") {
    badge = <span className="absolute -bottom-0.5 -right-0.5 size-1.5 rounded-full bg-cyan-400" />;
  } else if (lower === "crates") {
    badge = (
      <span className="absolute -bottom-0.5 -right-0.5 size-1.5 rounded-full bg-orange-500" />
    );
  } else if (lower === "tests" || lower === "test" || lower === "__tests__") {
    badge = (
      <span className="absolute -bottom-0.5 -right-0.5 size-1.5 rounded-full bg-yellow-400" />
    );
  }

  return (
    <div className="relative inline-flex items-center justify-center shrink-0">
      <svg viewBox="0 0 24 24" fill="none" className={className}>
        <path
          d="M3.75 6.75A2.25 2.25 0 0 1 6 4.5h3.19a2.25 2.25 0 0 1 1.59.66l1.06 1.06a.75.75 0 0 0 .53.22H18a2.25 2.25 0 0 1 2.25 2.25v9A2.25 2.25 0 0 1 18 20H6a2.25 2.25 0 0 1-2.25-2.25v-11z"
          fill="#3b82f6"
          fillOpacity="0.12"
          stroke="#60a5fa"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {badge}
    </div>
  );
}

// Sleek rounded folder icon (Open)
export function FolderOpenIcon({ name = "", className = "size-4" }) {
  const lower = name.toLowerCase();

  let badge = null;
  if (lower === "src") {
    badge = (
      <span className="absolute -bottom-0.5 -right-1 text-[8.5px] font-mono font-black text-amber-500 leading-none">
        &lt;&gt;
      </span>
    );
  } else if (lower === ".vscode") {
    badge = <span className="absolute -bottom-0.5 -right-0.5 size-1.5 rounded-full bg-blue-500" />;
  } else if (lower === "dist" || lower === "public") {
    badge = (
      <span className="absolute -bottom-0.5 -right-0.5 size-1.5 rounded-full bg-purple-400" />
    );
  } else if (lower === "node_modules") {
    badge = (
      <span className="absolute -bottom-0.5 -right-0.5 size-1.5 rounded-full bg-emerald-400" />
    );
  } else if (lower === "assets" || lower === "images" || lower === "styles" || lower === "icons") {
    badge = <span className="absolute -bottom-0.5 -right-0.5 size-1.5 rounded-full bg-cyan-400" />;
  } else if (lower === "crates") {
    badge = (
      <span className="absolute -bottom-0.5 -right-0.5 size-1.5 rounded-full bg-orange-500" />
    );
  } else if (lower === "tests" || lower === "test" || lower === "__tests__") {
    badge = (
      <span className="absolute -bottom-0.5 -right-0.5 size-1.5 rounded-full bg-yellow-400" />
    );
  }

  return (
    <div className="relative inline-flex items-center justify-center shrink-0">
      <svg viewBox="0 0 24 24" fill="none" className={className}>
        <path
          d="M3.75 7.5A2.25 2.25 0 0 1 6 5.25h3.19a2.25 2.25 0 0 1 1.59.66l1.06 1.06a.75.75 0 0 0 .53.22H18a2.25 2.25 0 0 1 2.25 2.25v1.5"
          stroke="#93c5fd"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M3.27 10.5h17.46a1.5 1.5 0 0 1 1.48 1.74l-1.35 6.75a2.25 2.25 0 0 1-2.2 1.81H5.34a2.25 2.25 0 0 1-2.2-1.81L1.79 12.24A1.5 1.5 0 0 1 3.27 10.5z"
          fill="#3b82f6"
          fillOpacity="0.22"
          stroke="#60a5fa"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {badge}
    </div>
  );
}

// 1. Python Icon (.py, .ipynb) - Sleek boundary/outline vector in Python colors
export function PythonIcon({ className = "size-4" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      {/* Top Snake Outline */}
      <path
        d="M11.9 2.5C7.8 2.5 8 4.3 8 4.3V6.2h4.3v.6H5.8S2.5 6.4 2.5 10.4s3.3 4 3.3 4h1.7v-2.2c0-2.4 2.1-2.4 2.1-2.4h5.2c2.4 0 2.4-2.2 2.4-2.2V4.3S17.4 2.5 11.9 2.5z"
        stroke="#38bdf8"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="9.5" cy="4.5" r="0.85" fill="#38bdf8" />

      {/* Bottom Snake Outline */}
      <path
        d="M12.1 21.5c4.1 0 3.9-1.8 3.9-1.8v-1.9h-4.3v-.6h6.5s3.3.4 3.3-3.6-3.3-4-3.3-4h-1.7v2.2c0 2.4-2.1 2.4-2.1 2.4H9.2c-2.4 0-2.4 2.2-2.4 2.2v3.5s-.2 1.8 5.3 1.8z"
        stroke="#facc15"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="14.5" cy="19.5" r="0.85" fill="#facc15" />
    </svg>
  );
}

// 2. C++ Icon (.cpp, .hpp, .cc, .cxx) - Pure vector C with dual ++
export function CppIcon({ className = "size-4" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path
        d="M10 6.5A5.5 5.5 0 1 0 10 17.5"
        stroke="#38bdf8"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      {/* Plus 1 */}
      <path d="M14.5 10v4M12.5 12h4" stroke="#0ea5e9" strokeWidth="1.8" strokeLinecap="round" />
      {/* Plus 2 */}
      <path d="M19.5 10v4M17.5 12h4" stroke="#0ea5e9" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

// 3. C Icon (.c, .h) - Pure vector C monogram
export function CIcon({ className = "size-4" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path
        d="M16 6.5A6.5 6.5 0 1 0 16 17.5"
        stroke="#60a5fa"
        strokeWidth="2.75"
        strokeLinecap="round"
      />
      <circle cx="16" cy="6.5" r="1" fill="#93c5fd" />
      <circle cx="16" cy="17.5" r="1" fill="#93c5fd" />
    </svg>
  );
}

// 4. C# Icon (.cs)
export function CSharpIcon({ className = "size-4" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path
        d="M11 6.5A5.5 5.5 0 1 0 11 17.5"
        stroke="#a855f7"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <path
        d="M15 10.5h5M14 13.5h5M16 9.5l-1 5M18.5 9.5l-1 5"
        stroke="#c084fc"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

// 5. Rust Icon (.rs)
export function RustIcon({ className = "size-4" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <circle cx="12" cy="12" r="7.5" stroke="#f97316" strokeWidth="1.75" />
      <circle cx="12" cy="12" r="3.5" fill="#ea580c" />
      <path
        d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 5l2 2"
        stroke="#f97316"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
      <path
        d="M10 10.5h2.5a1.5 1.5 0 0 1 0 3H10v-3zM12.5 13.5L14 16"
        stroke="#ffffff"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// 6. React Icon (.jsx, .tsx)
export function ReactIcon({ className = "size-4" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <ellipse cx="12" cy="12" rx="9" ry="3.5" stroke="#38bdf8" strokeWidth="1.6" />
      <ellipse
        cx="12"
        cy="12"
        rx="9"
        ry="3.5"
        stroke="#38bdf8"
        strokeWidth="1.6"
        transform="rotate(60 12 12)"
      />
      <ellipse
        cx="12"
        cy="12"
        rx="9"
        ry="3.5"
        stroke="#38bdf8"
        strokeWidth="1.6"
        transform="rotate(120 12 12)"
      />
      <circle cx="12" cy="12" r="2" fill="#38bdf8" />
    </svg>
  );
}

// 7. JavaScript Icon (.js, .mjs, .cjs)
export function JavaScriptIcon({ className = "size-4" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path
        d="M7 8v8a2.5 2.5 0 0 1-5 0M14 9.5c0-.8.7-1.5 1.5-1.5H19c.8 0 1.5.7 1.5 1.5v0c0 .8-.7 1.5-1.5 1.5h-2c-.8 0-1.5.7-1.5 1.5v0c0 .8.7 1.5 1.5 1.5h3.5c.8 0 1.5.7 1.5 1.5"
        stroke="#facc15"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// 8. TypeScript Icon (.ts, .mts, .cts)
export function TypeScriptIcon({ className = "size-4" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path
        d="M3 8h8M7 8v10M14 10.5c0-.8.7-1.5 1.5-1.5H18c.8 0 1.5.7 1.5 1.5v0c0 .8-.7 1.5-1.5 1.5h-1.5c-.8 0-1.5.7-1.5 1.5v0c0 .8.7 1.5 1.5 1.5H20c.8 0 1.5.7 1.5 1.5"
        stroke="#38bdf8"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// 9. Go Icon (.go)
export function GoIcon({ className = "size-4" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path
        d="M3 12c0-3.5 2.5-6 6-6 3 0 5 1.5 5.5 4H10M16 12a4 4 0 1 0 4 4v-4h-4"
        stroke="#06b6d4"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// 10. Java Icon (.java, .jar)
export function JavaIcon({ className = "size-4" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path
        d="M5 16c4 1.5 10 1.5 14 0M7 19c3 1 7 1 10 0M10 2c1 2-2 4 0 6M14 2c1 2-2 4 0 6M6 10h11a3 3 0 0 1 3 3v0a3 3 0 0 1-3 3H6"
        stroke="#ef4444"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

// 11. HTML Icon (.html, .htm)
export function HtmlIcon({ className = "size-4" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path
        d="M7.5 8L3.5 12l4 4M16.5 8l4 4-4 4M14 6l-4 12"
        stroke="#f97316"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// 12. CSS / SCSS / SASS Icon (.css, .scss, .sass, .less)
export function CssIcon({ className = "size-4" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path
        d="M10 4.5l-2 15M16 4.5l-2 15M5.5 9h14M4.5 15h14"
        stroke="#38bdf8"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// 13. JSON Icon (.json, .jsonc)
export function JsonIcon({ className = "size-4" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path
        d="M8.5 5.5c-2 0-3 1-3 3v2c0 1-.8 1.5-1.5 1.5 0 0 0 0 0 0 .7 0 1.5.5 1.5 1.5v2c0 2 1 3 3 3M15.5 5.5c2 0 3 1 3 3v2c0 1 .8 1.5 1.5 1.5 0 0 0 0 0 0-.7 0-1.5.5-1.5 1.5v2c0 2-1 3-3 3"
        stroke="#facc15"
        strokeWidth="2.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// 14. TOML Icon (.toml)
export function TomlIcon({ className = "size-4" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path
        d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"
        fill="#f59e0b"
        fillOpacity="0.18"
        stroke="#fbbf24"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="3" stroke="#fbbf24" strokeWidth="1.75" />
    </svg>
  );
}

// 15. YAML Icon (.yaml, .yml)
export function YamlIcon({ className = "size-4" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path
        d="M4 6l5 6v6M14 6l-5 6M15 12h5M15 15h3M15 9h4"
        stroke="#fb7185"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// 16. SQL / Database Icon (.sql, .db, .sqlite)
export function SqlIcon({ className = "size-4" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <ellipse cx="12" cy="5" rx="8" ry="3" stroke="#2dd4bf" strokeWidth="1.8" />
      <path d="M4 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5" stroke="#2dd4bf" strokeWidth="1.8" />
      <path d="M4 11v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6" stroke="#2dd4bf" strokeWidth="1.8" />
    </svg>
  );
}

// 17. Shell / Bash / PowerShell / Terminal Icon (.sh, .bash, .zsh, .ps1, .bat)
export function ShellIcon({ className = "size-4" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path
        d="M4 7l6 5-6 5M12 17h8"
        stroke="#4ade80"
        strokeWidth="2.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// 18. Docker Icon (Dockerfile, docker-compose.yml)
export function DockerIcon({ className = "size-4" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path
        d="M2 13.5c1-1 3-1 4.5 0 1.5 1 3.5 1 5 0 1.5-1 3.5-1 5 0 1.5 1 3.5 1 5 0M4 13.5C4 8 8 6 12 6c4 0 8 2 8 7.5"
        stroke="#38bdf8"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <rect x="7" y="8.5" width="2" height="2" fill="#38bdf8" />
      <rect x="10" y="8.5" width="2" height="2" fill="#38bdf8" />
      <rect x="13" y="8.5" width="2" height="2" fill="#38bdf8" />
      <rect x="10" y="6" width="2" height="2" fill="#38bdf8" />
    </svg>
  );
}

// 19. Markdown Icon (.md, .mdx)
export function MarkdownIcon({ className = "size-4" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path
        d="M4 16V8l3.5 4L11 8v8M16 11l2.5-3 2.5 3M18.5 8v8"
        stroke="#34d399"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// 20. PHP Icon (.php)
export function PhpIcon({ className = "size-4" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path
        d="M3 9h4a2.5 2.5 0 0 1 0 5H3V9zm0 5v4M12 9h4a2.5 2.5 0 0 1 0 5h-4V9zm0 5v4M21 9v9"
        stroke="#818cf8"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

// 21. Ruby Icon (.rb, Gemfile)
export function RubyIcon({ className = "size-4" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <polygon
        points="6 4 18 4 22 9 12 21 2 9"
        stroke="#f43f5e"
        strokeWidth="1.8"
        fill="#f43f5e"
        fillOpacity="0.15"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <line x1="2" y1="9" x2="22" y2="9" stroke="#f43f5e" strokeWidth="1.5" />
      <line x1="12" y1="21" x2="7" y2="9" stroke="#f43f5e" strokeWidth="1.5" />
      <line x1="12" y1="21" x2="17" y2="9" stroke="#f43f5e" strokeWidth="1.5" />
    </svg>
  );
}

// 22. Image / SVG Icon (.svg, .png, .jpg, .webp, .ico)
export function ImageIcon({ className = "size-4" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <rect x="3" y="3" width="18" height="18" rx="3" stroke="#e879f9" strokeWidth="1.8" />
      <circle cx="8.5" cy="8.5" r="1.75" fill="#f0abfc" />
      <polyline
        points="21 15 16 10 5 21"
        stroke="#e879f9"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// 23. Audio / Video Icon (.mp3, .mp4, .wav, .mkv)
export function MediaIcon({ className = "size-4" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <circle cx="12" cy="12" r="9" stroke="#a78bfa" strokeWidth="1.8" />
      <polygon points="10 8 16 12 10 16 10 8" fill="#c4b5fd" />
    </svg>
  );
}

// 24. Env / Key Icon (.env, .env.*)
export function EnvIcon({ className = "size-4" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <circle cx="8" cy="12" r="4" stroke="#facc15" strokeWidth="1.8" />
      <path d="M12 12h8M16 12v3M19 12v2" stroke="#facc15" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

// 25. Lockfile Icon (.lock)
export function LockIcon({ className = "size-4" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <rect
        width="13"
        height="10"
        x="5.5"
        y="10.5"
        rx="2"
        fill="#71717a"
        fillOpacity="0.2"
        stroke="#a1a1aa"
        strokeWidth="1.75"
      />
      <path
        d="M8.5 10.5V7a3.5 3.5 0 0 1 7 0v3.5"
        stroke="#d4d4d8"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
      <circle cx="12" cy="15.5" r="1.25" fill="#e4e4e7" />
    </svg>
  );
}

// 26. Git Icon (.gitignore, .gitattributes)
export function GitFileIcon({ className = "size-4" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <circle cx="18" cy="18" r="2.5" fill="#f43f5e" stroke="#fb7185" strokeWidth="1.75" />
      <circle cx="6" cy="6" r="2.5" fill="#f43f5e" stroke="#fb7185" strokeWidth="1.75" />
      <circle cx="6" cy="18" r="2.5" fill="#f43f5e" stroke="#fb7185" strokeWidth="1.75" />
      <path
        d="M6 8.5v7M8.5 6A9 9 0 0 1 18 15.5"
        stroke="#fb7185"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

// 27. Zip / Archive Icon (.zip, .tar, .gz, .7z)
export function ZipIcon({ className = "size-4" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path
        d="M6 3.75A2.25 2.25 0 0 0 3.75 6v12A2.25 2.25 0 0 0 6 20.25h12A2.25 2.25 0 0 0 20.25 18V6A2.25 2.25 0 0 0 18 3.75H6z"
        stroke="#f59e0b"
        strokeWidth="1.6"
      />
      <path
        d="M10 4v2h4V4M10 8v2h4V8M10 12v2h4v-2M11 16h2v3h-2z"
        stroke="#fbbf24"
        strokeWidth="1.5"
      />
    </svg>
  );
}

// 28. PDF Icon (.pdf)
export function PdfIcon({ className = "size-4" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path
        d="M6 3.75A2.25 2.25 0 0 0 3.75 6v12A2.25 2.25 0 0 0 6 20.25h12A2.25 2.25 0 0 0 20.25 18V9.56a2.25 2.25 0 0 0-.66-1.59l-4.56-4.56a2.25 2.25 0 0 0-1.59-.66H6z"
        stroke="#ef4444"
        strokeWidth="1.6"
      />
      <text x="7" y="16" fill="#ef4444" fontSize="6.5" fontWeight="bold" fontFamily="monospace">
        PDF
      </text>
    </svg>
  );
}

// 29. Vue Icon (.vue)
export function VueIcon({ className = "size-4" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <polygon points="12 21 2 4 6 4 12 14 18 4 22 4" fill="#41b883" />
      <polygon points="12 14 6 4 9 4 12 9 15 4 18 4" fill="#35495e" />
    </svg>
  );
}

// 30. Svelte Icon (.svelte)
export function SvelteIcon({ className = "size-4" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path
        d="M17 5.5c-2.5-2-7-1.5-8.5.5-2 2.5-1 6.5 1.5 8s6 4.5 4 7c-2 2.5-7 2-9 0"
        stroke="#ff3e00"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

// Default File Icon (Clean folded paper sheet)
export function DefaultFileIcon({ className = "size-4" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path
        d="M6 3.75A2.25 2.25 0 0 0 3.75 6v12A2.25 2.25 0 0 0 6 20.25h12A2.25 2.25 0 0 0 20.25 18V9.56a2.25 2.25 0 0 0-.66-1.59l-4.56-4.56a2.25 2.25 0 0 0-1.59-.66H6z"
        fill="#71717a"
        fillOpacity="0.1"
        stroke="#9ca3af"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <polyline
        points="14 3.75 14 9.5 19.75 9.5"
        stroke="#d1d5db"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M7.5 13.5h9M7.5 16.5h5" stroke="#6b7280" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

// Dynamic Dispatcher for Top 20+ Languages and Extensions
export function FileIcon({
  name,
  isDir,
  isExpanded,
  className = "size-4",
}: {
  name: string;
  isDir?: boolean;
  isExpanded?: boolean;
  className?: string;
}) {
  if (isDir) {
    return isExpanded ? (
      <FolderOpenIcon name={name} className={className} />
    ) : (
      <FolderClosedIcon name={name} className={className} />
    );
  }

  const lower = (name || "").toLowerCase();

  // Python & Notebooks
  if (lower.endsWith(".py") || lower.endsWith(".pyw") || lower.endsWith(".ipynb")) {
    return <PythonIcon className={className} />;
  }

  // C++
  if (
    lower.endsWith(".cpp") ||
    lower.endsWith(".cxx") ||
    lower.endsWith(".cc") ||
    lower.endsWith(".hpp") ||
    lower.endsWith(".hxx") ||
    lower.endsWith(".hh") ||
    lower.endsWith(".inl")
  ) {
    return <CppIcon className={className} />;
  }

  // C
  if (lower.endsWith(".c") || lower.endsWith(".h")) {
    return <CIcon className={className} />;
  }

  // C#
  if (lower.endsWith(".cs") || lower.endsWith(".csx")) {
    return <CSharpIcon className={className} />;
  }

  // Rust
  if (lower.endsWith(".rs")) {
    return <RustIcon className={className} />;
  }

  // React
  if (lower.endsWith(".jsx") || lower.endsWith(".tsx")) {
    return <ReactIcon className={className} />;
  }

  // JavaScript
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) {
    return <JavaScriptIcon className={className} />;
  }

  // TypeScript
  if (lower.endsWith(".ts") || lower.endsWith(".mts") || lower.endsWith(".cts")) {
    return <TypeScriptIcon className={className} />;
  }

  // Go
  if (lower.endsWith(".go")) {
    return <GoIcon className={className} />;
  }

  // Java & Kotlin
  if (
    lower.endsWith(".java") ||
    lower.endsWith(".jar") ||
    lower.endsWith(".class") ||
    lower.endsWith(".kt")
  ) {
    return <JavaIcon className={className} />;
  }

  // HTML
  if (lower.endsWith(".html") || lower.endsWith(".htm") || lower.endsWith(".xhtml")) {
    return <HtmlIcon className={className} />;
  }

  // CSS, SCSS, SASS, LESS
  if (
    lower.endsWith(".css") ||
    lower.endsWith(".scss") ||
    lower.endsWith(".sass") ||
    lower.endsWith(".less")
  ) {
    return <CssIcon className={className} />;
  }

  // JSON
  if (lower.endsWith(".json") || lower.endsWith(".jsonc") || lower.endsWith(".json5")) {
    return <JsonIcon className={className} />;
  }

  // TOML
  if (lower.endsWith(".toml")) {
    return <TomlIcon className={className} />;
  }

  // YAML
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) {
    return <YamlIcon className={className} />;
  }

  // SQL & Databases
  if (
    lower.endsWith(".sql") ||
    lower.endsWith(".db") ||
    lower.endsWith(".sqlite") ||
    lower.endsWith(".sqlite3")
  ) {
    return <SqlIcon className={className} />;
  }

  // Shell, Bash, PowerShell, Batch
  if (
    lower.endsWith(".sh") ||
    lower.endsWith(".bash") ||
    lower.endsWith(".zsh") ||
    lower.endsWith(".ps1") ||
    lower.endsWith(".bat") ||
    lower.endsWith(".cmd") ||
    lower.endsWith(".fish")
  ) {
    return <ShellIcon className={className} />;
  }

  // Docker
  if (lower === "dockerfile" || lower.includes("docker-compose") || lower === ".dockerignore") {
    return <DockerIcon className={className} />;
  }

  // Markdown
  if (lower.endsWith(".md") || lower.endsWith(".mdx") || lower.endsWith(".markdown")) {
    return <MarkdownIcon className={className} />;
  }

  // PHP
  if (lower.endsWith(".php") || lower.endsWith(".phtml")) {
    return <PhpIcon className={className} />;
  }

  // Ruby
  if (lower.endsWith(".rb") || lower.endsWith(".erb") || lower === "gemfile") {
    return <RubyIcon className={className} />;
  }

  // Vue & Svelte
  if (lower.endsWith(".vue")) return <VueIcon className={className} />;
  if (lower.endsWith(".svelte")) return <SvelteIcon className={className} />;

  // Images & SVGs
  if (
    lower.endsWith(".svg") ||
    lower.endsWith(".png") ||
    lower.endsWith(".jpg") ||
    lower.endsWith(".jpeg") ||
    lower.endsWith(".gif") ||
    lower.endsWith(".webp") ||
    lower.endsWith(".ico") ||
    lower.endsWith(".bmp")
  ) {
    return <ImageIcon className={className} />;
  }

  // Audio & Video
  if (
    lower.endsWith(".mp3") ||
    lower.endsWith(".wav") ||
    lower.endsWith(".ogg") ||
    lower.endsWith(".mp4") ||
    lower.endsWith(".mov") ||
    lower.endsWith(".mkv") ||
    lower.endsWith(".webm")
  ) {
    return <MediaIcon className={className} />;
  }

  // Env & Secrets
  if (lower.startsWith(".env")) {
    return <EnvIcon className={className} />;
  }

  // Git files
  if (
    lower.includes("git") ||
    lower === ".gitignore" ||
    lower === ".gitattributes" ||
    lower === ".gitmodules"
  ) {
    return <GitFileIcon className={className} />;
  }

  // Lockfiles
  if (
    lower.endsWith(".lock") ||
    lower === "package-lock.json" ||
    lower === "pnpm-lock.yaml" ||
    lower === "yarn.lock"
  ) {
    return <LockIcon className={className} />;
  }

  // PDFs & Archives
  if (lower.endsWith(".pdf")) return <PdfIcon className={className} />;
  if (
    lower.endsWith(".zip") ||
    lower.endsWith(".tar") ||
    lower.endsWith(".gz") ||
    lower.endsWith(".7z") ||
    lower.endsWith(".rar")
  ) {
    return <ZipIcon className={className} />;
  }

  return <DefaultFileIcon className={className} />;
}
