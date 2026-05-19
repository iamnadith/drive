import { cn } from "@/lib/utils"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn(
        "animate-shimmer rounded-xl bg-[linear-gradient(110deg,color-mix(in_oklch,var(--muted)_92%,transparent)_0%,color-mix(in_oklch,var(--muted)_82%,white_8%)_46%,color-mix(in_oklch,var(--muted)_92%,transparent)_100%)] bg-[length:200%_100%]",
        className
      )}
      {...props}
    />
  )
}

export { Skeleton }
