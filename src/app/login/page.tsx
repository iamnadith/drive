import { LoginForm } from "@/components/login-form"

export default function LoginPage() {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 bg-[radial-gradient(circle_at_top,var(--muted),transparent_34rem)] p-4 sm:p-6 md:p-10">
      <div className="w-full max-w-sm rounded-3xl border bg-card/95 p-5 shadow-sm backdrop-blur sm:p-6">
        <LoginForm />
      </div>
    </div>
  )
}
