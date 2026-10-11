import { ApiError } from "@/lib/api/errors"
import { dimLowBatteryDevice, isBatteryLow } from "@/lib/device-thermal"
import { executor } from "@/lib/executor/client"
import { getSettings } from "@/lib/settings"

type CacheEntry = { at: number; bytes: Uint8Array }
type BatteryEntry = { at: number; level: number | null }

/** How long a battery reading gates screenshots before it is taken again. */
const BATTERY_TTL_MS = 60_000

const globalForCache = globalThis as unknown as {
  __screenshotCache?: Map<string, CacheEntry>
  __screenshotInflight?: Map<string, Promise<Uint8Array>>
  __screenshotBattery?: Map<string, BatteryEntry>
}
const cache = (globalForCache.__screenshotCache ??= new Map())
const inflight = (globalForCache.__screenshotInflight ??= new Map())
const battery = (globalForCache.__screenshotBattery ??= new Map())

/**
 * The device's charge, read at most once per BATTERY_TTL_MS. A reading that
 * cannot be taken counts as unknown, which never blocks a screenshot.
 */
async function batteryLevel(serial: string): Promise<number | null> {
  const hit = battery.get(serial)
  if (hit && Date.now() - hit.at < BATTERY_TTL_MS) return hit.level
  let level: number | null = null
  try {
    level = (await executor.deviceThermal(serial)).batteryLevel ?? null
  } catch {
    // unknown: fall through and let the screenshot itself report a gone device
  }
  battery.set(serial, { at: Date.now(), level })
  return level
}

/**
 * Returns the latest screenshot for a device, hitting the executor at most
 * once per configured interval and sharing one request between concurrent
 * callers so several open cards do not multiply adb calls. A device whose
 * battery is under the configured minimum gets no screenshots (and its screen
 * is dimmed) until it has charged.
 */
export async function getDeviceScreenshot(serial: string): Promise<Uint8Array> {
  const { screenshotIntervalMs, minBatteryLevel } = await getSettings()
  if (minBatteryLevel > 0) {
    const level = await batteryLevel(serial)
    if (isBatteryLow(level, minBatteryLevel)) {
      await dimLowBatteryDevice(serial)
      throw new ApiError(
        "battery_low",
        `Battery low: ${level}% is below the ${minBatteryLevel}% minimum`,
        409
      )
    }
  }

  const hit = cache.get(serial)
  if (hit && Date.now() - hit.at < screenshotIntervalMs) return hit.bytes

  const pending = inflight.get(serial)
  if (pending) return pending

  const request = executor
    .screenshot(serial)
    .then((bytes) => {
      cache.set(serial, { at: Date.now(), bytes })
      return bytes
    })
    .finally(() => inflight.delete(serial))
  inflight.set(serial, request)
  return request
}

export function clearScreenshotCache(): void {
  cache.clear()
  inflight.clear()
  battery.clear()
}
