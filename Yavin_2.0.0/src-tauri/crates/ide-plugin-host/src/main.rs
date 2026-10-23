//! `yavin-extension-host`: started by Yavin for one workspace, speaking the extension protocol
//! on stdin/stdout (see the library). It is never meant to be run by hand.

/// The stack the extensions run on: well above the limit QuickJS keeps
/// (`runtime::MAX_STACK`), so recursion too deep is a script error, never an overflow of this
/// process's stack (found by the EXT-25 benchmark: Windows gives a main thread 1 MiB, which is
/// QuickJS's default limit, and an overflow ended the host).
const STACK: usize = 32 * 1024 * 1024;

fn main() {
    let code = std::thread::Builder::new()
        .name("extensions".into())
        .stack_size(STACK)
        .spawn(|| ide_plugin_host::run(std::io::stdin(), std::io::stdout().lock()))
        .expect("the extensions thread starts")
        .join()
        .unwrap_or(1);
    std::process::exit(code);
}
