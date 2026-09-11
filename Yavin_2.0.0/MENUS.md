# Menu implementation plan

Read `../GEMINI.md` before planning. Scope: the seven existing application menus, Explorer context menus, and searchable commands. Keep application logic in TypeScript and reuse native filesystem validation.

## Audit and plan review

1. Behavior review: title-bar labels currently have no handlers; Explorer menus lack keyboard support; quick open contains only files. Implement real commands for existing capabilities. Terminal execution remains disabled with an explanation because no process transport exists.
2. Consistency review: independent menu callbacks and shortcuts would drift. Use a small shared command list with labels, shortcuts, enabled/checked state, and handlers. Use it for title menus and command search.
3. Failure review: opening a menu steals editor focus; clipboard reads can complete after switching documents; file commands can fail or be cancelled. Preserve selection, verify async edit targets, keep unsaved data, and display errors. Disable commands without an appropriate document/workspace.
4. Accessibility review: menu roles, roving focus, arrows, Home/End, Enter/Space, Escape, Tab exit, outside dismissal, viewport positioning, and focus restoration are acceptance criteria. Keep the menubar available at narrow widths.
5. Verification review: pure tests cover text/history/shortcut behavior; browser tests cover menu navigation, disabled actions, real edits, and command search. Native tests remain required if the native dialog command changes.

## Command scope

| Menu      | Working commands                                                                                                  |
| --------- | ----------------------------------------------------------------------------------------------------------------- |
| File      | New file, open file in workspace, open folder, save, save all, close editor, close all editors, reveal file, exit |
| Edit      | Undo, redo, cut, copy, paste, find, replace                                                                       |
| Selection | Select all, select line, duplicate selection/line                                                                 |
| View      | Command palette, sidebar, bottom panel, AI panel, word wrap, zoom in/out/reset                                    |
| Go        | Quick open, go to line, previous/next editor                                                                      |
| Terminal  | Toggle panel; new terminal visibly unavailable                                                                    |
| Help      | Keyboard shortcuts, about and current feature limitations                                                         |

Do not add pretend functionality or a general-purpose native shell. Existing native access remains restricted to the selected workspace. File creation must not overwrite existing files. Browser preview supports unsaved editing and commands; filesystem commands require desktop access.

Keyboard reference: [WAI-ARIA menu and menubar pattern](https://www.w3.org/WAI/ARIA/apg/patterns/menubar/).

## Verification and limits

Browser coverage includes all seven menus, keyboard/focus behavior, disabled commands, clipboard actions, find/replace, history across tabs, checked state, search, new-file validation, failed saves, and Explorer context menus. Native-mode browser cases mock IPC; the Rust workspace tests and a native compile are separate checks. OS dialogs and platform clipboard permissions still require desktop acceptance testing.

Word wrap hides the fixed-height line-number gutter to avoid displaying misleading line positions. Browser-created documents are temporary. Terminal execution remains unavailable. This change does not add workspace-wide content search, multiple cursors, Save As, or a terminal process service.
