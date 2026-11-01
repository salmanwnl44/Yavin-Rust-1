# Menu implementation plan

Read `../GEMINI.md` before planning. Scope: the eight existing application menus, Explorer context menus, and searchable commands. Keep application logic in TypeScript and reuse native filesystem validation.

## Audit and plan review

1. Behavior review: title-bar labels currently have no handlers; Explorer menus lack keyboard support; quick open contains only files. Implement real commands for existing capabilities. Terminal execution now runs through a small native PTY transport; additional terminals remain disabled with an explanation.
2. Consistency review: independent menu callbacks and shortcuts would drift. Use a small shared command list with labels, shortcuts, enabled/checked state, and handlers. Use it for title menus and command search.
3. Failure review: opening a menu steals editor focus; clipboard reads can complete after switching documents; file commands can fail or be cancelled. Preserve selection, verify async edit targets, keep unsaved data, and display errors. Disable commands without an appropriate document/workspace.
4. Accessibility review: menu roles, roving focus, arrows, Home/End, Enter/Space, Escape, Tab exit, outside dismissal, viewport positioning, and focus restoration are acceptance criteria. Keep the menubar available at narrow widths.
5. Verification review: pure tests cover text/history/shortcut behavior; browser tests cover menu navigation, disabled actions, real edits, and command search. Native tests remain required if the native dialog command changes.

## Command scope

| Menu      | Working commands                                                                                                                                                       |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File      | New file, new text file, open file, open folder, save, Save As, save all, revert, close editor, close other/saved/all editors, reopen closed editor, reveal file, exit |
| Edit      | Undo, redo, cut, copy, paste, find, replace, delete line, toggle line comment, indent/outdent line                                                                     |
| Selection | Select all, select line, duplicate selection/line, copy line up/down, move line up/down                                                                                |
| View      | Command palette, sidebar, bottom panel, AI panel, search, Replace in Files, Markdown preview (in place or to the side), word wrap, minimap, zoom in/out/reset          |
| Go        | Quick open, go to line, previous/next editor                                                                                                                           |
| Terminal  | Toggle panel; a single shell runs in the panel, additional terminals visibly unavailable                                                                               |
| Help      | Keyboard shortcuts (every command with one), welcome, about and current feature limitations                                                                            |

Each tab has a context menu: close, close others, close to the right, close saved, close all, copy path, reveal in the Explorer view and in the system file manager. The editor's context menu is Monaco's (change all occurrences, cut, copy, paste) ending with Command Palette, as in VS Code. Right-clicking the minimap opens its own menu: minimap on/off, render characters, vertical size (proportional, fill, fit) and slider (mouse over, always), remembered on this computer; View › Minimap turns it back on.

**Keyboard.** A command's shortcut runs it from anywhere, except the editing commands (undo, clipboard, select, and the line commands): those act on the editor only while it has the keyboard, and elsewhere the key belongs to the focused control -- Ctrl+A in the Explorer never selects the editor's text. Inside the editor Monaco handles its own keys first, including clipboard keys, so copying with nothing selected copies the line.
Do not add pretend functionality or a general-purpose native shell. Existing native access remains restricted to the selected workspace. File creation must not overwrite existing files. Browser preview supports unsaved editing and commands; filesystem commands require desktop access.

Keyboard reference: [WAI-ARIA menu and menubar pattern](https://www.w3.org/WAI/ARIA/apg/patterns/menubar/).

## Verification and limits

Browser coverage includes all eight menus, keyboard/focus behavior, disabled commands, clipboard actions, find/replace, history across tabs, checked state, search, new-file validation, failed saves, and Explorer context menus. Native-mode browser cases mock IPC; the Rust workspace tests and a native compile are separate checks. OS dialogs and platform clipboard permissions still require desktop acceptance testing.

Browser-created documents are temporary. Browser preview has no shell; the terminal requires the desktop application. Save As has no shortcut: Ctrl+Shift+S is Save All. There is no split editor, tab pinning or preview tabs yet.
