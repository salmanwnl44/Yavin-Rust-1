/**
 * The extension host's resources (EXT-10), as the user sets them: user scope only -- a
 * project's workspace settings must not be able to give extensions more. The native side
 * bounds each value again (`HostResources::bounded`) and enforces them: the whole process's
 * memory and CPU in its OS sandbox's job, each extension's memory and time in its runtime.
 */
import type { NativeHostResources } from "../native.ts";
import { numberSetting, type SettingsRegistry } from "../settings/settings.ts";

const SECTION = "Extensions";
const USER_ONLY = ["user"] as const;

export const HOST_MEMORY = numberSetting({
  id: "extensions.host.memoryLimitMb",
  title: "Extension host memory (MB)",
  description:
    "The most memory the extension host process may use, all extensions together. Enforced by the operating system.",
  section: SECTION,
  default: 1024,
  min: 256,
  max: 4096,
  integer: true,
  scopes: USER_ONLY,
});

export const HOST_EXTENSION_MEMORY = numberSetting({
  id: "extensions.host.extensionMemoryLimitMb",
  title: "Memory per extension (MB)",
  description: "The most memory one extension's code may use (at most half the host's).",
  section: SECTION,
  default: 64,
  min: 16,
  max: 512,
  integer: true,
  scopes: USER_ONLY,
});

export const HOST_CPU = numberSetting({
  id: "extensions.host.cpuCores",
  title: "Extension host CPU (processors)",
  description:
    "How many processors' worth of CPU time the extension host may use. Enforced by the operating system.",
  section: SECTION,
  default: 1,
  min: 1,
  max: 64,
  integer: true,
  scopes: USER_ONLY,
});

export const HOST_CALL_TIMEOUT = numberSetting({
  id: "extensions.host.callTimeoutMs",
  title: "Extension call time limit (ms)",
  description:
    "The longest one call into an extension (a command, an event, a provider) may run before it is stopped.",
  section: SECTION,
  default: 2000,
  min: 100,
  max: 30000,
  integer: true,
  scopes: USER_ONLY,
});

export const HOST_LOAD_TIMEOUT = numberSetting({
  id: "extensions.host.loadTimeoutMs",
  title: "Extension load time limit (ms)",
  description: "The longest loading one extension may run before it is stopped.",
  section: SECTION,
  default: 5000,
  min: 500,
  max: 60000,
  integer: true,
  scopes: USER_ONLY,
});

export const HOST_RESOURCE_SETTING_LIST = [
  HOST_MEMORY,
  HOST_EXTENSION_MEMORY,
  HOST_CPU,
  HOST_CALL_TIMEOUT,
  HOST_LOAD_TIMEOUT,
] as const;

/** What the host is started with: the user's values (never a workspace's). */
export function hostResources(settings: Pick<SettingsRegistry, "get">): NativeHostResources {
  return {
    memoryMb: settings.get(HOST_MEMORY, null),
    extensionMemoryMb: settings.get(HOST_EXTENSION_MEMORY, null),
    cpuCores: settings.get(HOST_CPU, null),
    callMs: settings.get(HOST_CALL_TIMEOUT, null),
    loadMs: settings.get(HOST_LOAD_TIMEOUT, null),
  };
}
