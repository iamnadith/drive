"use client"

import * as React from "react"
import { toast } from "sonner"

export type AuthUser = {
  id: string
  name: string
  username?: string
  email: string
  role: "superadmin" | "admin" | "user"
  status: "active" | "disabled"
  quotaLimitMb: number
  quotaUsedMb: number
  profileImageUrl?: string
  googleLinked?: boolean
  passwordSource?: "local" | "google-generated"
}

type AuthContextValue = {
  user: AuthUser | null
  loading: boolean
  login: (email: string, password: string) => Promise<void>
  signup: (
    name: string,
    email: string,
    password: string,
    username?: string
  ) => Promise<void>
  logout: () => Promise<void>
  updateSelf: (
    updates: Partial<
      Pick<AuthUser, "name" | "email" | "profileImageUrl" | "googleLinked">
    > & { password?: string }
  ) => Promise<void>
  setUserDirect: (user: AuthUser | null) => void
}

const AuthContext = React.createContext<AuthContextValue | undefined>(
  undefined
)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = React.useState<AuthUser | null>(null)
  const [loading, setLoading] = React.useState(true)

  React.useEffect(() => {
    ;(async () => {
      setLoading(true)
      try {
        if (typeof window !== "undefined") {
          const cached = window.localStorage.getItem("authUser")
          if (cached) {
            try {
              const parsed = JSON.parse(cached) as AuthUser
              setUser(parsed)
            } catch {
              window.localStorage.removeItem("authUser")
            }
          }
        }
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  const refreshUserFromServer = React.useCallback(async () => {
    if (!user) return
    try {
      const res = await fetch(`/api/users/${user.id}`)
      const data = await res.json()
      if (!res.ok) {
        if (typeof window !== "undefined") {
          window.localStorage.removeItem("authUser")
        }
        setUser(null)
        const message =
          data.error && typeof data.error === "string"
            ? data.error
            : "Your account is no longer available. Please sign in again."
        const lower = message.toLowerCase()
        if (lower.includes("not found")) {
          toast.error("Your account was deleted by an administrator.")
        } else {
          toast.error(message)
        }
        return
      }

      const serverUser = data.user as AuthUser

      if (serverUser.status !== "active") {
        if (typeof window !== "undefined") {
          window.localStorage.removeItem("authUser")
        }
        setUser(null)
        toast.error("Your account has been disabled by an administrator.")
        return
      }

      // Detect changes between local user and serverUser.
      const changes: string[] = []
      if (serverUser.name !== user.name) {
        changes.push("name")
      }
      if (serverUser.username && serverUser.username !== user.username) {
        changes.push("username")
      }
      if (serverUser.email !== user.email) {
        changes.push("email")
      }
      if (serverUser.role !== user.role) {
        changes.push("role")
      }
      if (serverUser.quotaLimitMb !== user.quotaLimitMb) {
        changes.push("quota")
      }
      if (serverUser.profileImageUrl !== user.profileImageUrl) {
        changes.push("avatar")
      }

      const hasChanged = changes.length > 0

      if (hasChanged) {
        setUser(serverUser)
        if (typeof window !== "undefined") {
          window.localStorage.setItem("authUser", JSON.stringify(serverUser))
        }

        const prettyRole =
          serverUser.role === "superadmin"
            ? "Super Admin"
            : serverUser.role === "admin"
            ? "Admin"
            : "User"

        // Choose the most important change to notify about.
        if (changes.includes("role")) {
          toast.info(
            `Your role was changed to ${prettyRole} by an administrator.`
          )
        } else if (changes.includes("quota")) {
          if (serverUser.quotaLimitMb === 0) {
            toast.info(
              "Your storage quota was updated to Unlimited by an administrator."
            )
          } else {
            toast.info(
              `Your storage quota was updated to ${serverUser.quotaLimitMb} MB by an administrator.`
            )
          }
        } else if (changes.includes("username")) {
          toast.info("Your username was updated by an administrator.")
        } else if (changes.includes("email")) {
          toast.info("Your login email was updated by an administrator.")
        } else if (changes.includes("name")) {
          toast.info("Your profile name was updated by an administrator.")
        } else if (changes.includes("avatar")) {
          toast.info("Your profile picture was updated by an administrator.")
        }
      }
    } catch {
      // Ignore sync errors; keep current client state.
    }
  }, [user])

  React.useEffect(() => {
    if (!user) return
    if (typeof window === "undefined") return

    let cancelled = false

    // Initial sync as soon as we know who the user is.
    ;(async () => {
      if (!cancelled) {
        await refreshUserFromServer()
      }
    })()

    const handleFocus = () => {
      if (cancelled) return
      if (
        typeof document !== "undefined" &&
        document.visibilityState !== "visible"
      ) {
        return
      }
      void refreshUserFromServer()
    }

    window.addEventListener("focus", handleFocus)
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleFocus)
    }

    return () => {
      cancelled = true
      window.removeEventListener("focus", handleFocus)
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", handleFocus)
      }
    }
  }, [user, refreshUserFromServer])

  const loginFn = React.useCallback(
    async (email: string, password: string) => {
      setLoading(true)
      try {
        const res = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
        })
        const data = await res.json()
        if (!res.ok) {
          throw new Error(data.error ?? "Login failed")
        }
        const nextUser = data.user as AuthUser
        setUser(nextUser)
        if (typeof window !== "undefined") {
          window.localStorage.setItem("authUser", JSON.stringify(nextUser))
        }
        toast.success("Logged in")
      } catch (error: any) {
        toast.error(error?.message ?? "Login failed")
        throw error
      } finally {
        setLoading(false)
      }
    },
    []
  )

  const signupFn = React.useCallback(
    async (name: string, email: string, password: string, username?: string) => {
      setLoading(true)
      try {
        const res = await fetch("/api/auth/signup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, username, email, password }),
        })
        const data = await res.json()
        if (!res.ok) {
          throw new Error(data.error ?? "Sign up failed")
        }
        const nextUser = data.user as AuthUser
        setUser(nextUser)
        if (typeof window !== "undefined") {
          window.localStorage.setItem("authUser", JSON.stringify(nextUser))
        }
        toast.success("Account created")
      } catch (error: any) {
        toast.error(error?.message ?? "Sign up failed")
        throw error
      } finally {
        setLoading(false)
      }
    },
    []
  )

  const logoutFn = React.useCallback(async () => {
    setLoading(true)
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
      })
      setUser(null)
      if (typeof window !== "undefined") {
        window.localStorage.removeItem("authUser")
      }
      toast.success("Logged out")
    } catch {
      toast.error("Logout failed")
    } finally {
      setLoading(false)
    }
  }, [])

  const updateSelfFn = React.useCallback(
    async (
      updates: Partial<
        Pick<AuthUser, "name" | "email" | "profileImageUrl">
      > & { password?: string }
    ) => {
      if (!user) return
      setLoading(true)
      try {
        const res = await fetch(`/api/users/${user.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(updates),
        })
        const data = await res.json()
        if (!res.ok) {
          const message = data.error ?? "Update failed"
          // If the backend reports that the user no longer exists,
          // clear the local session so the UI can recover.
          if (message === "User not found") {
            if (typeof window !== "undefined") {
              window.localStorage.removeItem("authUser")
            }
            setUser(null)
            toast.error("Your account was removed. Please sign in again.")
            return
          }
          throw new Error(message)
        }
        const nextUser = data.user as AuthUser
        setUser(nextUser)
        if (typeof window !== "undefined") {
          window.localStorage.setItem("authUser", JSON.stringify(nextUser))
        }
        toast.success("Profile updated")
      } catch (error: any) {
        if (error?.message !== "User not found") {
          toast.error(error?.message ?? "Update failed")
          throw error
        }
      } finally {
        setLoading(false)
      }
    },
    [user, setUser]
  )

  const setUserDirect = React.useCallback((next: AuthUser | null) => {
    setUser(next)
    if (typeof window !== "undefined") {
      if (next) {
        window.localStorage.setItem("authUser", JSON.stringify(next))
      } else {
        window.localStorage.removeItem("authUser")
      }
    }
  }, [])

  const value: AuthContextValue = {
    user,
    loading,
    login: loginFn,
    signup: signupFn,
    logout: logoutFn,
    updateSelf: updateSelfFn,
    setUserDirect,
  }

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = React.useContext(AuthContext)
  if (!ctx) {
    throw new Error("useAuth must be used within AuthProvider")
  }
  return ctx
}
