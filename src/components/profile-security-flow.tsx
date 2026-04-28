"use client"

import * as React from "react"
import Link from "next/link"
import { ClipboardPaste, GalleryVerticalEnd } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSeparator,
  InputOTPSlot,
} from "@/components/ui/input-otp"

export function SecurityFlowShell({
  title,
  description,
  children,
}: {
  title: string
  description: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 bg-background p-6 md:p-10">
      <div className="w-full max-w-sm">
        <div className="flex flex-col gap-6">
          <div className="flex flex-col items-center gap-2 text-center">
            <Link href="/" className="flex flex-col items-center gap-2 font-medium">
              <div className="flex size-8 items-center justify-center rounded-md">
                <GalleryVerticalEnd className="size-6" />
              </div>
              <span className="sr-only">Drive</span>
            </Link>
            <h1 className="text-xl font-bold">{title}</h1>
            <FieldDescription>{description}</FieldDescription>
          </div>
          {children}
          <FieldDescription className="px-6 text-center">
            <Link href="/profile">Back to profile</Link>
          </FieldDescription>
        </div>
      </div>
    </div>
  )
}

export function OtpInputField({
  displayTarget,
  code,
  setCode,
}: {
  displayTarget?: string
  code: string
  setCode: (value: string) => void
}) {
  const inputRef = React.useRef<HTMLInputElement | null>(null)
  function applyPastedCode(nextCode: string) {
    setCode(nextCode)
    const input = inputRef.current
    if (!input) return
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set
    setter?.call(input, nextCode)
    input.dispatchEvent(new Event("input", { bubbles: true }))
    input.focus()
  }
  async function pasteCode() {
    inputRef.current?.focus()
    if (navigator.clipboard?.readText) {
      try {
        const text = await navigator.clipboard.readText()
        const nextCode = text.replace(/\D/g, "").slice(0, 6)
        if (nextCode) applyPastedCode(nextCode)
        return
      } catch {
        // Browser blocked clipboard access. Focus the OTP field so manual paste works.
      }
    }
    toast.message("Paste into the focused code field with Ctrl+V.")
  }

  return (
    <Field className="items-center text-center">
      <FieldLabel htmlFor="security-otp-code" className="justify-center text-center">
        Verification code
      </FieldLabel>
      <FieldDescription className="text-center">
        Enter the 6-digit code from {displayTarget || "your selected method"}.
      </FieldDescription>
      <InputOTP
        ref={inputRef}
        maxLength={6}
        id="security-otp-code"
        required
        value={code}
        onChange={(value) => setCode(value.replace(/\D/g, ""))}
        containerClassName="mx-auto flex w-fit items-center justify-center gap-2"
      >
        <InputOTPGroup className="*:data-[slot=input-otp-slot]:h-12 *:data-[slot=input-otp-slot]:w-11 *:data-[slot=input-otp-slot]:text-xl">
          <InputOTPSlot index={0} />
          <InputOTPSlot index={1} />
          <InputOTPSlot index={2} />
        </InputOTPGroup>
        <InputOTPSeparator className="mx-2" />
        <InputOTPGroup className="*:data-[slot=input-otp-slot]:h-12 *:data-[slot=input-otp-slot]:w-11 *:data-[slot=input-otp-slot]:text-xl">
          <InputOTPSlot index={3} />
          <InputOTPSlot index={4} />
          <InputOTPSlot index={5} />
        </InputOTPGroup>
      </InputOTP>
      <Button type="button" variant="ghost" size="sm" className="mx-auto h-8 rounded-full px-3 text-xs" onClick={() => void pasteCode()}>
        <ClipboardPaste className="h-3.5 w-3.5" />
        Paste code
      </Button>
    </Field>
  )
}

export function VerificationMethodPicker({
  methods,
  selected,
  onSelect,
}: {
  methods: Array<{ id: "authenticator" | "email" | "sms"; label: string }>
  selected: "authenticator" | "email" | "sms"
  onSelect: (method: "authenticator" | "email" | "sms") => void
}) {
  return (
    <FieldGroup>
      <Field>
        <FieldLabel>Verification method</FieldLabel>
        <div className="grid gap-2">
          {methods.map((method) => (
            <Button
              key={method.id}
              type="button"
              variant={selected === method.id ? "default" : "outline"}
              className="justify-start"
              onClick={() => onSelect(method.id)}
            >
              {method.label}
            </Button>
          ))}
        </div>
      </Field>
    </FieldGroup>
  )
}
