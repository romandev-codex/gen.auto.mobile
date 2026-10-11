import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  startFakeExecutor,
  useFakeExecutor,
  type FakeExecutor,
} from "../helpers/fake-executor"

const PNG = Buffer.from("89504e470d0a1a0a", "hex")
let fake: FakeExecutor
/** What GET /devices/:serial/thermal answers; null means the route is missing. */
let batteryLevel: number | null = null

beforeAll(async () => {
  fake = await startFakeExecutor()
  useFakeExecutor(fake)
  fake.on("GET", "/devices/:serial/screenshot", (req, res, { json }) => {
    if (req.url?.includes("/nope/")) {
      return json(
        {
          error: {
            code: "device_not_found",
            message: "Device nope is not connected",
          },
        },
        404
      )
    }
    res.writeHead(200, { "content-type": "image/png" })
    res.end(PNG)
  })
  fake.on("GET", "/devices/:serial/thermal", (_req, _res, { json }) =>
    batteryLevel == null
      ? json({ error: { code: "not_found", message: "no route" } }, 404)
      : json({ temperatureC: 30, batteryLevel })
  )
  fake.on("POST", "/devices/:serial/dim", (_req, _res, { json }) =>
    json({ dimmed: true })
  )
})

afterAll(() => fake.close())

async function fetchShot(serial: string) {
  const { GET } = await import("@/app/api/devices/[serial]/screenshot/route")
  return GET(new Request(`http://app/api/devices/${serial}/screenshot`), {
    params: Promise.resolve({ serial }),
  })
}

describe("GET /api/devices/:serial/screenshot", () => {
  it("proxies PNG bytes from the executor", async () => {
    const res = await fetchShot("emulator-5554")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("image/png")
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG)
  })

  it("serves repeated requests within the interval from cache", async () => {
    const before = fake.calls.filter((c) =>
      c.path.endsWith("/screenshot")
    ).length
    await Promise.all([
      fetchShot("emulator-5554"),
      fetchShot("emulator-5554"),
      fetchShot("emulator-5554"),
    ])
    const after = fake.calls.filter((c) =>
      c.path.endsWith("/screenshot")
    ).length
    expect(after).toBe(before)
  })

  it("asks the executor again once the interval has passed", async () => {
    const { clearScreenshotCache } = await import("@/lib/screenshots")
    clearScreenshotCache()
    const before = fake.calls.filter((c) =>
      c.path.endsWith("/screenshot")
    ).length
    await fetchShot("emulator-5554")
    expect(
      fake.calls.filter((c) => c.path.endsWith("/screenshot")).length
    ).toBe(before + 1)
  })

  it("returns not_found for a device the executor does not know", async () => {
    const res = await fetchShot("nope")
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe("not_found")
  })

  it("refuses screenshots and dims the screen while the battery is low", async () => {
    const { clearScreenshotCache } = await import("@/lib/screenshots")
    const { clearDimmedCache } = await import("@/lib/device-thermal")
    clearScreenshotCache()
    clearDimmedCache()
    const count = (suffix: string) =>
      fake.calls.filter((c) => c.path.endsWith(suffix)).length
    const shotsBefore = count("/screenshot")
    const dimsBefore = count("/dim")

    batteryLevel = 18
    const res = await fetchShot("emulator-5554")
    expect(res.status).toBe(409)
    expect((await res.json()).error).toEqual({
      code: "battery_low",
      message: "Battery low: 18% is below the 30% minimum",
    })
    await fetchShot("emulator-5554")
    expect(count("/screenshot")).toBe(shotsBefore) // the phone was never asked
    expect(count("/thermal")).toBeGreaterThan(0)
    expect(count("/dim")).toBe(dimsBefore + 1) // dimmed once, not per frame

    batteryLevel = 31
    clearScreenshotCache()
    expect((await fetchShot("emulator-5554")).status).toBe(200)
    expect(count("/screenshot")).toBe(shotsBefore + 1)
    batteryLevel = null
  })
})
