"use client";

import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type SearchPanelProps = {
  open: boolean;
  onClose: () => void;
};

export function SearchPanel({ open, onClose }: SearchPanelProps) {
  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[70] bg-[rgba(23,18,13,0.18)] backdrop-blur-xl" onClick={onClose}>
      <div className="flex min-h-full items-start justify-center px-4 py-6">
        <div
          className="w-full max-w-2xl rounded-[28px] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[0_24px_80px_rgba(23,18,13,0.24)]"
          onClick={(event) => event.stopPropagation()}
          role="dialog"
          aria-modal="true"
          aria-label="Search"
        >
          <div className="flex items-center justify-between gap-3">
            <p className="text-lg font-semibold tracking-[-0.03em] text-[var(--foreground)]">
              Search
            </p>
            <Button variant="ghost" size="icon" aria-label="Close search" onClick={onClose}>
              <X className="h-5 w-5" />
            </Button>
          </div>
          <Input
            autoFocus
            placeholder="Search is not wired in this repo yet"
            className="mt-4 h-11 rounded-full px-4"
          />
        </div>
      </div>
    </div>
  );
}
