"use client";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";

type AuthModalProps = {
  open: boolean;
  fallbackHref: string;
  onClose: () => void;
};

export function AuthModal({ open, fallbackHref, onClose }: AuthModalProps) {
  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[70] bg-[rgba(23,18,13,0.18)] backdrop-blur-xl" onClick={onClose}>
      <div className="flex min-h-full items-center justify-center px-4 py-6">
        <div
          className="w-full max-w-md rounded-[28px] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[0_24px_80px_rgba(23,18,13,0.24)]"
          onClick={(event) => event.stopPropagation()}
          role="dialog"
          aria-modal="true"
          aria-label="Sign in"
        >
          <div className="flex items-center justify-between">
            <p className="text-lg font-semibold tracking-[-0.03em] text-[var(--foreground)]">
              Log in
            </p>
            <Button variant="ghost" size="icon" aria-label="Close sign in" onClick={onClose}>
              <X className="h-5 w-5" />
            </Button>
          </div>
          <p className="mt-2 text-sm leading-6 text-[var(--muted-foreground)]">
            Access your account, dashboard, and personal details.
          </p>
          <div className="mt-5 grid gap-3">
            <Button className="h-11 w-full rounded-full" onClick={() => (window.location.href = fallbackHref)}>
              Log in
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
