import { PageHeader } from "@/components/app/page-header"
import { NewScheduleButton } from "@/components/schedules/new-schedule-button"
import { ScheduleTable } from "@/components/schedules/schedule-table"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { deviceLabel, listDevices } from "@/lib/devices"
import { listSchedules, schedulesActive } from "@/lib/schedules"
import { listTasks } from "@/lib/tasks"

export const dynamic = "force-dynamic"

export default async function SchedulesPage() {
  const [schedules, tasks, devices] = await Promise.all([
    listSchedules(),
    listTasks(),
    listDevices(),
  ])
  const taskOptions = tasks.map((t) => ({
    id: t.id,
    name: t.name,
    deviceUser: t.deviceUser,
  }))
  const deviceOptions = devices.map((d) => ({
    serial: d.serial,
    label: deviceLabel(d),
    online: d.online,
  }))
  return (
    <div>
      <PageHeader
        title="Schedules"
        description="Tasks that repeat on an interval. The interval is measured from the end of the previous run."
        actions={
          <NewScheduleButton tasks={taskOptions} devices={deviceOptions} />
        }
      />
      {schedulesActive() ? null : (
        <Alert className="mb-6">
          <AlertTitle>Schedules are paused</AlertTitle>
          <AlertDescription>
            SCHEDULE_ACTIVE is false, so no scheduled run will start. Schedules
            keep their timers and resume once it is set to true.
          </AlertDescription>
        </Alert>
      )}
      {tasks.length === 0 ? (
        <p className="mb-4 text-sm text-muted-foreground">
          Create a task first, then schedule it here.
        </p>
      ) : null}
      <ScheduleTable
        schedules={schedules}
        tasks={taskOptions}
        devices={deviceOptions}
      />
    </div>
  )
}
