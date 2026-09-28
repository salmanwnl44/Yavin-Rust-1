/**
 * Whether the editor's test hooks are installed: in development, and in a production bundle
 * built with `VITE_TEST_HOOKS=1` -- so the UI tests can also check the built application (its
 * workers, its chunks) -- never in the release build.
 */
export const TEST_HOOKS: boolean = import.meta.env.DEV || import.meta.env.VITE_TEST_HOOKS === "1";
