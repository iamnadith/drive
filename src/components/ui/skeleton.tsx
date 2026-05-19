import { cn } from "@/lib/utils"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn(
        "animate-shimmer rounded-xl bg-[linear-gradient(110deg,color-mix(in_oklch,var(--muted)_84%,transparent)_10%,color-mix(in_oklch,var(--accent)_58%,white_16%)_34%,color-mix(in_oklch,var(--muted)_74%,transparent)_58%,color-mix(in_oklch,var(--accent)_42%,white_12%)_78%,color-mix(in_oklch,var(--muted)_82%,transparent)_100%)] bg-[length:240%_100%] shadow-[inset_0_1px_0_color-mix(in_oklch,white_46%,transparent)]",
        className
      )}
      {...props}
    />
  )
}

export { Skeleton }
