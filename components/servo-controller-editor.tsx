"use client"

import { useStore } from "@/lib/store"
import {
  servoDriverFor,
  esp32LinkFor,
  esp32PortFor,
  esp32BaudFor,
  esp32DefaultPortFor,
  ESP32_HOST_PATTERN,
  ESP32_BAUD_CHOICES,
  DEFAULT_ESP32_BAUD,
  pulseDriveFor,
  pulseDriveProfileFor,
  pulseEnableActiveLowFor,
  pulseAlarmActiveLowFor,
} from "@/lib/filament"
import type { StorageNode } from "@/lib/types"
import type { ServoDriver, Esp32Link } from "@/lib/node-protocol"
import { cn } from "@/lib/utils"
import { Field, Segmented, Input, Select, Checkbox } from "./ui/field"

const DRIVER_OPTIONS: { value: ServoDriver; label: string }[] = [
  { value: "gpio", label: "Pi GPIO" },
  { value: "esp32", label: "ESP32" },
]
const LINK_OPTIONS: { value: Esp32Link; label: string }[] = [
  { value: "usb", label: "USB cable" },
  { value: "uart", label: "UART (GPIO 14/15)" },
  { value: "wifi", label: "Wi-Fi (no Pi)" },
]

const WIFI_STATE_LABEL: Record<string, string> = {
  router: "on the router",
  ap: "on the master hotspot",
  connecting: "joining…",
  offline: "no Wi-Fi",
  disabled: "Wi-Fi off",
}

/**
 * Settings → Motor drive → "Servo controller": who generates the pulse trains.
 * The Pi header (iSV57T builds) or an ESP32 running `pi-agent/esp32-servo`
 * (A6-RS builds), plus how the Pi reaches the ESP32. The agent rebuilds its
 * backend on the next `config` while idle, and reports the link in the
 * `servo` frame, which is what the status pill shows.
 */
export function ServoControllerEditor({ node, disabled = false }: { node: StorageNode; disabled?: boolean }) {
  const { dispatch } = useStore()
  const driver = servoDriverFor(node)
  const link = esp32LinkFor(node)
  const port = esp32PortFor(node)
  const baud = esp32BaudFor(node)
  const live = node.servo
  const online = node.driver === "hardware" && node.link === "online"
  const agentDriver = live?.driver
  const twin = Boolean(node.twinSide)
  const pulseDrive = pulseDriveFor(node)
  const profile = pulseDriveProfileFor(node)
  const enableActiveLow = pulseEnableActiveLowFor(node)
  const alarmActiveLow = pulseAlarmActiveLowFor(node)
  const agentDrive = live?.pulseDrive

  const update = (
    changes: Partial<
      Pick<
        StorageNode,
        "servoDriver" | "esp32Link" | "esp32Port" | "esp32Baud" | "pulseEnableActiveLow" | "pulseAlarmActiveLow"
      >
    >,
  ) => dispatch({ type: "UPDATE_NODE", id: node.id, changes })

  let pill: { tone: "ok" | "warn" | "muted"; text: string } | null = null
  if (online) {
    if (driver === "esp32") {
      if (agentDriver !== "esp32") pill = { tone: "warn", text: "agent: switching to ESP32…" }
      else if (live?.linkOk) {
        const drive = agentDrive && agentDrive !== pulseDrive ? ` · switching to ${profile.short}…` : ` · ${profile.short}`
        const where =
          live.link === "wifi"
            ? `${live.esp32Host ? `${live.esp32Host}.local` : (live.port ?? "Wi-Fi")}${
                live.esp32Wifi ? ` · ${WIFI_STATE_LABEL[live.esp32Wifi] ?? live.esp32Wifi}` : ""
              }${typeof live.esp32Rssi === "number" && live.esp32Rssi !== 0 ? ` ${live.esp32Rssi} dBm` : ""}`
            : (live.port ?? "serial")
        pill = { tone: "ok", text: `ESP32 linked · ${where}${live.esp32Firmware ? ` · fw ${live.esp32Firmware}` : ""}${drive}` }
      } else {
        const via = link === "wifi" ? "Wi-Fi" : link === "uart" ? "UART" : "USB"
        pill = { tone: "muted", text: `ESP32 · ${via} · ${profile.short}` }
      }
    } else if (agentDriver === "esp32") {
      pill = { tone: "warn", text: "agent: switching to Pi GPIO…" }
    } else {
      pill = { tone: "muted", text: "Pi GPIO" }
    }
  } else if (node.driver === "hardware" && driver === "esp32") {
    pill = { tone: "warn", text: "ESP32 not answering · no connection to Pi agent" }
  }

  return (
    <div className="mt-3 rounded-lg border border-border/70 bg-background/40 p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Motor controller</p>
        {pill && (
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-mono text-[11px]",
              pill.tone === "ok" && "bg-success/15 text-success",
              pill.tone === "warn" && "bg-warning/15 text-warning",
              pill.tone === "muted" && "bg-muted text-muted-foreground",
            )}
          >
            <span
              aria-hidden
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                pill.tone === "ok" && "bg-success",
                pill.tone === "warn" && "bg-warning",
                pill.tone === "muted" && "bg-muted-foreground/60",
              )}
            />
            {pill.text}
          </span>
        )}
      </div>

      <Segmented
        options={DRIVER_OPTIONS}
        value={driver}
        onChange={(v) => {
          if (!disabled && !twin) update({ servoDriver: v })
        }}
        className={cn((disabled || twin) && "pointer-events-none opacity-60")}
      />
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground text-pretty">
        {driver === "esp32" ? (
          <>
            An ESP32 board generates both pulse trains from one hardware timer and reads the shelf and home sensors
            itself, so the two chains stay in lockstep and the stop on a flag never waits for the Pi. One firmware
            drives every PUL/DIR type; the agent tells it the <span className="font-mono">{pulseDrive}</span> profile
            at runtime, so no rebuild is needed when you change drives. Wire the two {profile.examples} drives and both
            sensors to the ESP32 — see <span className="font-mono">pi-agent/esp32-servo/README.md</span>.
          </>
        ) : pulseDrive === "integrated-servo" ? (
          <>
            The Pi pulses PUL/DIR on its own header (iSV57T wiring) and reads the sensors on GPIO 23/24. Pick ESP32
            for a separate drive with the external controller board.
          </>
        ) : (
          <>
            The Pi pulses PUL/DIR on its own header and reads the sensors on GPIO 23/24. {profile.label} drives are
            usually run from the ESP32 controller, which times the pulses in hardware and drives the{" "}
            {profile.enableInputName} input; on the Pi header the enable outputs on GPIO 17/25 take that role.
          </>
        )}
        {twin && (
          <span className="text-warning"> Twin carousels on one Pi need the Pi GPIO controller; one ESP32 drives one carousel.</span>
        )}
      </p>

      {driver === "esp32" && (
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Link to the Pi">
            <Segmented
              options={LINK_OPTIONS}
              value={link}
              onChange={(v) => !disabled && update({ esp32Link: v })}
              className={cn(disabled && "pointer-events-none opacity-60")}
            />
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {link === "usb"
                ? "Micro-USB on the DevKit to any Pi USB port. Also powers the ESP32."
                : link === "uart"
                  ? "3 wires: Pi GPIO14 TXD → ESP32 GPIO21, Pi GPIO15 RXD ← ESP32 GPIO22, GND–GND. Run install.sh --esp32-link uart once to free the UART from the console (reboot)."
                  : "This carousel has no Pi: the ESP32 joins your router (or the master's hotspot when the router is gone) and a second agent on the master Pi drives it over the network. Type WIFI <ssid> <password> on its USB console once; the master pushes new credentials afterwards and firmware updates go over the air."}
            </p>
          </Field>
          <Field label={link === "wifi" ? "ESP32 host" : "Serial device"} htmlFor={`esp32-port-${node.id}`}>
            <Input
              id={`esp32-port-${node.id}`}
              value={port}
              placeholder={link === "wifi" ? esp32DefaultPortFor(node) : `auto (${esp32DefaultPortFor(node)})`}
              spellCheck={false}
              autoCapitalize="off"
              inputMode={link === "wifi" ? "url" : undefined}
              disabled={disabled}
              aria-invalid={link === "wifi" && port !== "" && !ESP32_HOST_PATTERN.test(port) ? true : undefined}
              onChange={(e) => update({ esp32Port: e.target.value })}
              onBlur={(e) => update({ esp32Port: e.target.value.trim() })}
            />
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {link === "wifi"
                ? "The board prints its name at boot (HELLO … host=pax-esp32-xxxx) and shows it on http://<name>.local/. Port 8766 unless you changed PAX_LINK_PORT."
                : "Leave empty to auto-detect. Set it only if several USB-serial devices are plugged in."}
            </p>
          </Field>
          {link !== "wifi" && (
            <Field label="Baud" htmlFor={`esp32-baud-${node.id}`}>
              <Select
                id={`esp32-baud-${node.id}`}
                value={String(baud)}
                disabled={disabled}
                onChange={(e) => update({ esp32Baud: Number(e.target.value) })}
              >
                {ESP32_BAUD_CHOICES.map((b) => (
                  <option key={b} value={b}>
                    {b.toLocaleString()}{b === DEFAULT_ESP32_BAUD ? " (firmware default)" : ""}
                  </option>
                ))}
              </Select>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Must match <span className="font-mono">PAX_LINK_BAUD</span> in the firmware build (the stock build is{" "}
                {DEFAULT_ESP32_BAUD.toLocaleString()}).
              </p>
            </Field>
          )}
          {online && agentDriver === "esp32" && !live?.linkOk && live?.linkError && (
            <p className="rounded-lg bg-warning/10 p-2 font-mono text-xs leading-relaxed text-warning sm:col-span-2">
              {live.linkError}
            </p>
          )}
        </div>
      )}

      <details className="mt-3 rounded-lg border border-border/60 p-2">
        <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
          Signal polarity ({profile.label} defaults{node.pulseEnableActiveLow !== undefined || node.pulseAlarmActiveLow !== undefined ? ", overridden" : ""})
        </summary>
        <div className="mt-2 flex flex-col gap-2">
          <Checkbox
            checked={enableActiveLow}
            onChange={(v) => update({ pulseEnableActiveLow: v === profile.enableActiveLow ? undefined : v })}
            label={`${profile.enableInputName}: GPIO LOW engages the motor`}
            description={
              enableActiveLow
                ? `The controller holds the ${profile.enableInputName} output LOW to run and HIGH to release — a direct common-anode optocoupler hookup.`
                : pulseDrive === "closed-loop-stepper"
                  ? "The controller holds the MF output HIGH to run and LOW to release — the common-anode hookup in the README (+5 V on MF+, GPIO sinks MF−; LOW = MF conducting = coils off)."
                  : `The controller holds the ${profile.enableInputName} output HIGH to run and LOW to release — the transistor / ULN2003 hookup in the README.`
            }
          />
          <Checkbox
            checked={alarmActiveLow}
            onChange={(v) => update({ pulseAlarmActiveLow: v === profile.alarmActiveLow ? undefined : v })}
            label="ALM: output conducts (pin LOW) on a fault"
            description={
              alarmActiveLow
                ? "The drive's alarm optocoupler conducts when it has tripped (CL86Y-style). Pin HIGH = healthy."
                : "The drive's alarm optocoupler conducts while healthy and opens on a fault (iSV57T / A6-RS style). Pin HIGH = fault."
            }
          />
          <p className="text-xs leading-relaxed text-muted-foreground text-pretty">
            Change these only for a drive that is not in the list; the profile above already sets them for the
            drives it names.
          </p>
        </div>
      </details>
    </div>
  )
}
