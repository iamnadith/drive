"use client"

import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"
import { Spinner } from "@/components/ui/spinner"

const buttonVariants = cva(
  "inline-flex max-w-full shrink-0 select-none caret-transparent items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default: "glass-button text-foreground hover:brightness-[1.03]",
        destructive:
          "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/60",
        outline:
          "glass-button text-foreground hover:brightness-[1.03]",
        secondary:
          "glass-button text-secondary-foreground hover:brightness-[1.03]",
        ghost:
          "glass-button bg-transparent hover:brightness-[1.03]",
        link: "border-transparent bg-transparent text-primary shadow-none backdrop-blur-0 underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        sm: "h-8 rounded-lg gap-1.5 px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-xl px-6 has-[>svg]:px-4",
        icon: "size-9",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  children,
  loading = false,
  variant,
  size,
  asChild = false,
  disabled,
  onClick,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
    loading?: boolean
  }) {
  const Comp = asChild ? Slot : "button"
  const [clickLoading, setClickLoading] = React.useState(false)
  const isLoading = loading || clickLoading
  const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    const result = onClick?.(event) as unknown
    const maybePromise = result as PromiseLike<unknown> | null | undefined
    if (maybePromise && typeof maybePromise.then === "function") {
      setClickLoading(true)
      Promise.resolve(maybePromise).finally(() => setClickLoading(false))
    }
  }

  if (asChild) {
    return (
      <Comp
        data-slot="button"
        className={cn(buttonVariants({ variant, size, className }))}
        aria-busy={isLoading || undefined}
        onClick={onClick}
        disabled={disabled}
        {...props}
      >
        {children}
      </Comp>
    )
  }

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      aria-busy={isLoading || undefined}
      {...props}
      onClick={handleClick}
      disabled={isLoading || disabled}
    >
      {isLoading ? (
        <>
          <Spinner className="size-4" />
          <span className="contents [&>svg]:hidden [&>[role=status]]:hidden">{children}</span>
        </>
      ) : (
        children
      )}
    </Comp>
  )
}

export { Button, buttonVariants }
