//! The phone's corner watermark jobs (bridge.rs, /api/wm/...): a search over the pictures
//! the phone downloads, and those pictures without the watermark, made in memory. Nothing
//! is saved. Apart from the window's jobs (lib.rs, wm_jobs and WM_STOP): neither stops the
//! other.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::net::IpAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use crate::watermark::Corner;
use crate::{ai, wm_single, WmImage, WmSource};

/// A job nobody asked about for this long is forgotten (the phone is gone).
const IDLE: Duration = Duration::from_secs(10 * 60);
pub const MAX_REWARDS: usize = 5;
pub const MAX_FILES: usize = 2000;
/// Few pictures asked for: that many more of their reward are looked at, to learn the
/// text from (as many as the editor's tool takes), up to this many together.
const LEARN: usize = crate::WM_OTHERS_TEXT;
const ENOUGH: usize = 2 * LEARN;

fn locked<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Corner ids; None when there are none or one is unknown.
pub fn corners_of(ids: &[String]) -> Option<Vec<Corner>> {
    let mut out: Vec<Corner> = Vec::new();
    for id in ids {
        let c = Corner::from_id(id)?;
        if !out.contains(&c) {
            out.push(c);
        }
    }
    (!out.is_empty()).then_some(out)
}

/// The pictures of a reward to look at: the asked ones and some to learn from, in the
/// reward's order.
pub fn to_look_at(all: Vec<WmSource>, asked: &HashSet<i64>) -> Vec<WmSource> {
    let mine = all.iter().filter(|p| asked.contains(&p.0)).count();
    let more = LEARN.min(ENOUGH.saturating_sub(mine));
    let rest: Vec<String> = all.iter().filter(|p| !asked.contains(&p.0)).map(|p| p.1.clone()).collect();
    let learn: HashSet<String> = wm_single::spread(rest, more).into_iter().collect();
    all.into_iter().filter(|p| asked.contains(&p.0) || learn.contains(&p.1)).collect()
}

/// What the phone asks for: per reward the pictures, each as the phone wrote its path.
pub type Asked = BTreeMap<i64, Vec<(String, i64)>>;

/// The search over all of them: what comes off, by the path as the phone wrote it.
pub fn look(
    rewards: Vec<(Vec<WmSource>, Vec<(String, i64)>)>,
    corners: &[Corner],
    key: Option<[u8; 32]>,
    stop: &dyn Fn() -> bool,
    progress: &dyn Fn(usize, usize),
) -> Result<HashMap<String, Arc<WmImage>>, String> {
    let total: usize = rewards.iter().map(|r| r.0.len()).sum();
    let mut found = HashMap::new();
    let mut before = 0;
    for (pics, asked) in rewards {
        // two rounds, each picture counts half in each
        let round = |phase: &str, done: usize, of: usize| {
            progress(before + (done + if phase == "check" { of } else { 0 }) / 2, total)
        };
        let (images, _) = crate::wm_find_text(&pics, corners, key, stop, &round)?;
        let by_id: HashMap<i64, Arc<WmImage>> =
            images.into_iter().filter(|im| !im.own.is_empty()).map(|im| (im.id, Arc::new(im))).collect();
        for (path, id) in asked {
            if let Some(im) = by_id.get(&id) {
                found.insert(path, im.clone());
            }
        }
        before += pics.len();
    }
    progress(total, total);
    Ok(found)
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Phase {
    Scan,
    Ready,
    Failed,
}

struct State {
    phase: Phase,
    done: usize,
    total: usize,
    error: String,
    found: HashMap<String, Arc<WmImage>>,
    /// last asked about
    last: Instant,
    /// pictures being cleaned right now
    working: u32,
}

pub struct Job {
    pub id: String,
    device: Option<IpAddr>,
    idle: Duration,
    stop: AtomicBool,
    state: Mutex<State>,
    changed: Condvar,
}

impl Job {
    pub fn stopped(&self) -> bool {
        self.stop.load(Ordering::Relaxed)
    }

    /// Stopped, or nobody asked for too long.
    fn over(&self) -> bool {
        self.stopped() || self.left(&locked(&self.state)).is_zero()
    }

    /// Until it's forgotten. A picture being cleaned counts as asked.
    fn left(&self, s: &State) -> Duration {
        if s.working > 0 {
            self.idle
        } else {
            self.idle.saturating_sub(s.last.elapsed())
        }
    }

    fn end(&self) {
        self.stop.store(true, Ordering::Relaxed);
        let _held = locked(&self.state);
        self.changed.notify_all();
    }

    fn progress(&self, done: usize, total: usize) {
        let mut s = locked(&self.state);
        (s.done, s.total) = (done, total);
    }

    /// The answer of /api/wm/job.
    pub fn report(&self) -> serde_json::Value {
        let s = locked(&self.state);
        let name = match s.phase {
            Phase::Scan => "scan",
            Phase::Ready => "ready",
            Phase::Failed => "failed",
        };
        let mut found: Vec<&String> = s.found.keys().collect();
        found.sort();
        let mut out = serde_json::json!({ "state": name, "done": s.done, "total": s.total, "found": found });
        if s.phase == Phase::Failed {
            out["error"] = serde_json::json!(s.error);
        }
        out
    }

    pub fn found(&self, path: &str) -> Option<Arc<WmImage>> {
        locked(&self.state).found.get(path).cloned()
    }

    /// Held while one of its pictures is cleaned.
    pub fn work(&self) -> Working<'_> {
        locked(&self.state).working += 1;
        Working(self)
    }
}

pub struct Working<'a>(&'a Job);

impl Drop for Working<'_> {
    fn drop(&mut self) {
        let mut s = locked(&self.0.state);
        s.working -= 1;
        s.last = Instant::now();
        self.0.changed.notify_all();
    }
}

/// All the phone's jobs of one running bridge.
pub struct Jobs {
    list: Mutex<HashMap<String, Arc<Job>>>,
    /// a search runs (one at a time), and when it ends
    searching: Mutex<bool>,
    search_free: Condvar,
    /// a picture is being cleaned (one at a time)
    cleaning: AtomicBool,
    /// the bridge is off: nothing new
    off: AtomicBool,
    idle: Duration,
}

impl Default for Jobs {
    fn default() -> Self {
        Jobs::with_idle(IDLE)
    }
}

impl Jobs {
    pub fn with_idle(idle: Duration) -> Self {
        Jobs {
            list: Mutex::default(),
            searching: Mutex::new(false),
            search_free: Condvar::new(),
            cleaning: AtomicBool::new(false),
            off: AtomicBool::new(false),
            idle,
        }
    }

    /// A new job; the same device's earlier one ends. None when the bridge is off.
    pub fn open(&self, device: Option<IpAddr>) -> Option<Arc<Job>> {
        let mut raw = [0u8; 16];
        rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut raw);
        let job = Arc::new(Job {
            id: raw.iter().map(|b| format!("{b:02x}")).collect(),
            device,
            idle: self.idle,
            stop: AtomicBool::new(false),
            state: Mutex::new(State {
                phase: Phase::Scan,
                done: 0,
                total: 0,
                error: String::new(),
                found: HashMap::new(),
                last: Instant::now(),
                working: 0,
            }),
            changed: Condvar::new(),
        });
        let mut list = locked(&self.list);
        if self.off.load(Ordering::Relaxed) {
            return None;
        }
        list.retain(|_, j| {
            let old = j.device == device;
            if old {
                j.end();
            }
            !old
        });
        list.insert(job.id.clone(), job.clone());
        Some(job)
    }

    /// The job, and it counts as asked about.
    pub fn get(&self, id: &str) -> Option<Arc<Job>> {
        let job = locked(&self.list).get(id).cloned()?;
        locked(&job.state).last = Instant::now();
        Some(job)
    }

    /// Stops what runs for it and forgets it.
    pub fn close(&self, id: &str) {
        let job = locked(&self.list).remove(id);
        if let Some(j) = job {
            j.end();
        }
    }

    pub fn close_all(&self) {
        for (_, j) in locked(&self.list).drain() {
            j.end();
        }
    }

    /// The bridge goes off.
    pub fn shut(&self) {
        self.off.store(true, Ordering::Relaxed);
        self.close_all();
    }

    /// The one place for cleaning a picture, None while it's taken.
    pub fn clean_slot(&self) -> Option<CleanSlot<'_>> {
        self.cleaning
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .ok()
            .map(|_| CleanSlot(&self.cleaning))
    }

    /// Waits until no other search runs. None when the job is over before.
    fn search_slot(&self, job: &Job) -> Option<SearchSlot<'_>> {
        let mut busy = locked(&self.searching);
        while *busy {
            if job.over() {
                return None;
            }
            busy = self.search_free.wait_timeout(busy, Duration::from_millis(250)).unwrap_or_else(|e| e.into_inner()).0;
        }
        if job.over() {
            return None;
        }
        *busy = true;
        Some(SearchSlot(self))
    }

    /// Runs the job's search on its own thread, and forgets the job when it's over.
    /// `search` gets "stop?" and where it says how far it is.
    pub fn start(
        self: &Arc<Self>,
        job: Arc<Job>,
        search: impl FnOnce(&dyn Fn() -> bool, &dyn Fn(usize, usize)) -> Result<HashMap<String, Arc<WmImage>>, String>
            + Send
            + 'static,
    ) {
        let (jobs, id) = (self.clone(), job.id.clone());
        let run = move || {
            let got = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let _slot = jobs.search_slot(&job).ok_or_else(|| ai::STOPPED.to_string())?;
                let _awake = crate::awake::hold("looking for watermarks for the phone");
                search(&|| job.over(), &|done, total| job.progress(done, total))
            }));
            let mut s = locked(&job.state);
            match got {
                Ok(Ok(found)) => (s.phase, s.found) = (Phase::Ready, found),
                Ok(Err(e)) => {
                    // locked meanwhile: forgotten
                    if e == ai::STOPPED {
                        job.stop.store(true, Ordering::Relaxed);
                    }
                    (s.phase, s.error) = (Phase::Failed, e);
                }
                Err(_) => (s.phase, s.error) = (Phase::Failed, "the search failed".into()),
            }
            // until it's closed, or nobody asks any more
            loop {
                let left = job.left(&s);
                if job.stopped() || left.is_zero() {
                    break;
                }
                s = job.changed.wait_timeout(s, left).unwrap_or_else(|e| e.into_inner()).0;
            }
            drop(s);
            jobs.close(&job.id);
        };
        if std::thread::Builder::new().name("micoll-phone-wm".into()).spawn(run).is_err() {
            self.close(&id);
        }
    }
}

pub struct CleanSlot<'a>(&'a AtomicBool);

impl Drop for CleanSlot<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

struct SearchSlot<'a>(&'a Jobs);

impl Drop for SearchSlot<'_> {
    fn drop(&mut self) {
        *locked(&self.0.searching) = false;
        self.0.search_free.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pics(n: i64) -> Vec<WmSource> {
        (0..n).map(|i| (i, format!("{i:03}.jpg"), format!("{i:03}.jpg"), None)).collect()
    }

    #[test]
    fn few_asked_for_look_at_some_more() {
        let ids = |v: Vec<WmSource>| v.into_iter().map(|p| p.0).collect::<Vec<_>>();
        let asked = |r: std::ops::Range<i64>| r.collect::<HashSet<i64>>();
        // one of many: 24 more, spread over the reward, in order
        let got = ids(to_look_at(pics(200), &asked(7..8)));
        assert_eq!(got.len(), 25);
        assert!(got.contains(&7) && got.is_sorted() && *got.last().unwrap() > 150);
        // a small reward: all of it
        assert_eq!(to_look_at(pics(10), &asked(0..2)).len(), 10);
        // half of it, or all of it
        assert_eq!(to_look_at(pics(200), &asked(0..40)).len(), 48);
        assert_eq!(to_look_at(pics(200), &asked(0..100)).len(), 100);
        assert_eq!(ids(to_look_at(pics(60), &asked(0..60))), (0..60).collect::<Vec<_>>());
    }

    #[test]
    fn corners_are_all_known_or_none() {
        let ids = |l: &[&str]| corners_of(&l.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        assert_eq!(ids(&["br", "tl", "br"]), Some(vec![Corner::BottomRight, Corner::TopLeft]));
        assert_eq!(ids(&[]), None);
        assert_eq!(ids(&["br", "middle"]), None);
    }

    #[test]
    fn a_job_nobody_asks_about_is_forgotten_unless_it_works() {
        let jobs = Arc::new(Jobs::with_idle(Duration::from_millis(400)));
        let job = jobs.open(None).unwrap();
        jobs.start(job.clone(), |_, _| Ok(HashMap::new()));
        // asked about again and again: it stays
        for _ in 0..8 {
            std::thread::sleep(Duration::from_millis(100));
            assert!(jobs.get(&job.id).is_some());
        }
        // a picture that takes longer
        let work = job.work();
        std::thread::sleep(Duration::from_millis(900));
        assert!(!job.over() && locked(&jobs.list).contains_key(&job.id));
        drop(work);
        std::thread::sleep(Duration::from_millis(900));
        assert!(jobs.get(&job.id).is_none() && job.stopped());

        // also in the middle of its search
        let job = jobs.open(None).unwrap();
        let ended = Arc::new(AtomicBool::new(false));
        let e2 = ended.clone();
        jobs.start(job.clone(), move |stop, _| {
            while !stop() {
                std::thread::sleep(Duration::from_millis(10));
            }
            e2.store(true, Ordering::Relaxed);
            Err(ai::STOPPED.into())
        });
        std::thread::sleep(Duration::from_millis(900));
        assert!(ended.load(Ordering::Relaxed) && jobs.get(&job.id).is_none());
    }

    #[test]
    fn one_search_at_a_time_and_a_new_one_ends_the_devices_old_one() {
        let jobs = Arc::new(Jobs::default());
        let (a, b) = ("10.0.0.1".parse().ok(), "10.0.0.2".parse().ok());
        let running = Arc::new(Mutex::new((0u32, 0u32)));
        let start = |job: &Arc<Job>| {
            let running = running.clone();
            jobs.start(job.clone(), move |stop, _| {
                {
                    let mut r = locked(&running);
                    r.0 += 1;
                    r.1 = r.1.max(r.0);
                }
                let t = Instant::now();
                while !stop() && t.elapsed() < Duration::from_millis(600) {
                    std::thread::sleep(Duration::from_millis(5));
                }
                locked(&running).0 -= 1;
                Ok(HashMap::new())
            })
        };
        let first = jobs.open(a).unwrap();
        start(&first);
        let other = jobs.open(b).unwrap();
        start(&other);
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(other.report()["state"], "scan");
        let second = jobs.open(a).unwrap();
        start(&second);
        assert!(first.stopped() && jobs.get(&first.id).is_none());
        std::thread::sleep(Duration::from_millis(2500));
        assert_eq!(locked(&running).1, 1);
        assert_eq!((other.report()["state"].as_str(), second.report()["state"].as_str()), (Some("ready"), Some("ready")));
        assert!(jobs.get(&other.id).is_some() && second.id != other.id && second.id.len() == 32);

        // a search that breaks says so, the next one still runs
        let broken = jobs.open(a).unwrap();
        jobs.start(broken.clone(), |_, _| panic!("test"));
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(broken.report()["state"], "failed");
        let after = jobs.open(a).unwrap();
        jobs.start(after.clone(), |_, _| Ok(HashMap::new()));
        std::thread::sleep(Duration::from_millis(500));
        assert_eq!(after.report()["state"], "ready");

        // one picture at a time
        let slot = jobs.clean_slot();
        assert!(slot.is_some() && jobs.clean_slot().is_none());
        drop(slot);
        assert!(jobs.clean_slot().is_some());

        // off: everything ends, nothing new
        jobs.shut();
        assert!(other.stopped() && jobs.get(&after.id).is_none() && jobs.open(a).is_none());
    }
}
