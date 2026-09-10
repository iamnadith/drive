import { LoginForm } from "@/components/login-form"

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect?: string | string[] }>
}) {
  const params = await searchParams
  const requestedRedirect = Array.isArray(params.redirect) ? params.redirect[0] : params.redirect
  const redirectTo = requestedRedirect?.startsWith("/") && !requestedRedirect.startsWith("//")
    ? requestedRedirect
    : "/"

  return (
    <div className="auth-flow-bg page-under-header flex flex-col items-center justify-center gap-6 p-4 sm:p-6 md:p-10">
      <div className="auth-flow-panel w-full max-w-sm rounded-3xl p-5 backdrop-blur sm:p-6">
        <LoginForm redirectTo={redirectTo} />
      </div>
    </div>
  )
}
