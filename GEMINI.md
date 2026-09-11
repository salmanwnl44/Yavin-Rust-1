# Coding Rules

Follow these rules for every task.

## 1. Keep the code simple

* Write the simplest code that correctly solves the problem.
* Do not over-engineer.
* Do not create abstractions unless they are actually needed.
* Avoid unnecessary classes, functions, files, layers, wrappers, frameworks, and dependencies.
* Prefer clear and readable code over clever code.
* Do not add code for hypothetical future requirements.
* Do not implement features that were not requested.
* If a simple solution works, use the simple solution.

## 2. Minimal changes

* Change only what is necessary for the requested task.
* Do not rewrite unrelated code.
* Do not reorganize the project unless required.
* Do not rename existing files, functions, variables, APIs, or modules without a reason.
* Preserve existing behavior unless the task explicitly requires changing it.

## 3. Dependencies

Before adding any dependency, ask:

1. Is it actually necessary?
2. Can the same thing be done reasonably with the standard library?
3. Is there already an existing dependency in the project that can do it?
4. Is the dependency actively maintained?
5. Is its license compatible with this project?

Prefer zero dependencies when practical.

Never add a dependency just to save a few lines of code.

## 4. Open-source rules

Treat the project as an open-source project by default.

* Prefer permissively licensed dependencies such as MIT, BSD, or Apache-2.0 when appropriate.
* Check the license of every new dependency before adding it.
* Do not copy code from another project unless its license permits reuse.
* Do not copy large portions of source code from external projects.
* Preserve required copyright notices and license notices.
* Do not remove existing license headers.
* Do not include proprietary, closed-source, or restricted code without explicit approval.
* Do not add dependencies with unclear licensing.
* Do not add code containing credentials, API keys, tokens, passwords, private URLs, or other secrets.
* Do not commit generated secrets or local configuration containing sensitive information.
* Respect the project's existing LICENSE, NOTICE, CONTRIBUTING, and CODE_OF_CONDUCT files.

## 5. Project conventions

Before writing code:

* Inspect the existing project structure.
* Read the relevant existing code.
* Identify the language version and build system.
* Check existing formatting and naming conventions.
* Check existing tests.
* Follow the project's existing architecture instead of creating a new architecture unnecessarily.

Do not assume a convention when the repository already establishes one.

## 6. Technology stack and language boundaries

* Use TypeScript for application logic, backend services, and complex work. Use React TSX with Vite for the frontend.
* Use Rust only for Tauri and simple microservices that are easy to implement.
* Do not use Rust for any complex work.

## 7. Rust-specific rules

When writing Rust:

* Use Rust only for Tauri integration and simple, easy-to-implement microservices.
* Do not use Rust for complex work.
* Prefer safe Rust.
* Do not use `unsafe` unless it is genuinely required.
* If `unsafe` is required, keep it as small as possible and document why it is safe.
* Prefer the standard library when practical.
* Avoid unnecessary crates.
* Use idiomatic Rust.
* Handle `Result` and `Option` properly.
* Do not use `unwrap()` or `expect()` in production paths unless failure is genuinely impossible or explicitly justified.
* Avoid unnecessary cloning.
* Avoid unnecessary allocations.
* Do not introduce complex lifetimes when a simpler design works.
* Prefer clear ownership and borrowing patterns.
* Run `cargo fmt`.
* Run `cargo check`.
* Run relevant tests.
* Run `cargo clippy` when available and practical.

## 8. Error handling

* Handle errors explicitly.
* Do not silently ignore errors.
* Give useful error messages.
* Do not add complicated error-handling frameworks unless necessary.
* Follow the project's existing error-handling approach.

## 9. Security

Never weaken security to make implementation easier.

* Never hardcode secrets.
* Validate untrusted input.
* Avoid command injection, path traversal, SQL injection, and unsafe deserialization.
* Do not disable security checks just to make tests pass.
* Do not bypass authentication or authorization unless explicitly required for a legitimate development task.
* Prefer secure defaults.

## 10. Comments and documentation

* Do not write comments for obvious code.
* Write comments only when they explain something that is not obvious from the code.
* Do not generate huge documentation for a small change.
* Keep documentation proportional to the feature.

## 11. Testing

For every meaningful change:

* Check whether existing tests cover it.
* Add only necessary tests.
* Prefer small, focused tests.
* Do not create meaningless tests just to increase test count.
* Run the relevant tests after making changes.

## 12. Before adding code

Think through the task first.

Determine:

* What exactly needs to change?
* What is the smallest correct implementation?
* Which existing code can be reused?
* What is the minimum number of files that need modification?
* Are there existing dependencies or utilities that already solve part of the problem?

Then implement it.

## 13. Do not do these things

Do NOT:

* Over-engineer.
* Build unnecessary frameworks.
* Create unnecessary abstractions.
* Add unnecessary dependencies.
* Generate thousands of lines when a few hundred are enough.
* Rewrite working code without a reason.
* Add speculative features.
* Add unnecessary configuration.
* Add unnecessary comments.
* Add unnecessary documentation.
* Change unrelated files.
* Ignore compiler warnings without understanding them.
* Suppress errors just to make the build pass.
* Copy proprietary code.
* Introduce unclear-license dependencies.
* Put secrets into source code.
* Use Rust for complex work (use TypeScript for backend logic and complex tasks instead).

## 14. Final verification

Before considering a task complete:

1. Review the changes.
2. Remove unnecessary code.
3. Check for accidental changes.
4. Check dependency changes.
5. Check licenses for newly added dependencies.
6. Check for secrets.
7. Format the code.
8. Compile/check the project.
9. Run relevant tests.
10. Fix issues caused by your changes.

## 15. Final response

Keep the final response short.

Tell me:

* What you changed.
* Which files were changed.
* What checks/tests were run.
* Any important issue that remains.

Do not explain every line of code unless I ask.

## Core principle

> Implement the smallest clean solution that fully solves the requested problem, while respecting the existing project, security, and open-source licensing rules.
