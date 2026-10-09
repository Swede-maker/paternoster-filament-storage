"use client"

import { useState } from "react"
import { Boxes, Check, Plus, Wrench } from "lucide-react"
import { useStore } from "@/lib/store"
import type { NetSlave, MotorMode } from "@/lib/node-protocol"
import { cn } from "@/lib/utils"
import { Button } from "../ui/button"
import { Dialog, DialogFooter } from "../ui/dialog"
import { Field, Input, Segmented } from "../ui/field"
import { draftToConfig, makeDraft } from "../storage-layout-editor"

const AGENT_PORT = 8765

type System = "filament" | "hardware"

function defaultName(hostname: string) {
  const match = hostname.match(/(\d+)$/)
  return match ? `Carousel ${match[1]}` : hostname
}

function clampInt(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.round(n)))
}

/**
 * Turns a slave that registered with the master into a storage unit in one
 * step: pick Filament or Hardware, confirm the layout, and the unit is created
 * already pointed at `<hostname>.local` on the agent port.
 */
export function AddSlaveCarouselDialog({
  slave,
  open,
  onClose,
}: {
  slave: NetSlave
  open: boolean
  onClose: () => void
}) {
  const { dispatch } = useStore()
  const host = `${slave.hostname}.local`

  const [system, setSystem] = useState<System>("filament")
  const [name, setName] = useState(() => defaultName(slave.hostname))
  const [shelves, setShelves] = useState("9")
  const [slots, setSlots] = useState("8")
  const [motorMode, setMotorMode] = useState<MotorMode>("dc")
  const [added, setAdded] = useState<System | null>(null)

  const shelvesNum = Number.parseInt(shelves, 10)
  const slotsNum = Number.parseInt(slots, 10)
  const valid =
    name.trim().length > 0 &&
    Number.isFinite(shelvesNum) &&
    shelvesNum >= 1 &&
    Number.isFinite(slotsNum) &&
    slotsNum >= 1

  const close = () => {
    setAdded(null)
    onClose()
  }

  const add = () => {
    if (!valid) return
    const draft = makeDraft("paternoster")
    const shelfCount = clampInt(shelvesNum, 1, 99)
    const slotCount = clampInt(slotsNum, 1, 99)
    const { storage } = draftToConfig({
      ...draft,
      name: name.trim(),
      shelves: shelfCount,
      slotsPerShelf: slotCount,
      perShelf: Array.from({ length: shelfCount }, () => ({ name: "", area: "", slots: slotCount })),
    })
    dispatch({
      type: "ADD_NODE",
      name: name.trim(),
      nodeType: "paternoster",
      system,
      storage,
      ip: host,
      driver: "hardware",
      port: AGENT_PORT,
      motorMode,
    })
    setAdded(system)
  }

  if (added) {
    return (
      <Dialog open={open} onClose={close} title="Carousel added" className="max-w-md">
        <div className="flex flex-col gap-3 text-sm text-foreground">
          <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/30 p-3">
            <Check className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
            <p className="leading-relaxed text-pretty">
              <span className="font-medium">{name.trim()}</span> is linked to{" "}
              <span className="font-mono">{host}</span> and will connect on its own within a few seconds.
            </p>
          </div>
          <p className="leading-relaxed text-muted-foreground text-pretty">
            You can find it under Settings → {added === "filament" ? "Filament" : "Hardware"} → Storage units, where
            you can fine-tune the motor settings and calibrate it.
          </p>
        </div>
        <DialogFooter>
          <Button className="min-h-11" onClick={close}>
            Done
          </Button>
        </DialogFooter>
      </Dialog>
    )
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Add as carousel"
      description={`Create a paternoster driven by ${host}.`}
      className="max-w-md"
    >
      <div className="flex flex-col gap-4">
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-medium text-foreground">What will it store?</legend>
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                { value: "filament", label: "Filament", hint: "Spools", icon: Boxes },
                { value: "hardware", label: "Hardware", hint: "Parts & boxes", icon: Wrench },
              ] as const
            ).map((opt) => {
              const Icon = opt.icon
              const selected = system === opt.value
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setSystem(opt.value)}
                  className={cn(
                    "flex min-h-16 flex-col items-start gap-1 rounded-lg border px-3 py-2.5 text-left transition-colors",
                    selected
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-border bg-background text-muted-foreground hover:text-foreground",
                  )}
                >
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <Icon className={cn("h-4 w-4", selected && "text-primary")} aria-hidden="true" />
                    {opt.label}
                  </span>
                  <span className="text-xs">{opt.hint}</span>
                </button>
              )
            })}
          </div>
        </fieldset>

        <Field label="Name" htmlFor="slave-carousel-name">
          <Input
            id="slave-carousel-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="text-base"
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Shelves" htmlFor="slave-carousel-shelves">
            <Input
              id="slave-carousel-shelves"
              type="number"
              inputMode="numeric"
              min={1}
              value={shelves}
              onChange={(e) => setShelves(e.target.value)}
              className="text-base"
            />
          </Field>
          <Field label="Slots per shelf" htmlFor="slave-carousel-slots">
            <Input
              id="slave-carousel-slots"
              type="number"
              inputMode="numeric"
              min={1}
              value={slots}
              onChange={(e) => setSlots(e.target.value)}
              className="text-base"
            />
          </Field>
        </div>

        <Field label="Motor drive">
          <Segmented<MotorMode>
            options={[
              { value: "dc", label: "DC motors" },
              { value: "servo", label: "Servos (PUL/DIR)" },
            ]}
            value={motorMode}
            onChange={setMotorMode}
          />
        </Field>

        <p className="text-xs leading-relaxed text-muted-foreground text-pretty">
          Use the same motor type you chose when installing this slave. You can change the layout and motor settings
          later.
        </p>
      </div>

      <DialogFooter>
        <Button variant="ghost" className="min-h-11" onClick={close}>
          Cancel
        </Button>
        <Button className="min-h-11" disabled={!valid} onClick={add}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          Add carousel
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
