"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { Input } from "./field"

type NumberInputProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "value" | "onChange" | "type" | "min" | "max"
> & {
  value: number
  onCommit: (value: number) => void
  min: number
  max: number
  integer?: boolean
  unit?: string
}

/**
 * A number field that lets the user type freely. The text is kept as a local
 * draft and only committed when it parses to a value inside [min, max]; an
 * out-of-range or empty draft shows a warning instead of being clamped, and
 * reverts to the last committed value on blur.
 */
export function NumberInput({
  value,
  onCommit,
  min,
  max,
  integer = true,
  unit,
  className,
  onBlur,
  id,
  ...props
}: NumberInputProps) {
  const [draft, setDraft] = React.useState<string | null>(null)
  const text = draft ?? String(value)
  const parsed = integer ? Number.parseInt(text, 10) : Number.parseFloat(text)
  const fmt = (n: number) => n.toLocaleString("en-US").replace(/,/g, " ")
  const suffix = unit ? ` ${unit}` : ""

  let warning: string | null = null
  if (draft !== null) {
    if (draft.trim() === "" || !Number.isFinite(parsed)) {
      warning = `Enter a number between ${fmt(min)} and ${fmt(max)}${suffix}.`
    } else if (parsed < min) {
      warning = `Too low — the lowest allowed is ${fmt(min)}${suffix}.`
    } else if (parsed > max) {
      warning = `Too high — the highest allowed is ${fmt(max)}${suffix}.`
    }
  }
  const warningId = id ? `${id}-warning` : undefined

  return (
    <div className="w-full">
      <Input
        {...props}
        id={id}
        type="text"
        inputMode={integer ? "numeric" : "decimal"}
        value={text}
        aria-invalid={warning ? true : undefined}
        aria-describedby={warning ? warningId : props["aria-describedby"]}
        className={cn(warning && "border-destructive focus-visible:ring-destructive", className)}
        onChange={(e) => {
          const next = e.target.value
          setDraft(next)
          const v = integer ? Number.parseInt(next, 10) : Number.parseFloat(next)
          if (next.trim() !== "" && Number.isFinite(v) && v >= min && v <= max) onCommit(v)
        }}
        onBlur={(e) => {
          setDraft(null)
          onBlur?.(e)
        }}
      />
      {warning && (
        <p id={warningId} role="alert" className="mt-1 text-xs font-medium text-destructive">
          {warning} Kept at {fmt(value)}
          {suffix}.
        </p>
      )}
    </div>
  )
}
