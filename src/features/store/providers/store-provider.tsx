"use client";

import { useState } from "react";
import { useAuth } from "@/components/auth-provider";

type StoreViewer = {
  avatarUrl?: string;
  fullName: string;
  email: string;
  role: "superadmin" | "admin" | "user";
};

export function useStore() {
  const { user, logout } = useAuth();
  const [signingOut, setSigningOut] = useState(false);

  const viewer: StoreViewer | null = user
    ? {
        avatarUrl: user.profileImageUrl,
        fullName: user.name,
        email: user.email,
        role: user.role,
      }
    : null;

  async function signOut() {
    setSigningOut(true);
    try {
      await logout();
    } finally {
      setSigningOut(false);
    }
  }

  return {
    cart: { lines: [] as Array<unknown> },
    wishlist: [] as Array<unknown>,
    viewer,
    isAuthenticated: !!user,
    signOut,
    signingOut,
  };
}
