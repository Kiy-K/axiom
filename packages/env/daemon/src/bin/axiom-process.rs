//! Retained process group controlled over JSON lines and emitting binary frames.

pub(crate) use serde_json::{Value, json};
pub(crate) use std::io::{self, BufRead, Read, Write};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, mpsc};
pub(crate) use std::thread;
use std::sync::atomic::{AtomicBool, Ordering};

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn decode(text: &str) -> Result<Vec<u8>, &'static str> {
    let bytes = text.as_bytes();
    if bytes.len() % 4 != 0 { return Err("invalid base64"); }
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for (index, chunk) in bytes.chunks_exact(4).enumerate() {
        let last = index + 1 == bytes.len() / 4;
        let value = |b| ALPHABET.iter().position(|&c| c == b).map(|n| n as u32).ok_or("invalid base64");
        let a = value(chunk[0])?;
        let b = value(chunk[1])?;
        let c = if chunk[2] == b'=' { 0 } else { value(chunk[2])? };
        let d = if chunk[3] == b'=' { 0 } else { value(chunk[3])? };
        if (!last && (chunk[2] == b'=' || chunk[3] == b'=')) || (chunk[2] == b'=' && chunk[3] != b'=') { return Err("invalid base64"); }
        let n = (a << 18) | (b << 12) | (c << 6) | d;
        out.push((n >> 16) as u8);
        if chunk[2] != b'=' { out.push((n >> 8) as u8); }
        if chunk[3] != b'=' { out.push(n as u8); }
    }
    Ok(out)
}

pub(crate) struct Out {
    stdout: Mutex<io::Stdout>,
    broken: AtomicBool,
    stdout_done: AtomicBool,
    stderr_done: AtomicBool,
}
pub(crate) type Output = Arc<Out>;
fn frame(output: &Output, kind: u8, bytes: &[u8]) -> io::Result<()> {
    if output.broken.load(Ordering::Relaxed) {
        return Err(io::Error::new(io::ErrorKind::BrokenPipe, "output closed"));
    }
    let mut out = output.stdout.lock().map_err(|_| io::Error::other("output lock poisoned"))?;
    let mut header = [0u8; 5];
    header[0] = kind;
    header[1..].copy_from_slice(&(bytes.len() as u32).to_be_bytes());
    if let Err(error) = out.write_all(&header).and_then(|()| out.write_all(bytes)).and_then(|()| out.flush()) {
        output.broken.store(true, Ordering::Relaxed);
        return Err(error);
    }
    Ok(())
}
pub(crate) fn emit(output: &Output, value: Value) -> io::Result<()> {
    frame(output, b'J', &serde_json::to_vec(&value).map_err(io::Error::other)?)
}
pub(crate) fn uncertain(message: &str, target: &platform::Target) -> ! {
    let _ = writeln!(io::stderr(), "{message}");
    let _ = io::stderr().flush();
    platform::abandon(target);
}
fn reader(mut pipe: impl Read + Send + 'static, kind: &'static str, output: Output, kill: platform::Target) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut buffer = [0u8; 16384];
        loop {
            match pipe.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => {
                    if frame(&output, if kind == "stdout" { b'O' } else { b'E' }, &buffer[..n]).is_err() {
                        platform::abandon(&kill);
                    }
                }
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) => {
                    if emit(&output, json!({"type":"error","message":e.to_string()})).is_err() {
                        platform::abandon(&kill);
                    }
                    break;
                }
            }
        }
        if emit(&output, json!({"type":format!("{kind}_end")})).is_err() {
            platform::abandon(&kill);
        }
        if kind == "stdout" { &output.stdout_done } else { &output.stderr_done }.store(true, Ordering::Release);
    })
}

pub(crate) fn wait_for_output(output: &Output) {
    while !output.stdout_done.load(Ordering::Acquire) || !output.stderr_done.load(Ordering::Acquire) {
        thread::sleep(std::time::Duration::from_millis(10));
    }
}

#[cfg(unix)]
mod platform {
    use super::*;
    use std::sync::Arc;
    use std::os::unix::process::CommandExt;
    #[cfg(target_os = "linux")]
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    #[cfg(target_os = "linux")]
    use std::os::unix::process::ExitStatusExt;
    #[derive(Clone)]
    pub struct Target {
        pid: u32,
        armed: Arc<Mutex<bool>>,
        #[cfg(target_os = "linux")]
        pidfd: Option<Arc<OwnedFd>>,
    }
    pub struct Group { target: Target }
    impl Group { pub fn target(&self) -> Target { self.target.clone() } }
    impl Drop for Group {
        fn drop(&mut self) {
            let mut armed = self.target.armed.lock().unwrap_or_else(|error| error.into_inner());
            if *armed { *armed = false; let _ = signal(self, "kill"); }
        }
    }
    pub fn release(group: &mut Group) -> io::Result<()> {
        *group.target.armed.lock().unwrap_or_else(|error| error.into_inner()) = false;
        Ok(())
    }
    pub fn abandon(target: &Target) -> ! {
        let mut armed = target.armed.lock().unwrap_or_else(|error| error.into_inner());
        if *armed { *armed = false; let _ = signal_target(target, "kill"); }
        // A blocked stdout flush must not keep the owner alive after group termination.
        #[cfg(target_os = "linux")]
        unsafe { libc::_exit(1) }
        #[cfg(not(target_os = "linux"))]
        std::process::exit(1)
    }
    pub fn configure(command: &mut Command) {
        // SAFETY: setsid is async-signal-safe and runs before exec.
        unsafe { command.pre_exec(|| if libc::setsid() < 0 { Err(io::Error::last_os_error()) } else { Ok(()) }); }
    }
    pub fn group(child: &std::process::Child) -> io::Result<Group> {
        #[cfg(target_os = "linux")]
        let pidfd = {
            // SAFETY: pidfd_open returns a new descriptor or an error.
            let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, child.id(), 0) } as i32;
            if fd < 0 { None } else {
                let fd = unsafe { OwnedFd::from_raw_fd(fd) };
                if group_signal(&fd, 0).is_ok() { Some(Arc::new(fd)) } else { None }
            }
        };
        Ok(Group { target: Target { pid: child.id(), armed: Arc::new(Mutex::new(true)), #[cfg(target_os = "linux")] pidfd } })
    }
    #[cfg(target_os = "linux")]
    fn group_signal(fd: &OwnedFd, signal: i32) -> io::Result<()> {
        // SAFETY: the pidfd is owned. Flag 4 is PIDFD_SIGNAL_PROCESS_GROUP; null siginfo is valid for ordinary signals.
        if unsafe { libc::syscall(libc::SYS_pidfd_send_signal, fd.as_raw_fd(), signal, std::ptr::null::<libc::siginfo_t>(), 4u32) } == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }
    fn signal_target(target: &Target, signal: &str) -> io::Result<()> {
        let signal = match signal { "term" => libc::SIGTERM, "kill" => libc::SIGKILL, _ => return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid signal")) };
        #[cfg(target_os = "linux")]
        if let Some(fd) = &target.pidfd {
            return match group_signal(fd, signal) {
                // ESRCH is the retained kernel PID's group, not a recycled numeric id.
                Err(error) if error.raw_os_error() == Some(libc::ESRCH) => Ok(()),
                result => result,
            };
        }
        // SAFETY: the unreaped leader pins the process group identity until close.
        if unsafe { libc::kill(-(target.pid as i32), signal) } == 0 { Ok(()) } else {
            let e = io::Error::last_os_error();
            if e.raw_os_error() == Some(libc::ESRCH) { Ok(()) } else { Err(e) }
        }
    }
    pub fn signal(group: &Group, signal: &str) -> io::Result<()> { signal_target(&group.target, signal) }
    pub fn can_prove_empty(group: &Group) -> bool {
        #[cfg(target_os = "linux")]
        { group.target.pidfd.is_some() }
        #[cfg(not(target_os = "linux"))]
        { let _ = group; false }
    }
    pub fn proved_empty(group: &Group) -> io::Result<bool> {
        #[cfg(target_os = "linux")]
        if let Some(fd) = &group.target.pidfd {
            return match group_signal(fd, 0) {
                Err(error) if error.raw_os_error() == Some(libc::ESRCH) => Ok(true),
                Err(error) if error.kind() == io::ErrorKind::Interrupted => Ok(false),
                Ok(()) => Ok(false),
                Err(error) => Err(error),
            };
        }
        #[cfg(not(target_os = "linux"))]
        { let _ = group; }
        Ok(false)
    }
    pub fn wait(mut child: std::process::Child, group: &Group, output: Output) -> thread::JoinHandle<()> {
        let target = group.target();
        thread::spawn(move || {
            #[cfg(target_os = "linux")]
            if let Some(pidfd) = target.pidfd.clone() {
                match child.wait() {
                    Ok(status) => {
                        if emit(&output, json!({"type":"exit","code":status.code().unwrap_or_else(|| 128 + status.signal().unwrap_or(0))})).is_err() {
                            abandon(&target);
                        }
                    }
                    Err(error) => {
                        let _ = emit(&output, json!({"type":"error","message":error.to_string()}));
                        abandon(&target);
                    }
                }
                loop {
                    match group_signal(&pidfd, 0) {
                        // Retained pidfd group lookup: ESRCH only after no member remains.
                        Err(error) if error.raw_os_error() == Some(libc::ESRCH) => {
                            wait_for_output(&output);
                            if emit(&output, json!({"type":"empty"})).is_err() { abandon(&target); }
                            return;
                        }
                        Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                        Err(error) => uncertain(&format!("native group monitor failed: {error}; ownership uncertain"), &target),
                        Ok(()) => thread::sleep(std::time::Duration::from_millis(100)),
                    }
                }
            }
            let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
            loop {
                // SAFETY: info is valid and WNOWAIT pins the leader until this helper exits.
                if unsafe { libc::waitid(libc::P_PID, child.id() as libc::id_t, &mut info, libc::WEXITED | libc::WNOWAIT) } == 0 { break; }
                let e = io::Error::last_os_error();
                if e.kind() != io::ErrorKind::Interrupted {
                    let _ = emit(&output, json!({"type":"error","message":e.to_string()}));
                    abandon(&target);
                }
            }
            let status = unsafe { info.si_status() };
            let code = if info.si_code == libc::CLD_EXITED { status } else { 128 + status };
            if emit(&output, json!({"type":"exit","code":code})).is_err() { abandon(&target); }
            // Keep Child alive and unreaped until the helper exits. Not an emptiness proof.
            loop { thread::park(); }
        })
    }
}

#[cfg(windows)]
#[path = "axiom-process/windows_process.rs"]
mod platform;

fn run(output: &Output) -> Result<(), Box<dyn std::error::Error>> {
    let stdin = io::stdin();
    let mut lines = stdin.lock().lines();
    let start: Value = serde_json::from_str(&lines.next().ok_or("missing start")??)?;
    if start["type"] != "start" { return Err("expected start".into()); }
    let program = start["command"].as_str().ok_or("missing command")?;
    let args = start["args"].as_array().ok_or("missing args")?.iter().map(|v| v.as_str().ok_or("invalid argument")).collect::<Result<Vec<_>, _>>()?;
    let env = start["env"].as_object().ok_or("missing env")?;
    let cwd = start["cwd"].as_str().ok_or("missing cwd")?;
    let has_stdin = start["stdin"].as_bool().ok_or("missing stdin")?;
    #[cfg(unix)]
    let (mut child, mut group) = {
        let mut command = Command::new(program);
        command.args(&args).current_dir(cwd).env_clear().stdout(Stdio::piped()).stderr(Stdio::piped());
        for (key, value) in env { command.env(key, value.as_str().ok_or("invalid environment value")?); }
        command.stdin(if has_stdin { Stdio::piped() } else { Stdio::null() });
        platform::configure(&mut command);
        let mut child = command.spawn()?;
        let group = match platform::group(&child) { Ok(group) => group, Err(e) => { let _ = child.kill(); let _ = child.wait(); return Err(e.into()); } };
        (child, group)
    };
    #[cfg(windows)]
    let (mut child, mut group) = platform::spawn(program, &args, cwd, env, has_stdin)?;
    let kill = group.target();
    if emit(output, json!({"type":"spawn","pid":child.id(),"proves_empty":platform::can_prove_empty(&group)})).is_err() { platform::abandon(&kill); }
    let stdout = reader(child.stdout.take().ok_or("missing stdout")?, "stdout", output.clone(), kill.clone());
    let stderr = reader(child.stderr.take().ok_or("missing stderr")?, "stderr", output.clone(), kill.clone());
    let (tx, rx) = mpsc::channel::<Option<(Value, Vec<u8>)>>();
    if let Some(mut input) = child.stdin.take() {
        let output = output.clone();
        let kill = kill.clone();
        thread::spawn(move || {
            let mut failure: Option<String> = None;
            for data in rx {
                match data {
                    Some((id, bytes)) => {
                        if failure.is_none() {
                            failure = input.write_all(&bytes).err().map(|error| error.to_string());
                        }
                        let sent = if let Some(error) = &failure {
                            emit(&output, json!({"type":"input_result","id":id,"error":error}))
                        } else {
                            emit(&output, json!({"type":"input_result","id":id}))
                        };
                        if sent.is_err() { platform::abandon(&kill); }
                    }
                    None => break,
                }
            }
        });
    }
    let waiter = platform::wait(child, &group, output.clone());
    for line in lines {
        let line = line?;
        let request: Value = serde_json::from_str(&line)?;
        match request["type"].as_str() {
            Some("input") => { let id = request.get("id").ok_or("missing input id")?.clone(); let bytes = decode(request["data"].as_str().ok_or("missing input")?)?; tx.send(Some((id, bytes))).map_err(|_| "stdin closed")?; }
            Some("end_input") => { let _ = tx.send(None); }
            Some("signal") => platform::signal(&group, request["signal"].as_str().ok_or("missing signal")?)?,
            Some("close") => { platform::release(&mut group)?; return Ok(()); }
            Some("cleanup") => {
                #[cfg(target_os = "linux")]
                {
                    let target = group.target();
                    // A protocol write can block the cleanup thread past its deadline.
                    thread::spawn(move || {
                        thread::sleep(std::time::Duration::from_secs(5));
                        platform::abandon(&target);
                    });
                }
                if platform::signal(&group, "kill").is_err() || !platform::can_prove_empty(&group) {
                    platform::abandon(&group.target());
                }
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
                loop {
                    match platform::proved_empty(&group) {
                        Ok(true) if stdout.is_finished() && stderr.is_finished() && waiter.is_finished() => {
                            if emit(output, json!({"type":"cleaned"})).is_err() { platform::abandon(&group.target()); }
                            let _ = platform::release(&mut group);
                            return Ok(());
                        }
                        Ok(_) if std::time::Instant::now() < deadline => thread::sleep(std::time::Duration::from_millis(100)),
                        _ => uncertain("native cleanup could not be confirmed", &group.target()),
                    }
                }
            }
            _ => return Err("unknown request".into()),
        }
    }
    platform::signal(&group, "kill")?;
    Ok(())
}

fn main() {
    let output = Arc::new(Out { stdout: Mutex::new(io::stdout()), broken: AtomicBool::new(false), stdout_done: AtomicBool::new(false), stderr_done: AtomicBool::new(false) });
    if let Err(error) = run(&output) {
        let _ = emit(&output, json!({"type":"error","message":error.to_string()}));
        std::process::exit(1);
    }
}
