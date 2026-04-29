"use client"

import * as React from "react"
import {
  ArrowRightLeft,
  BarChart3,
  Bot,
  Boxes,
  FolderOpen,
  HardDrive,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Settings,
  Users,
  type LucideIcon,
} from "lucide-react"
import Link from "next/link"
import { usePathname } from "next/navigation"

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { useAuth } from "@/components/auth-provider"

type NavItem = {
  title: string
  url: string
  icon: LucideIcon
  adminOnly?: boolean
}

const navOverview: NavItem[] = [
  {
    title: "Overview",
    url: "/dashboard/overview",
    icon: LayoutDashboard,
  },
  {
    title: "Analytics",
    url: "/dashboard/analytics",
    icon: BarChart3,
  },
  {
    title: "Activity",
    url: "/dashboard/activity",
    icon: ListChecks,
  },
]

const navManage: NavItem[] = [
  {
    title: "Storage",
    url: "/dashboard/storage",
    icon: FolderOpen,
  },
  {
    title: "Accounts",
    url: "/dashboard/accounts",
    icon: HardDrive,
  },
  {
    title: "Projects",
    url: "/dashboard/projects",
    icon: Boxes,
  },
  {
    title: "API Usage",
    url: "/dashboard/api-usage",
    icon: BarChart3,
  },
]

const navSystem: NavItem[] = [
  {
    title: "Migrations",
    url: "/dashboard/migrations",
    icon: ArrowRightLeft,
  },
  {
    title: "Workers",
    url: "/dashboard/workers",
    icon: Bot,
  },
  {
    title: "Users",
    url: "/dashboard/users",
    icon: Users,
    adminOnly: true,
  },
]

const navSecondary: NavItem[] = [
  {
    title: "Settings",
    url: "/settings",
    icon: Settings,
  },
]

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const { user, logout } = useAuth()
  const pathname = usePathname()
  const canManageUsers = user?.role === "admin" || user?.role === "superadmin"

  const systemItems = React.useMemo(
    () => navSystem.filter((item) => !item.adminOnly || canManageUsers),
    [canManageUsers]
  )

  const isActive = React.useCallback(
    (url: string) => {
      if (!pathname) {
        return false
      }

      if (url === "/dashboard/overview") {
        return pathname === "/dashboard" || pathname.startsWith(url)
      }

      return pathname === url || pathname.startsWith(`${url}/`)
    },
    [pathname]
  )

  const [mounted, setMounted] = React.useState(false)

  React.useEffect(() => {
    setMounted(true)
  }, [])

  if (!mounted) {
    return null
  }

  return (
    <Sidebar collapsible="offcanvas" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              className="data-[slot=sidebar-menu-button]:p-1.5!"
            >
              <Link href="/">
                <div className="flex aspect-square size-7 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground">
                  <HardDrive className="size-4!" />
                </div>
                <span className="text-base font-semibold">CloudPanel</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent className="overflow-y-auto overflow-x-hidden [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <SidebarNav label="Overview" items={navOverview} isActive={isActive} />
        <SidebarNav label="Manage" items={navManage} isActive={isActive} />
        <SidebarNav
          label="System"
          items={systemItems}
          isActive={isActive}
        />
        <SidebarNav
          items={navSecondary}
          isActive={isActive}
          className="mt-auto"
        />
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton
                  size="lg"
                  className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
                >
                  <Avatar className="h-8 w-8 rounded-lg">
                    <AvatarImage
                      src={user?.profileImageUrl || "https://github.com/shadcn.png"}
                      alt={user?.name || "User"}
                    />
                    <AvatarFallback className="rounded-lg">
                      {(user?.name || "User").substring(0, 2).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <div className="grid flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-semibold">
                      {user?.name || "Guest"}
                    </span>
                    <span className="truncate text-xs">
                      {user?.email || "Not signed in"}
                    </span>
                  </div>
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                className="w-[--radix-dropdown-menu-trigger-width] min-w-56 rounded-lg"
                side="bottom"
                align="end"
                sideOffset={4}
              >
                {user ? (
                  <DropdownMenuItem onClick={() => logout()}>
                    <LogOut className="mr-2 size-4" />
                    Log out
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem asChild>
                    <Link href="/login">
                      <LogOut className="mr-2 size-4" />
                      Log in
                    </Link>
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}

function SidebarNav({
  className,
  isActive,
  items,
  label,
}: {
  className?: string
  isActive: (url: string) => boolean
  items: NavItem[]
  label?: string
}) {
  if (items.length === 0) {
    return null
  }

  return (
    <SidebarGroup className={className}>
      {label ? <SidebarGroupLabel>{label}</SidebarGroupLabel> : null}
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => (
            <SidebarMenuItem key={item.title}>
              <SidebarMenuButton
                asChild
                tooltip={item.title}
                isActive={isActive(item.url)}
              >
                <Link href={item.url}>
                  <item.icon />
                  <span>{item.title}</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}
