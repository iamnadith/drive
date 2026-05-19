"use client"

import * as React from "react"
import {
  ArrowRightLeft,
  BarChart3,
  Bell,
  Bot,
  Boxes,
  ChevronsUpDown,
  FolderOpen,
  HardDrive,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Settings,
  UserCircle2,
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
  useSidebar,
} from "@/components/ui/sidebar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
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
    url: "/dashboard/settings",
    icon: Settings,
  },
]

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const { user, logout } = useAuth()
  const { isMobile, openMobile, setOpenMobile } = useSidebar()
  const pathname = usePathname()
  const canManageUsers = user?.role === "admin" || user?.role === "superadmin"
  const avatarSrc = user?.profileImageUrl?.trim() || null
  const userInitials = (user?.name || "User").substring(0, 2).toUpperCase()

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

  const previousPathnameRef = React.useRef(pathname)

  React.useEffect(() => {
    if (!isMobile) {
      previousPathnameRef.current = pathname
      return
    }
    if (previousPathnameRef.current === pathname) return
    previousPathnameRef.current = pathname
    if (!openMobile) return
    setOpenMobile(false)
  }, [isMobile, openMobile, pathname, setOpenMobile])

  const renderUserAvatar = React.useCallback(
    (key: string) => (
      <Avatar key={key} className="h-8 w-8 shrink-0 rounded-lg bg-muted">
        {avatarSrc ? (
          <AvatarImage src={avatarSrc} alt={user?.name || "User"} />
        ) : (
          <AvatarFallback className="rounded-lg text-xs font-semibold">
            {userInitials}
          </AvatarFallback>
        )}
      </Avatar>
    ),
    [avatarSrc, user?.name, userInitials]
  )

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
              className="!h-[2.375rem] rounded-full overflow-hidden select-none border border-transparent [-webkit-tap-highlight-color:transparent] hover:bg-black/6 hover:text-sidebar-foreground active:bg-black/6 active:text-sidebar-foreground data-[state=open]:bg-black/6 data-[state=open]:text-sidebar-foreground dark:hover:bg-white/10 dark:hover:text-sidebar-foreground dark:active:bg-white/10 dark:active:text-sidebar-foreground dark:data-[state=open]:bg-white/10 dark:data-[state=open]:text-sidebar-foreground"
            >
              <Link
                href="/"
                className="flex h-full w-full items-center gap-2 rounded-[inherit] pl-1 pr-2.5 [-webkit-tap-highlight-color:transparent]"
              >
                <div className="flex aspect-square size-7 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground">
                  <HardDrive className="size-4!" />
                </div>
                <span className="text-base font-semibold">CloudPanel</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent className="gap-1 overflow-y-auto overflow-x-hidden pt-0.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <SidebarNav label="Overview" items={navOverview} isActive={isActive} />
        <SidebarNav label="Manage" items={navManage} isActive={isActive} />
        <SidebarNav
          label="System"
          items={systemItems}
          isActive={isActive}
        />
      </SidebarContent>
      <SidebarFooter>
        <SidebarNav items={navSecondary} isActive={isActive} className="-mx-2" />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="h-11 rounded-3xl border border-transparent shadow-none outline-none ring-0 focus-visible:border-transparent focus-visible:outline-none focus-visible:ring-0 hover:bg-black/6 hover:text-sidebar-foreground data-[state=open]:border-transparent data-[state=open]:bg-black/6 data-[state=open]:text-sidebar-foreground data-[state=open]:shadow-none data-[state=open]:ring-0 dark:hover:bg-white/10 dark:hover:text-sidebar-foreground dark:data-[state=open]:border-transparent dark:data-[state=open]:bg-white/10 dark:data-[state=open]:text-sidebar-foreground dark:data-[state=open]:shadow-none dark:data-[state=open]:ring-0"
            >
              {renderUserAvatar(
                user?.profileImageUrl || user?.id || "guest-trigger-avatar"
              )}
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">
                  {user?.name || "Guest"}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {user?.email || "Not signed in"}
                </span>
              </div>
              <ChevronsUpDown className="ml-auto size-4 text-muted-foreground" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-[--radix-dropdown-menu-trigger-width] min-w-56 rounded-lg"
            side={isMobile ? "bottom" : "right"}
            align="end"
            sideOffset={4}
          >
            <DropdownMenuLabel className="flex items-center gap-2 p-1 font-normal text-left text-sm">
              {renderUserAvatar(
                user?.profileImageUrl || user?.id || "guest-menu-avatar"
              )}
              <div className="grid flex-1 leading-tight">
                <span className="truncate font-medium">
                  {user?.name || "Guest"}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {user?.email || "Not signed in"}
                </span>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem asChild>
                <Link href="/profile">
                  <UserCircle2 className="mr-2 size-4" />
                  Account
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem>
                <Bell className="mr-2 size-4" />
                Notifications
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
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
