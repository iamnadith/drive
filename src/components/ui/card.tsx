import * as React from "react"

import { cn } from "@/lib/utils"

function Card({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      className={cn(
        "glass-surface text-card-foreground flex min-w-0 flex-col gap-4 overflow-hidden rounded-3xl border shadow-sm sm:gap-5 md:gap-4",
        className
      )}
      {...props}
    />
  )
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "@container/card-header grid min-w-0 auto-rows-min grid-rows-[auto_auto] items-start gap-2 px-4 pt-4 sm:px-5 sm:pt-5 md:px-4 md:pt-4 sm:has-data-[slot=card-action]:grid-cols-[minmax(0,1fr)_auto] [.border-b]:pb-4 sm:[.border-b]:pb-5 md:[.border-b]:pb-4",
        className
      )}
      {...props}
    />
  )
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={cn("min-w-0 text-balance leading-tight font-semibold", className)}
      {...props}
    />
  )
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("text-muted-foreground min-w-0 text-pretty text-sm", className)}
      {...props}
    />
  )
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn(
        "row-start-3 mt-1 flex min-w-0 flex-wrap items-center gap-2 self-start justify-self-start sm:col-start-2 sm:row-span-2 sm:row-start-1 sm:mt-0 sm:justify-self-end",
        className
      )}
      {...props}
    />
  )
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-content"
      className={cn("min-w-0 px-4 pb-4 sm:px-5 sm:pb-5 md:px-4 md:pb-4", className)}
      {...props}
    />
  )
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn("flex min-w-0 flex-wrap items-center gap-2 px-4 sm:px-5 md:px-4 [.border-t]:pt-4 sm:[.border-t]:pt-5 md:[.border-t]:pt-4", className)}
      {...props}
    />
  )
}

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
}
