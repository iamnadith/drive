"use client"

import Link from "next/link"
import { Github, Globe, Mail } from "lucide-react"

const links = [
  { label: "GitHub", href: "https://github.com/iamnadith", icon: Github },
  { label: "Portfolio", href: "https://nadith.pro", icon: Globe },
  { label: "Email", href: "mailto:contact@nadith.pro", icon: Mail },
]

export default function HomePage() {
  return (
    <main className="page-under-header overflow-hidden bg-transparent">
      <section className="mx-auto flex h-full w-full max-w-6xl flex-col justify-between px-4 py-5 sm:px-6 sm:py-6">
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1.15fr)_minmax(18rem,0.85fr)] lg:gap-12">
          <div className="min-w-0 space-y-5">
            <p className="text-[11px] font-medium uppercase tracking-[0.28em] text-[var(--muted-foreground)]">
              Nadith Dhanula
            </p>

            <div className="space-y-4">
              <h1 className="max-w-4xl text-[clamp(2.35rem,5vw,5.4rem)] font-semibold leading-[0.95] tracking-[-0.085em] text-[var(--foreground)]">
                Storage management,
                <br />
                migration control,
                <br />
                and operational visibility.
              </h1>

              <p className="max-w-2xl text-sm leading-7 text-[var(--muted-foreground)] sm:text-base sm:leading-8">
                Drive is a cloud storage control panel for managing accounts, projects, buckets,
                file access, migrations, and operational workflows from one place.
              </p>
            </div>
          </div>

          <div className="min-w-0 space-y-6 lg:pt-2">
            <div className="space-y-2">
              <p className="text-sm font-medium text-[var(--foreground)]">What this does</p>
              <p className="text-sm leading-7 text-[var(--muted-foreground)] sm:text-base">
                It lets you manage S3-style storage accounts, connect and organize projects,
                inspect buckets and objects, work with file explorer flows, configure custom URL
                endpoints, monitor API usage, review analytics, and coordinate migrations between
                storage environments with worker-backed execution and history tracking.
              </p>
            </div>

            <blockquote className="border-l border-[var(--border)] pl-4 text-sm leading-7 text-[var(--foreground)] sm:text-base">
              “The best control panels make complex infrastructure feel ordered, visible, and
              dependable.”
            </blockquote>

              <div className="flex flex-wrap gap-2.5">
                {links.map((item) => (
                  <Link
                    key={item.label}
                    href={item.href}
                    target={item.href.startsWith("http") ? "_blank" : undefined}
                    rel={item.href.startsWith("http") ? "noreferrer" : undefined}
                    aria-label={item.label}
                    className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-[var(--border)] text-[var(--foreground)] transition-colors hover:bg-white/50 dark:hover:bg-white/5"
                  >
                    <item.icon className="h-4 w-4" />
                  </Link>
                ))}
              </div>

              <div className="space-y-1 text-sm leading-7 text-[var(--muted-foreground)]">
                <p>Phone: +94 77 771 7578</p>
              </div>
            </div>
          </div>

        <footer className="flex flex-col gap-2 pt-6 text-xs text-[var(--muted-foreground)] sm:flex-row sm:items-end sm:justify-between">
          <p>© 2026 Nadith Dhanula, CC-BY-SA</p>
          <p className="uppercase tracking-[0.22em]">Minimal, focused, and quietly polished.</p>
        </footer>
      </section>
    </main>
  )
}
