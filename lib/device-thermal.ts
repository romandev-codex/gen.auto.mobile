import { notFound } from "@/lib/api/errors"
import type { DeviceTemperatureView } from "@/lib/device-view"
import { executor, ExecutorError } from "@/lib/executor/client"
import { Device } from "@/lib/models/device"
import { getSettings, type SettingsView } from "@/lib/settings"

const DIM_EVERY_MS = 60_000

const globalForDim = globalThis as unknown as {
  __lowBatteryDimmedAt?: Map<string, number>
}
const dimmedAt = (globalForDim.__lowBatteryDimmedAt ??= new Map())

/** Whether a charge is under the configured minimum (never when unknown or disabled). */
export function isBatteryLow(
  batteryLevel: number | null | undefined,
  minBatteryLevel: number
): boolean {
  return (
    minBatteryLevel > 0 &&
    batteryLevel != null &&
    batteryLevel < minBatteryLevel
  )
}

/**
 * Turns a low device's screen to minimum brightness so it charges instead of
 * draining. Runs restore brightness when they end, so every place that finds
 * the battery low calls this; it reaches adb at most once a minute per device
 * and never throws.
 */
export async function dimLowBatteryDevice(serial: string): Promise<void> {
  const last = dimmedAt.get(serial)
  if (last && Date.now() - last < DIM_EVERY_MS) return
  dimmedAt.set(serial, Date.now())
  try {
    await executor.dimDevice(serial)
  } catch (err) {
    console.warn(
      `[battery] ${serial}: could not dim the screen`,
      err instanceof Error ? err.message : err
    )
  }
}

export function clearDimmedCache(): void {
  dimmedAt.clear()
}

/**
 * Takes a fresh battery reading (temperature and charge) for the device page
 * and stores it on the device. Executor failures propagate (the route maps them to errors);
 * a device the executor no longer lists is reported as not found.
 */
export async function readDeviceTemperature(
  serial: string
): Promise<DeviceTemperatureView> {
  const settings = await getSettings()
  let temperatureC: number | null
  let batteryLevel: number | null
  try {
    const reading = await executor.deviceThermal(serial)
    temperatureC = reading.temperatureC
    batteryLevel = reading.batteryLevel ?? null
  } catch (err) {
    if (err instanceof ExecutorError && err.code === "not_found")
      throw notFound("Device")
    throw err
  }
  const readAt = new Date()
  if (isBatteryLow(batteryLevel, settings.minBatteryLevel))
    await dimLowBatteryDevice(serial)
  await Device.updateOne(
    { serial },
    { $set: { lastTemperatureC: temperatureC, lastBatteryLevel: batteryLevel } }
  )
  return {
    serial,
    temperatureC,
    limitC: settings.maxDeviceTemperatureC,
    batteryLevel,
    minBatteryLevel: settings.minBatteryLevel,
    readAt: readAt.toISOString(),
  }
}

/** `tooHot` means the device may not run now: too hot or its battery too low. */
export type ThermalVerdict =
  | { tooHot: false; temperatureC: number | null }
  | {
      tooHot: true
      temperatureC: number | null
      cooldownUntil: Date
      reason: string
    }

/**
 * Reads the device's battery temperature and charge over adb (through the
 * executor) and decides whether a run may start on it. The temperature is
 * stored on the device. Above the temperature limit, or below the minimum
 * charge, a cooldown is set so the dispatcher and schedule ticks leave the
 * device alone until then; the next attempt reads again, so a low device waits
 * until it has charged past the minimum. A reading that cannot be taken (no
 * sensor, an executor without the endpoint, a flaky device) never blocks a
 * run: the start itself will surface a device that is really gone.
 */
export async function checkDeviceThermal(
  serial: string,
  settings: Pick<
    SettingsView,
    "maxDeviceTemperatureC" | "minBatteryLevel" | "deviceCooldownSeconds"
  >
): Promise<ThermalVerdict> {
  if (settings.maxDeviceTemperatureC <= 0 && settings.minBatteryLevel <= 0) {
    // Checks switched off: drop any hold left over from when they were on.
    await Device.updateOne({ serial }, { $set: { cooldownUntil: null } })
    return { tooHot: false, temperatureC: null }
  }

  let temperatureC: number | null
  let batteryLevel: number | null
  try {
    const reading = await executor.deviceThermal(serial)
    temperatureC = reading.temperatureC
    batteryLevel = reading.batteryLevel ?? null
  } catch (err) {
    console.warn(
      `[thermal] ${serial}: temperature unavailable, starting anyway`,
      err instanceof Error ? err.message : err
    )
    return { tooHot: false, temperatureC: null }
  }

  const tooHot =
    settings.maxDeviceTemperatureC > 0 &&
    temperatureC != null &&
    temperatureC > settings.maxDeviceTemperatureC
  const tooLow = isBatteryLow(batteryLevel, settings.minBatteryLevel)
  if (tooLow) await dimLowBatteryDevice(serial)
  if (!tooHot && !tooLow) {
    await Device.updateOne(
      { serial },
      {
        $set: {
          lastTemperatureC: temperatureC,
          lastBatteryLevel: batteryLevel,
          cooldownUntil: null,
        },
      }
    )
    return { tooHot: false, temperatureC }
  }

  const cooldownUntil = new Date(
    Date.now() + settings.deviceCooldownSeconds * 1000
  )
  await Device.updateOne(
    { serial },
    {
      $set: {
        lastTemperatureC: temperatureC,
        lastBatteryLevel: batteryLevel,
        cooldownUntil,
      },
    }
  )
  return {
    tooHot: true,
    temperatureC,
    cooldownUntil,
    reason: tooHot
      ? `Device too hot: ${temperatureC!.toFixed(1)} °C is above the ${settings.maxDeviceTemperatureC} °C limit`
      : `Battery too low: ${batteryLevel}% is below the ${settings.minBatteryLevel}% minimum`,
  }
}

/** When the device's thermal cooldown ends, or null when it is not cooling down. */
export async function deviceCooldownUntil(
  serial: string
): Promise<Date | null> {
  const doc = await Device.findOne({ serial })
    .select("cooldownUntil")
    .lean<{ cooldownUntil?: Date | null }>()
  const until = doc?.cooldownUntil ?? null
  return until && until.getTime() > Date.now() ? until : null
}
