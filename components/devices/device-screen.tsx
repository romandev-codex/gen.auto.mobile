"use client"

import { Pause, Play } from "lucide-react"
import { useEffect, useState } from "react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * Shows a device screenshot that refreshes on an interval. Refreshing stops
 * while paused, while the tab is hidden, or when the device is offline. The
 * server refuses screenshots while the battery is low; the frame says so and
 * keeps polling, so the screen comes back once the device has charged.
 */
export function DeviceScreen({
  serial,
  online,
  intervalMs,
  size = "card",
  pausable = false,
}: {
  serial: string
  online: boolean
  intervalMs: number
  size?: "card" | "large"
  pausable?: boolean
}) {
  const [paused, setPaused] = useState(false)
  const [visible, setVisible] = useState(true)
  const [tick, setTick] = useState(() => Date.now())
  const [failed, setFailed] = useState(false)
  const [lowBattery, setLowBattery] = useState<string | null>(null)

  const active = online && !paused && visible

  useEffect(() => {
    const onVisibility = () =>
      setVisible(document.visibilityState === "visible")
    onVisibility()
    document.addEventListener("visibilitychange", onVisibility)
    return () => document.removeEventListener("visibilitychange", onVisibility)
  }, [])

  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setTick(Date.now()), Math.max(500, intervalMs))
    return () => clearInterval(id)
  }, [active, intervalMs])

  const src = `/api/devices/${encodeURIComponent(serial)}/screenshot?t=${tick}`
  const frame = cn(
    "relative flex items-center justify-center overflow-hidden rounded-md border bg-muted",
    size === "card"
      ? "aspect-[9/16] w-full"
      : "aspect-[9/16] max-h-[80svh] w-full max-w-sm"
  )

  return (
    <div className="flex flex-col gap-2">
      <div className={frame}>
        {online ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt={`Screen of ${serial}`}
            className={cn(
              "h-full w-full object-contain",
              failed && "opacity-30"
            )}
            onError={() => {
              setFailed(true)
              void explainFailure(src).then(setLowBattery)
            }}
            onLoad={() => {
              setFailed(false)
              setLowBattery(null)
            }}
          />
        ) : null}
        {!online || failed ? (
          <span className="absolute px-4 text-center text-xs text-muted-foreground">
            {!online
              ? "Device offline"
              : lowBattery
                ? `${lowBattery}. Screenshots paused until it charges.`
                : "Screenshot unavailable, retrying"}
          </span>
        ) : null}
      </div>
      {pausable ? (
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">
            {active
              ? `Refreshing every ${(intervalMs / 1000).toFixed(1)} s`
              : "Paused"}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setPaused((p) => !p)
              setFailed(false)
              setTick(Date.now())
            }}
            disabled={!online}
          >
            {paused ? (
              <Play className="size-3" />
            ) : (
              <Pause className="size-3" />
            )}
            {paused ? "Resume" : "Pause"}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

/** The battery-low message behind a failed screenshot, or null for any other failure. */
async function explainFailure(src: string): Promise<string | null> {
  try {
    const res = await fetch(src, { cache: "no-store" })
    if (res.ok) return null
    const body = (await res.json()) as {
      error?: { code?: string; message?: string }
    }
    return body.error?.code === "battery_low"
      ? (body.error.message ?? "Battery low")
      : null
  } catch {
    return null
  }
}
