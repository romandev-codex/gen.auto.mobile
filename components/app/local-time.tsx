"use client"

import { useSyncExternalStore } from "react"

const subscribe = () => () => {}

// Formats a timestamp in the viewer's timezone. The server (and the hydration
// pass) render an empty <time>, because the server only knows its own zone;
// the text appears once the browser takes over.
export function LocalTime({
  value,
  mode = "datetime",
}: {
  value: Date | string | number
  mode?: "datetime" | "time"
}) {
  const isClient = useSyncExternalStore(
    subscribe,
    () => true,
    () => false
  )
  const date = new Date(value)
  return (
    <time dateTime={date.toISOString()}>
      {isClient
        ? mode === "time"
          ? date.toLocaleTimeString()
          : date.toLocaleString()
        : null}
    </time>
  )
}
