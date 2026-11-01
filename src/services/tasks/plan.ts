/**
 * The order a task's dependencies run in (IDE-04), decided before anything runs: depth-first,
 * each task's `dependsOn` in order, every task once (a dependency shared by two others runs
 * once, before the first that needs it), the task itself last. A cycle, or a name that is no
 * task, is refused here -- never discovered halfway through a run.
 */
import type { ResolvedTask } from "./model.ts";
import { TaskError } from "./errors.ts";

export function planTask(tasks: readonly ResolvedTask[], id: string): ResolvedTask[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const order: ResolvedTask[] = [];
  const done = new Set<string>();
  /** The chain being followed: meeting one of these again is a cycle. */
  const active: string[] = [];
  const visit = (current: string, neededBy: string | null) => {
    const task = byId.get(current);
    if (!task)
      throw neededBy === null
        ? new TaskError("UnknownTask", `There is no task "${current}".`)
        : new TaskError(
            "InvalidDependency",
            `Task "${neededBy}" depends on "${current}", which is not a task.`,
          );
    if (done.has(current)) return;
    if (active.includes(current))
      throw new TaskError(
        "DependencyCycle",
        `Tasks depend on each other in a circle: ${[...active.slice(active.indexOf(current)), current].join(" → ")}.`,
      );
    active.push(current);
    for (const dependency of task.dependsOn) visit(dependency, current);
    active.pop();
    done.add(current);
    order.push(task);
  };
  visit(id, null);
  return order;
}
