"use client"

import * as React from "react"
import Link from "next/link"
import { ClipboardPaste, GalleryVerticalEnd } from "lucide-react"

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
    <div className="auth-flow-bg flex min-h-svh flex-col items-center justify-center gap-6 p-4 sm:p-6 md:p-10">
      <div className="auth-flow-panel w-full max-w-sm rounded-3xl p-5 backdrop-blur sm:p-6">
        <div className="flex flex-col gap-6">
          <div className="flex flex-col items-center gap-2 text-center">
            <Link href="/" className="flex flex-col items-center gap-2 font-medium">
              <div className="flex size-8 items-center justify-center rounded-2xl bg-primary/10">
                <GalleryVerticalEnd className="size-6" />
              </div>
              <span className="sr-only">Drive</span>
            </Link>
            <h1 className="text-balance text-xl font-bold">{title}</h1>
            <FieldDescription className="text-pretty">{description}</FieldDescription>
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
  const pasteCaptureRef = React.useRef<HTMLInputElement | null>(null)

  function submitAfterPaste(input: HTMLInputElement | null, nextCode: string) {
    if (nextCode.length !== 6) return
    window.setTimeout(() => input?.form?.requestSubmit(), 50)
  }

  function applyPastedCode(nextCode: string) {
    setCode(nextCode)
    const input = inputRef.current
    if (!input) return
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set
    setter?.call(input, nextCode)
    input.dispatchEvent(new Event("input", { bubbles: true }))
    input.focus()
    submitAfterPaste(input, nextCode)
  }

  function handlePaste(event: React.ClipboardEvent<HTMLElement>) {
    const nextCode = event.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6)
    if (!nextCode) return
    event.preventDefault()
    applyPastedCode(nextCode)
  }

  function handlePasteCaptureChange(event: React.ChangeEvent<HTMLInputElement>) {
    const nextCode = event.target.value.replace(/\D/g, "").slice(0, 6)
    event.target.value = ""
    if (nextCode) applyPastedCode(nextCode)
  }

  async function pasteCode() {
    if (navigator.clipboard?.readText) {
      try {
        const text = await navigator.clipboard.readText()
        const nextCode = text.replace(/\D/g, "").slice(0, 6)
        if (nextCode) applyPastedCode(nextCode)
        return
      } catch {
        // iOS can block Clipboard API reads; keep a real input focused for native paste/autofill.
      }
    }
    pasteCaptureRef.current?.focus()
    pasteCaptureRef.current?.select()
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
        inputMode="numeric"
        pattern="[0-9]*"
        autoComplete="one-time-code"
        value={code}
        onChange={(value) => setCode(value.replace(/\D/g, ""))}
        onPaste={handlePaste}
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
      <div className="relative mx-auto h-8 w-fit">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 rounded-full px-3 text-xs"
          tabIndex={-1}
          aria-hidden="true"
        >
          <ClipboardPaste className="h-3.5 w-3.5" />
          Paste code
        </Button>
        <input
          ref={pasteCaptureRef}
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="one-time-code"
          aria-label="Paste verification code"
          className="absolute inset-0 h-full w-full cursor-pointer rounded-full opacity-0"
          onClick={() => void pasteCode()}
          onPaste={handlePaste}
          onChange={handlePasteCaptureChange}
        />
      </div>
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
