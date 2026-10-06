//! `yavin-extension-host`: started by Yavin for one workspace, speaking the extension protocol
//! on stdin/stdout (see the library). It is never meant to be run by hand.

fn main() {
    let code = ide_plugin_host::run(std::io::stdin().lock(), std::io::stdout().lock());
    std::process::exit(code);
}
