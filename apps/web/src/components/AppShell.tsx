/**
 * Application chrome: the disclosure strip the demo must never lose, a
 * collapsible sidebar on desktop, a bottom tab bar on phones, and the footer.
 *
 * Page content renders through `<Outlet />`; nothing in here knows what a
 * page does.
 */
import { useCallback, useEffect, useState } from "react";
import {
  Bird,
  CalendarDays,
  ChevronsLeft,
  ChevronsRight,
  Home,
  Inbox,
  Radar,
  Sparkles,
  Table2,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { NavLink, Outlet } from "react-router-dom";
import { useDerived } from "@/api/useDerived.ts";
import { AskCanaryOrb } from "@/components/AskCanaryOrb.tsx";
import { MockBanner } from "@/components/MockBanner.tsx";
import { ProvenanceBanner } from "@/components/ProvenanceBanner.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/utils.ts";
import { useIsDesktop } from "@/lib/useMediaQuery.ts";

interface NavEntry {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Needs Review carries the size of its queue. */
  badge?: boolean;
}

const NAV: readonly NavEntry[] = [
  { to: "/", label: "Home", icon: Home },
  { to: "/incidents", label: "Incidents", icon: TriangleAlert },
  { to: "/ledger", label: "Ledger", icon: Table2 },
  { to: "/calendar", label: "Calendar", icon: CalendarDays },
  { to: "/needs-review", label: "Needs Review", icon: Inbox, badge: true },
  { to: "/scout", label: "Scout", icon: Radar },
];

export const SIDEBAR_STORAGE_KEY = "canary.sidebar";

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === "collapsed";
  } catch {
    // Private browsing / disabled storage: start expanded, just don't persist.
    return false;
  }
}

export function AppShell() {
  // Shares the cached request with whichever page is mounted.
  const { data, source, loading } = useDerived();
  const isDesktop = useIsDesktop();
  const [collapsed, setCollapsed] = useState(readCollapsed);

  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(SIDEBAR_STORAGE_KEY, next ? "collapsed" : "expanded");
      } catch {
        // Persisting is a nicety; the session still works without it.
      }
      return next;
    });
  }, []);

  const reviewCount = data?.needs_review.count ?? null;

  return (
    <div className="flex min-h-dvh flex-col">
      {data ? (
        <>
          <MockBanner provenance={data.provenance} source={source} />
          <ProvenanceBanner
            provenance={data.provenance}
            company={data.company}
            cashCents={data.cash_cents}
            refreshing={loading}
          />
        </>
      ) : (
        <div className="h-8 border-b border-neutral-200 bg-white/80" />
      )}

      <div className="flex flex-1">
        {isDesktop ? (
          <Sidebar collapsed={collapsed} onToggle={toggle} reviewCount={reviewCount} />
        ) : null}

        <div className="flex min-w-0 flex-1 flex-col">
          {isDesktop ? null : <MobileHeader />}

          <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:py-8">
            <Outlet />
          </main>

          <footer className="border-t border-neutral-200 bg-white">
            <p
              className={cn(
                "mx-auto max-w-6xl px-4 py-4 text-[11px] leading-relaxed text-neutral-400",
                // The footer is the last thing in the column, so its padding is
                // what keeps the fixed tab bar from covering content.
                isDesktop ? null : "pb-20",
              )}
            >
              Canary is a hackathon demo. Money math is deterministic; language models never compute
              financial figures.
            </p>
          </footer>
        </div>
      </div>

      {isDesktop ? null : <MobileTabBar reviewCount={reviewCount} />}
      <AskCanaryOrb />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Desktop
// ---------------------------------------------------------------------------

function Sidebar({
  collapsed,
  onToggle,
  reviewCount,
}: {
  collapsed: boolean;
  onToggle: () => void;
  reviewCount: number | null;
}) {
  return (
    <aside
      aria-label="Main navigation"
      data-collapsed={collapsed ? "true" : "false"}
      className={cn(
        "sticky top-0 flex h-dvh shrink-0 flex-col border-r border-neutral-200 bg-white transition-[width] duration-150 ease-out",
        collapsed ? "w-14" : "w-60",
      )}
    >
      <div
        className={cn(
          "flex h-14 items-center border-b border-neutral-100",
          collapsed ? "justify-center px-2" : "justify-between px-3",
        )}
      >
        {collapsed ? null : (
          <span className="flex items-center gap-2 overflow-hidden">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-canary-400">
              <Bird className="h-4 w-4 text-neutral-900" aria-hidden="true" />
            </span>
            <span className="truncate text-sm font-semibold tracking-tight text-neutral-900">Canary</span>
          </span>
        )}
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700"
        >
          {collapsed ? (
            <ChevronsRight className="h-4 w-4" aria-hidden="true" />
          ) : (
            <ChevronsLeft className="h-4 w-4" aria-hidden="true" />
          )}
        </button>
      </div>

      <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-2">
        {NAV.map((entry) => (
          <SidebarLink
            key={entry.to}
            entry={entry}
            collapsed={collapsed}
            count={entry.badge ? reviewCount : null}
          />
        ))}
      </nav>

      <div className="border-t border-neutral-100 p-2">
        <SidebarLink
          entry={{ to: "/ask", label: "Ask Canary", icon: Sparkles }}
          collapsed={collapsed}
          count={null}
        />
      </div>
    </aside>
  );
}

function SidebarLink({
  entry,
  collapsed,
  count,
}: {
  entry: NavEntry;
  collapsed: boolean;
  count: number | null;
}) {
  const Icon = entry.icon;

  const link = (
    <NavLink
      to={entry.to}
      // `end` keeps Home from matching every route.
      end={entry.to === "/"}
      className={({ isActive }) =>
        cn(
          "relative flex h-10 items-center rounded-lg text-sm font-medium transition-colors",
          collapsed ? "justify-center px-0" : "gap-2.5 px-2.5",
          isActive
            ? "bg-canary-50 text-neutral-900"
            : "text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900",
        )
      }
    >
      {({ isActive }) => (
        <>
          <Icon
            className={cn("h-4 w-4 shrink-0", isActive ? "text-canary-600" : null)}
            aria-hidden="true"
          />
          {collapsed ? (
            <span className="sr-only">{entry.label}</span>
          ) : (
            <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
              <span className="truncate">{entry.label}</span>
              {count !== null && count > 0 ? (
                <Badge variant="accent" aria-label={`${count} awaiting review`}>
                  {count}
                </Badge>
              ) : null}
            </span>
          )}
          {collapsed && count !== null && count > 0 ? (
            <span
              aria-label={`${count} awaiting review`}
              className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-canary-400"
            />
          ) : null}
        </>
      )}
    </NavLink>
  );

  if (!collapsed) return link;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="relative block">{link}</span>
      </TooltipTrigger>
      <TooltipContent side="right">
        {entry.label}
        {count !== null && count > 0 ? ` · ${count} awaiting review` : ""}
      </TooltipContent>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// Mobile
// ---------------------------------------------------------------------------

function MobileHeader() {
  return (
    <header className="border-b border-neutral-200 bg-white">
      <div className="flex items-center gap-2 px-4 py-3">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-canary-400">
          <Bird className="h-4 w-4 text-neutral-900" aria-hidden="true" />
        </span>
        <span className="text-sm font-semibold tracking-tight text-neutral-900">Canary</span>
        <NavLink
          to="/ask"
          aria-label="Ask Canary"
          className={({ isActive }) =>
            cn(
              "ml-auto flex h-11 w-11 items-center justify-center rounded-lg",
              isActive ? "bg-canary-50 text-canary-600" : "text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900",
            )
          }
        >
          <Sparkles className="h-5 w-5" aria-hidden="true" />
        </NavLink>
      </div>
    </header>
  );
}

function MobileTabBar({ reviewCount }: { reviewCount: number | null }) {
  return (
    <nav
      aria-label="Main navigation"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-neutral-200 bg-white/95 backdrop-blur"
    >
      <ul className="flex items-stretch justify-around">
        {NAV.map((entry) => {
          const Icon = entry.icon;
          const count = entry.badge ? reviewCount : null;
          return (
            <li key={entry.to} className="flex-1">
              <NavLink
                to={entry.to}
                end={entry.to === "/"}
                className={({ isActive }) =>
                  cn(
                    // 44px minimum tap target, plus room for the home-bar inset.
                    "relative flex min-h-11 flex-col items-center justify-center gap-0.5 px-1 py-2 pb-3 text-[10px] font-medium transition-colors",
                    isActive ? "text-neutral-900" : "text-neutral-500",
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    <Icon
                      className={cn("h-5 w-5", isActive ? "text-canary-600" : null)}
                      aria-hidden="true"
                    />
                    <span className="truncate">{entry.label}</span>
                    {count !== null && count > 0 ? (
                      <span
                        aria-label={`${count} awaiting review`}
                        className="absolute right-1/4 top-1 h-2 w-2 rounded-full bg-canary-400"
                      />
                    ) : null}
                  </>
                )}
              </NavLink>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
