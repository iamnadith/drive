import { cn } from "@/lib/utils"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn(
        "animate-shimmer rounded-xl bg-gradient-to-r from-muted via-accent to-muted bg-[length:200%_100%]",
        className
      )}
      {...props}
    />
  )
}

export { Skeleton }
