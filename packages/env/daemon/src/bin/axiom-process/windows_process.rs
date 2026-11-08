use super::*;
use std::sync::Arc;
use std::fs::File;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::os::windows::ffi::OsStrExt;
use std::ffi::OsStr;
use windows_sys::Win32::Foundation::{HANDLE, HANDLE_FLAG_INHERIT, SetHandleInformation, WAIT_OBJECT_0};
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::Storage::FileSystem::{GetFileAttributesW, FILE_ATTRIBUTE_DIRECTORY, INVALID_FILE_ATTRIBUTES};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::JobObjects::{AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject, TerminateJobObject, QueryInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JobObjectExtendedLimitInformation, JobObjectBasicAccountingInformation, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE};
use windows_sys::Win32::System::Threading::{CreateProcessW, ResumeThread, WaitForSingleObject, GetExitCodeProcess, TerminateProcess, PROCESS_INFORMATION, STARTUPINFOEXW, LPPROC_THREAD_ATTRIBUTE_LIST, STARTF_USESTDHANDLES, CREATE_NO_WINDOW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, InitializeProcThreadAttributeList, UpdateProcThreadAttribute, DeleteProcThreadAttributeList, INFINITE};

pub struct Group {
    job: Arc<OwnedHandle>,
    armed: Arc<Mutex<bool>>,
}
#[derive(Clone)]
pub struct Target {
    job: Arc<OwnedHandle>,
    armed: Arc<Mutex<bool>>,
}
impl Group {
    pub fn target(&self) -> Target { Target { job: self.job.clone(), armed: self.armed.clone() } }
}
fn terminate(job: &OwnedHandle) -> io::Result<()> {
    if unsafe { TerminateJobObject(job.as_raw_handle() as _, 1) } == 0 { Err(io::Error::last_os_error()) } else { Ok(()) }
}
fn active(job: &OwnedHandle) -> io::Result<u32> {
    unsafe {
        let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = std::mem::zeroed();
        if QueryInformationJobObject(job.as_raw_handle() as _, JobObjectBasicAccountingInformation, (&mut info as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(), std::mem::size_of_val(&info) as u32, std::ptr::null_mut()) == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(info.ActiveProcesses)
        }
    }
}
pub fn abandon(target: &Target) -> ! {
    let mut armed = target.armed.lock().unwrap_or_else(|error| error.into_inner());
    if *armed { *armed = false; let _ = terminate(&target.job); }
    std::process::exit(1);
}
pub fn can_prove_empty(_group: &Group) -> bool { true }
pub fn proved_empty(group: &Group) -> io::Result<bool> { Ok(active(&group.job)? == 0) }
pub struct Child {
    process: OwnedHandle,
    pid: u32,
    pub stdin: Option<File>,
    pub stdout: Option<File>,
    pub stderr: Option<File>,
}
impl Child { pub fn id(&self) -> u32 { self.pid } }

fn wide(text: &str) -> io::Result<Vec<u16>> {
    if text.contains('\0') { return Err(io::Error::new(io::ErrorKind::InvalidInput, "embedded NUL")); }
    Ok(OsStr::new(text).encode_wide().chain(Some(0)).collect())
}
fn quote(arg: &str) -> String {
    let mut result = String::from("\"");
    let mut slashes = 0;
    for c in arg.chars() {
        if c == '\\' { slashes += 1; continue; }
        if c == '"' { result.extend(std::iter::repeat_n('\\', slashes * 2 + 1)); }
        else { result.extend(std::iter::repeat_n('\\', slashes)); }
        result.push(c);
        slashes = 0;
    }
    result.extend(std::iter::repeat_n('\\', slashes * 2));
    result.push('"');
    result
}
fn pipe() -> io::Result<(OwnedHandle, OwnedHandle)> {
    unsafe {
        let mut read = std::ptr::null_mut();
        let mut write = std::ptr::null_mut();
        let attrs = SECURITY_ATTRIBUTES { nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: std::ptr::null_mut(), bInheritHandle: 1 };
        if CreatePipe(&mut read, &mut write, &attrs, 0) == 0 { return Err(io::Error::last_os_error()); }
        Ok((OwnedHandle::from_raw_handle(read as _), OwnedHandle::from_raw_handle(write as _)))
    }
}
fn parent_end(handle: &OwnedHandle) -> io::Result<()> {
    if unsafe { SetHandleInformation(handle.as_raw_handle() as HANDLE, HANDLE_FLAG_INHERIT, 0) } == 0 { Err(io::Error::last_os_error()) } else { Ok(()) }
}
fn resolve(program: &str, cwd: &str, env: &serde_json::Map<String, Value>) -> io::Result<Vec<u16>> {
    let path = std::path::Path::new(program);
    let has_extension = path.extension().is_some();
    let mut dirs = vec![std::path::PathBuf::from(cwd)];
    if !program.contains(['\\', '/', ':']) {
        if let Some(path) = env.iter().find(|(key, _)| key.eq_ignore_ascii_case("PATH")).and_then(|(_, value)| value.as_str()) {
            dirs.extend(std::env::split_paths(path).map(|dir| {
                if dir.is_absolute() { dir } else { std::path::Path::new(cwd).join(dir) }
            }));
        }
    }
    for dir in dirs {
        let base = dir.join(path);
        let mut names = Vec::new();
        if has_extension { names.push(base.clone()); }
        for ext in ["com", "exe"] {
            let mut name = base.as_os_str().to_owned();
            name.push(".");
            name.push(ext);
            names.push(name.into());
        }
        for candidate in names {
            let candidate = wide(&candidate.to_string_lossy())?;
            let attributes = unsafe { GetFileAttributesW(candidate.as_ptr()) };
            if attributes != INVALID_FILE_ATTRIBUTES && attributes & FILE_ATTRIBUTE_DIRECTORY == 0 {
                return Ok(candidate);
            }
        }
    }
    Err(io::Error::new(io::ErrorKind::NotFound, format!("program not found: {program}")))
}
pub fn spawn(program: &str, args: &[&str], cwd: &str, env: &serde_json::Map<String, Value>, has_stdin: bool) -> io::Result<(Child, Group)> {
    let (in_read, in_write) = pipe()?;
    let (out_read, out_write) = pipe()?;
    let (err_read, err_write) = pipe()?;
    parent_end(&in_write)?; parent_end(&out_read)?; parent_end(&err_read)?;
    let application = resolve(program, cwd, env)?;
    let mut line = quote(program);
    for arg in args { line.push(' '); line.push_str(&quote(arg)); }
    let mut line = wide(&line)?;
    let cwd = wide(cwd)?;
    let mut entries = Vec::new();
    for (key, value) in env {
        let value = value.as_str().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid environment value"))?;
        if key.contains('=') || key.contains('\0') || value.contains('\0') { return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid environment")); }
        entries.push(format!("{key}={value}"));
    }
    entries.sort_by_key(|entry| entry.to_uppercase());
    let mut environment: Vec<u16> = Vec::new();
    for entry in entries { environment.extend(wide(&entry)?); }
    environment.push(0);
    if environment.len() == 1 { environment.push(0); }
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() { return Err(io::Error::last_os_error()); }
        let job = OwnedHandle::from_raw_handle(job as _);
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(job.as_raw_handle() as _, JobObjectExtendedLimitInformation, (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(), std::mem::size_of_val(&limits) as u32) == 0 { return Err(io::Error::last_os_error()); }
        let mut handles = [in_read.as_raw_handle() as HANDLE, out_write.as_raw_handle() as HANDLE, err_write.as_raw_handle() as HANDLE];
        let mut size = 0usize;
        InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut size);
        if size == 0 { return Err(io::Error::last_os_error()); }
        let mut attributes = vec![0usize; size.div_ceil(std::mem::size_of::<usize>())];
        if InitializeProcThreadAttributeList(attributes.as_mut_ptr().cast::<std::ffi::c_void>(), 1, 0, &mut size) == 0 { return Err(io::Error::last_os_error()); }
        struct AttributeList(LPPROC_THREAD_ATTRIBUTE_LIST);
        impl Drop for AttributeList { fn drop(&mut self) { unsafe { DeleteProcThreadAttributeList(self.0); } } }
        let list = AttributeList(attributes.as_mut_ptr().cast());
        if UpdateProcThreadAttribute(list.0, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize, handles.as_mut_ptr().cast::<std::ffi::c_void>(), std::mem::size_of_val(&handles), std::ptr::null_mut(), std::ptr::null()) == 0 { return Err(io::Error::last_os_error()); }
        let mut startup: STARTUPINFOEXW = std::mem::zeroed();
        startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = handles[0];
        startup.StartupInfo.hStdOutput = handles[1];
        startup.StartupInfo.hStdError = handles[2];
        startup.lpAttributeList = list.0;
        let mut info: PROCESS_INFORMATION = std::mem::zeroed();
        // bInheritHandles stays true; the list is the only set the child receives.
        if CreateProcessW(application.as_ptr(), line.as_mut_ptr(), std::ptr::null(), std::ptr::null(), 1, CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT, environment.as_ptr().cast(), cwd.as_ptr(), &startup.StartupInfo, &mut info) == 0 { return Err(io::Error::last_os_error()); }
        let process = OwnedHandle::from_raw_handle(info.hProcess as _);
        let thread = OwnedHandle::from_raw_handle(info.hThread as _);
        if AssignProcessToJobObject(job.as_raw_handle() as _, process.as_raw_handle() as _) == 0 || ResumeThread(thread.as_raw_handle() as _) == u32::MAX {
            let error = io::Error::last_os_error();
            TerminateProcess(process.as_raw_handle() as _, 1);
            return Err(error);
        }
        drop(in_read); drop(out_write); drop(err_write);
        let stdin = if has_stdin { Some(File::from(in_write)) } else { drop(in_write); None };
        Ok((Child { process, pid: info.dwProcessId, stdin, stdout: Some(File::from(out_read)), stderr: Some(File::from(err_read)) }, Group { job: Arc::new(job), armed: Arc::new(Mutex::new(true)) }))
    }
}
pub fn release(group: &mut Group) -> io::Result<()> {
    let mut armed = group.armed.lock().unwrap_or_else(|error| error.into_inner());
    if !*armed { return Ok(()); }
    unsafe {
        let info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        if SetInformationJobObject(group.job.as_raw_handle() as _, JobObjectExtendedLimitInformation, (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(), std::mem::size_of_val(&info) as u32) == 0 {
            return Err(io::Error::last_os_error());
        }
    }
    *armed = false;
    Ok(())
}
pub fn signal(group: &Group, signal: &str) -> io::Result<()> {
    if signal != "term" && signal != "kill" { return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid signal")); }
    terminate(&group.job)
}
pub fn wait(child: Child, group: &Group, output: Output) -> thread::JoinHandle<()> {
    let job = group.job.clone();
    let target = group.target();
    thread::spawn(move || {
        unsafe {
            if WaitForSingleObject(child.process.as_raw_handle() as _, INFINITE) != WAIT_OBJECT_0 {
                let _ = emit(&output, json!({"type":"error","message":io::Error::last_os_error().to_string()}));
                abandon(&target);
            }
            let mut code = 0;
            if GetExitCodeProcess(child.process.as_raw_handle() as _, &mut code) == 0 {
                let _ = emit(&output, json!({"type":"error","message":io::Error::last_os_error().to_string()}));
                abandon(&target);
            }
            if emit(&output, json!({"type":"exit","code":code})).is_err() { abandon(&target); }
        }
        loop {
            match active(&job) {
                Ok(0) => {
                    wait_for_output(&output);
                    if emit(&output, json!({"type":"empty"})).is_err() { abandon(&target); }
                    break;
                }
                Ok(_) => thread::sleep(std::time::Duration::from_millis(100)),
                Err(error) => uncertain(&format!("native group monitor failed: {error}; ownership uncertain"), &target),
            }
        }
    })
}
