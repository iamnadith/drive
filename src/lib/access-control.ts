export function isAdminRole(role: string) {
  return role === "admin" || role === "superadmin";
}

export function getDefaultAdminPath(viewer: { role: string }) {
  return isAdminRole(viewer.role) ? "/dashboard/overview" : "/account";
}
