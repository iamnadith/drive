"use client"

import * as React from "react"

export function useAuthCapabilities() {
  const [capabilities, setCapabilities] = React.useState({ google: false, sms: false, loaded: false })
  React.useEffect(() => {
    let active = true
    void fetch("/api/auth/capabilities").then((response) => response.json()).then((value) => {
      if (active) setCapabilities({ google: value.google === true, sms: value.sms === true, loaded: true })
    }).catch(() => { if (active) setCapabilities((current) => ({ ...current, loaded: true })) })
    return () => { active = false }
  }, [])
  return capabilities
}
