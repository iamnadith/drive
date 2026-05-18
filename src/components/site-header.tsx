"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import { LogOut, UserRound } from "lucide-react";
import { ThemeToggleButton } from "@/features/store/components/theme-toggle-button";
import { useStore } from "@/features/store/providers/store-provider";
import { Button } from "@/components/ui/button";
import { getDefaultAdminPath, isAdminRole } from "@/lib/access-control";
import { cn } from "@/lib/utils";

export function SiteHeader() {
  const pathname = usePathname();
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const { viewer, isAuthenticated, signOut, signingOut } = useStore();
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  const dashboardHref = useMemo(() => {
    if (!viewer || !isAdminRole(viewer.role)) {
      return null;
    }

    const href = getDefaultAdminPath(viewer);
    return href === "/account" ? null : href;
  }, [viewer]);
  const accountMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function handlePointer(event: PointerEvent) {
      if (!accountMenuRef.current?.contains(event.target as Node)) {
        setAccountMenuOpen(false);
      }
    }

    if (accountMenuOpen) {
      window.addEventListener("pointerdown", handlePointer);
      return () => window.removeEventListener("pointerdown", handlePointer);
    }
  }, [accountMenuOpen]);

  if (pathname?.startsWith("/dashboard")) {
    return null;
  }

  return (
    <>
      <header
        className={cn(
          "sticky top-0 z-50 border-b border-[var(--border)] bg-[var(--header-bg)] backdrop-blur-xl transition-[background-color,backdrop-filter]",
        )}
      >
        <div className="page-shell flex h-16 items-center justify-between gap-4 px-4 sm:px-6">
          <div className="flex items-center gap-3 lg:gap-8">
            <Link href="/" className="heading-display text-2xl tracking-[-0.06em]">
              Drive
            </Link>
          </div>

          <div className="flex items-center self-center gap-1 sm:gap-2">
            {mounted && dashboardHref ? (
              <Link href={dashboardHref} className="hidden lg:block">
                <Button
                  variant="ghost"
                  className="h-[2.125rem] rounded-full border border-[var(--border)] bg-transparent px-3 text-[var(--foreground)] hover:bg-transparent"
                >
                  Dashboard
                </Button>
              </Link>
            ) : null}
            {mounted ? (
              <ThemeToggleButton
                compact
                className="h-9 w-9 !rounded-full border border-[var(--border)] bg-transparent p-0 text-[var(--foreground)] hover:bg-transparent"
                iconClassName="h-[18px] w-[18px] stroke-[2.25]"
              />
            ) : (
              <span className="h-8 w-8" aria-hidden="true" />
            )}
            {mounted && isAuthenticated ? (
              <Button
                variant="ghost"
                size="icon"
                aria-label="Account"
                className="flex h-9 w-9 items-center justify-center rounded-full border border-[var(--border)] p-0 lg:hidden"
                onClick={() => setAccountMenuOpen((current) => !current)}
              >
                {viewer?.avatarUrl ? (
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full">
                    <img
                      src={viewer.avatarUrl}
                      alt={viewer.fullName}
                      className="block h-9 w-9 rounded-full object-cover"
                    />
                  </span>
                ) : (
                  <span className="flex h-9 w-9 items-center justify-center rounded-full">
                    <UserRound className="h-[18px] w-[18px] stroke-[2.25] text-[var(--foreground)]" />
                  </span>
                )}
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="icon"
                aria-label="Open sign in"
                className="h-9 w-9 rounded-full border border-[var(--border)] p-0 lg:hidden"
                onClick={() => setAccountMenuOpen((current) => !current)}
              >
                <UserRound className="h-[18px] w-[18px] stroke-[2.25] text-[var(--foreground)]" />
              </Button>
            )}
            {mounted && isAuthenticated ? (
              <>
                <div className="relative" ref={accountMenuRef}>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="hidden h-8 w-8 min-h-0 items-center self-center !rounded-full border border-[var(--border)] bg-transparent p-0 leading-none hover:bg-transparent lg:flex"
                    aria-label="Open account menu"
                    onClick={() => setAccountMenuOpen((current) => !current)}
                  >
                    {viewer?.avatarUrl ? (
                      <img
                        src={viewer.avatarUrl}
                        alt={viewer.fullName}
                        className="block h-8 w-8 rounded-full border border-[var(--border)] object-cover"
                      />
                    ) : (
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface-2)] text-xs font-semibold uppercase">
                        {viewer?.fullName?.slice(0, 1) ?? "U"}
                      </span>
                    )}
                  </Button>

                  {accountMenuOpen ? (
                    <div className="header-panel-surface animate-dropdown-in absolute right-0 top-12 z-50 w-72 rounded-[24px] border p-3">
                      <div className="flex items-center gap-3 rounded-[20px] bg-[var(--surface-2)] p-3">
                        {viewer?.avatarUrl ? (
                          <img
                            src={viewer.avatarUrl}
                            alt={viewer.fullName}
                            className="h-11 w-11 rounded-full object-cover"
                          />
                        ) : (
                          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-[var(--surface)] text-sm font-semibold uppercase">
                            {viewer?.fullName?.slice(0, 1) ?? "U"}
                          </span>
                        )}
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold">{viewer?.fullName}</p>
                          <p className="truncate text-xs text-[var(--muted-foreground)]">{viewer?.email}</p>
                        </div>
                      </div>
                      <div className="mt-3 grid gap-1">
                        {[
                          { href: "/account", label: "Account overview" },
                          { href: "/account/profile", label: "Profile" },
                          { href: "/account/orders", label: "Orders" },
                        ].map((item) => (
                          <Link
                            key={item.href}
                            href={item.href}
                            className="rounded-2xl px-3 py-2.5 text-sm text-[var(--foreground)] hover:bg-[var(--surface-2)]"
                            onClick={() => setAccountMenuOpen(false)}
                          >
                            {item.label}
                          </Link>
                        ))}
                        {dashboardHref ? (
                          <Link
                            href={dashboardHref}
                            className="rounded-2xl px-3 py-2.5 text-sm text-[var(--foreground)] hover:bg-[var(--surface-2)]"
                            onClick={() => setAccountMenuOpen(false)}
                          >
                            Dashboard
                          </Link>
                        ) : null}
                        <button
                          type="button"
                          className="flex items-center gap-2 rounded-2xl px-3 py-2.5 text-left text-sm text-[var(--foreground)] hover:bg-[var(--surface-2)]"
                          onClick={() => {
                            setAccountMenuOpen(false);
                            void signOut();
                          }}
                          disabled={signingOut}
                        >
                          <LogOut className="h-4 w-4" />
                          {signingOut ? "Signing out..." : "Sign out"}
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              </>
            ) : (
              <>
                <div className="relative" ref={accountMenuRef}>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="hidden h-8 w-8 rounded-full border border-[var(--border)] bg-transparent p-0 hover:bg-transparent lg:flex"
                    aria-label="Open account menu"
                    onClick={() => setAccountMenuOpen((current) => !current)}
                  >
                    <span className="relative block h-full w-full">
                      <UserRound className="absolute left-1/2 top-1/2 block h-[18px] w-[18px] -translate-x-1/2 -translate-y-1/2 shrink-0 stroke-[2.25] text-[var(--foreground)]" />
                    </span>
                  </Button>
                  {accountMenuOpen ? (
                    <div className="header-panel-surface animate-dropdown-in absolute right-0 top-12 z-50 w-80 overflow-hidden rounded-[28px] border">
                      <div className="border-b border-[var(--border)] px-4 py-4">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--muted-foreground)]">
                          Account
                        </p>
                        <p className="mt-2 text-lg font-semibold tracking-[-0.03em] text-[var(--foreground)]">
                          Log in
                        </p>
                        <p className="mt-1 text-sm leading-6 text-[var(--muted-foreground)]">
                          Access your account, dashboard, and personal details.
                        </p>
                      </div>
                      <div className="p-4">
                        <Button className="h-11 w-full rounded-full" asChild>
                          <Link href="/login" onClick={() => setAccountMenuOpen(false)}>
                            Log in
                          </Link>
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </div>
              </>
            )}
          </div>
        </div>
      </header>
    </>
  );
}
