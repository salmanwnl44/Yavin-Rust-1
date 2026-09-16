export function ActivityBar({
  activeTab,
  gitBadge = "",
  onSelectTab,
  onOpenSettings,
}: {
  activeTab: string;
  gitBadge?: string;
  onSelectTab: (tab: string) => void;
  onOpenSettings: () => void;
}) {
  const topTabs = [
    {
      id: "explorer",
      title: "Explorer (Ctrl+Shift+E)",
      icon: (
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
      ),
    },
    {
      id: "search",
      title: "Search (Ctrl+Shift+F)",
      icon: (
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.3-4.3" />
        </svg>
      ),
    },
    {
      id: "git",
      title: "Source Control (Ctrl+Shift+G)",
      badge: gitBadge,
      icon: (
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="18" cy="18" r="3" />
          <circle cx="6" cy="6" r="3" />
          <path d="M6 21V9a9 9 0 0 0 9 9" />
        </svg>
      ),
    },
    {
      id: "debug",
      title: "Run & Debug (Ctrl+Shift+D)",
      icon: (
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polygon points="6 3 20 12 6 21 6 3" />
        </svg>
      ),
    },
    {
      id: "extensions",
      title: "Extensions & Plugins (Ctrl+Shift+X)",
      icon: (
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="3" y="3" width="8" height="8" rx="1.5" />
          <rect x="13" y="3" width="8" height="8" rx="1.5" />
          <rect x="3" y="13" width="8" height="8" rx="1.5" />
          <rect x="13" y="13" width="8" height="8" rx="1.5" />
        </svg>
      ),
    },
  ];

  return (
    <aside className="flex w-12 flex-col items-center border-r border-[#151515] bg-[#000000] py-3 select-none shrink-0 z-10">
      {/* Top Nav Buttons */}
      <div className="flex flex-col items-center gap-1.5 w-full">
        {topTabs.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => onSelectTab(tab.id)}
              title={tab.title}
              className={`group relative flex size-10 items-center justify-center rounded-lg transition-all ${
                isActive
                  ? "text-white bg-[#0e0e0e]"
                  : "text-ink-3 hover:text-ink-2 hover:bg-[#080808]"
              }`}
            >
              {/* Active Pill Marker on Left */}
              {isActive && (
                <span className="absolute left-0 top-1/2 -translate-y-1/2 h-5 w-[2.5px] rounded-r bg-indigo-500 shadow-[0_0_8px_rgba(99,102,241,0.8)]" />
              )}
              {tab.icon}

              {/* Notification Badge */}
              {tab.badge && (
                <span className="absolute top-1 right-1 flex size-3.5 items-center justify-center rounded-full bg-indigo-600 text-[8.5px] font-bold text-white shadow-sm">
                  {tab.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Bottom Profile & Settings */}
      <div className="mt-auto flex flex-col items-center gap-1.5 w-full">
        <button
          onClick={onOpenSettings}
          title="Accounts"
          className="group relative flex size-10 items-center justify-center rounded-lg text-ink-3 hover:text-ink-2 hover:bg-[#080808] transition-all"
        >
          <div className="size-5 rounded-full bg-gradient-to-tr from-zinc-700 to-zinc-500 flex items-center justify-center text-[10px] font-bold text-white">
            S
          </div>
        </button>
        <button
          onClick={onOpenSettings}
          title="Settings (Ctrl+,)"
          className="group relative flex size-10 items-center justify-center rounded-lg text-ink-3 hover:text-white hover:bg-[#080808] transition-all"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </button>
      </div>
    </aside>
  );
}
