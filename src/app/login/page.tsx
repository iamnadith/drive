import { LoginForm } from "@/components/login-form"

export default function LoginPage() {
  return (
    <div className="auth-flow-bg page-under-header flex flex-col items-center justify-center gap-6 p-4 sm:p-6 md:p-10">
      <div className="auth-flow-panel w-full max-w-sm rounded-3xl p-5 backdrop-blur sm:p-6">
        <LoginForm />
      </div>
    </div>
  )
}
