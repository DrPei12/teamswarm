#define _DARWIN_C_SOURCE
#include <errno.h>
#include <inttypes.h>
#include <libproc.h>
#include <mach/host_info.h>
#include <mach/mach.h>
#include <mach/mach_host.h>
#include <signal.h>
#include <spawn.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/event.h>
#include <sys/proc_info.h>
#include <sys/resource.h>
#include <sys/sysctl.h>
#include <sys/time.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

extern char **environ;
#define CONTROL 3
#define RECEIPT 4
#define COOKIE_PREFIX "TEAMSWARM_OWNED_GROUP="
#define PID_LIMIT 131072

typedef struct proc_bsdinfo Process;
static volatile sig_atomic_t stop_signal;
static void request_stop(int sig) { stop_signal = sig; }

static bool info(pid_t pid, Process *process) {
    return proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, process, sizeof(*process)) == (int)sizeof(*process);
}

static bool same_process(const Process *a, const Process *b) {
    return a->pbi_pid == b->pbi_pid && a->pbi_uid == b->pbi_uid &&
        a->pbi_start_tvsec == b->pbi_start_tvsec && a->pbi_start_tvusec == b->pbi_start_tvusec;
}

static pid_t *list_pids(int *count) {
    int wanted = proc_listallpids(NULL, 0);
    if (wanted <= 0 || wanted > PID_LIMIT - 256) return NULL;
    wanted += 256;
    pid_t *pids = calloc((size_t)wanted, sizeof(pid_t));
    if (!pids) return NULL;
    *count = proc_listallpids(pids, (int)(sizeof(pid_t) * (size_t)wanted));
    if (*count <= 0 || *count >= wanted) { free(pids); return NULL; }
    return pids;
}

static char *after_string(char *ptr, const char *end) {
    if (ptr >= end) return NULL;
    char *nul = memchr(ptr, 0, (size_t)(end - ptr));
    return nul ? nul + 1 : NULL;
}

static bool has_cookie(pid_t pid, const char *cookie, char *buffer, size_t capacity) {
    int mib[] = { CTL_KERN, KERN_PROCARGS2, pid };
    size_t size = capacity;
    if (sysctl(mib, 3, buffer, &size, NULL, 0) < 0 || size < sizeof(int)) return false;
    int argc;
    memcpy(&argc, buffer, sizeof(argc));
    if (argc <= 0 || (size_t)argc >= size) return false;
    const char *end = buffer + size;
    char *ptr = after_string(buffer + sizeof(argc), end);
    if (!ptr) return false;
    while (ptr < end && !*ptr) ++ptr;
    for (int i = 0; i < argc; ++i) {
        ptr = after_string(ptr, end);
        if (!ptr) return false;
    }
    const size_t length = strlen(cookie);
    while (ptr < end && *ptr) {
        char *next = after_string(ptr, end);
        if (!next) return false;
        if ((size_t)(next - ptr - 1) == length && memcmp(ptr, cookie, length) == 0) return true;
        ptr = next;
    }
    return false;
}

static void report(char code, int error) {
    char text[32];
    int length = error ? snprintf(text, sizeof(text), "%c %d\n", code, error) : snprintf(text, sizeof(text), "%c\n", code);
    if (write(RECEIPT, text, (size_t)length) < 0) { /* The owner can already have exited. */ }
}

static void report_started(pid_t root) {
    Process identity;
    if (!info(root, &identity)) { report('R', 0); return; }
    char text[96];
    int length = snprintf(text, sizeof(text), "R %d %" PRIu64 ".%06" PRIu64 "\n", root,
        (uint64_t)identity.pbi_start_tvsec, (uint64_t)identity.pbi_start_tvusec);
    if (length > 0 && write(RECEIPT, text, (size_t)length) < 0) { /* The owner can already have exited. */ }
}

static void pause_ms(long delay) {
    struct timespec pause = { .tv_sec = delay / 1000, .tv_nsec = (delay % 1000) * 1000000 };
    while (nanosleep(&pause, &pause) < 0 && errno == EINTR) {}
}

static unsigned long now_ms(void) {
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    return (unsigned long)now.tv_sec * 1000UL + (unsigned long)now.tv_nsec / 1000000UL;
}

static int signal_owned(const char *cookie, char *buffer, size_t capacity, int sig) {
    int count = 0;
    pid_t *pids = list_pids(&count);
    if (!pids) return -1;
    int found = 0;
    for (int i = 0; i < count; ++i) {
        pid_t pid = pids[i];
        if (pid <= 1 || pid == getpid()) continue;
        Process captured, current;
        if (!info(pid, &captured) || captured.pbi_uid != geteuid() || !has_cookie(pid, cookie, buffer, capacity)) continue;
        if (info(pid, &current) && same_process(&captured, &current)) {
            ++found;
            if (kill(pid, sig) < 0 && errno != ESRCH) { free(pids); return -1; }
        }
    }
    free(pids);
    return found;
}

static bool drain(pid_t root, bool *reaped, int *status, const char *cookie, char *arguments, size_t capacity) {
    unsigned long began = now_ms();
    int empty = 0;
    while (now_ms() - began < 5000) {
        int sig = now_ms() - began < 1500 ? SIGTERM : SIGKILL;
        if (!*reaped) {
            pid_t outcome = waitpid(root, status, WNOHANG);
            if (outcome == root) *reaped = true;
            else if (outcome == 0 && kill(root, sig) < 0 && errno != ESRCH) return false;
            else if (outcome < 0 && errno != EINTR) return false;
        }
        int matching = signal_owned(cookie, arguments, capacity, sig);
        if (matching < 0) return false;
        empty = matching == 0 && *reaped ? empty + 1 : 0;
        if (empty >= 2) return true;
        pause_ms(50);
    }
    return false;
}

static bool decimal(const char *text, pid_t *pid) {
    char *end;
    errno = 0;
    long value = strtol(text, &end, 10);
    if (errno || end == text || *end || value <= 1 || value > INT32_MAX) return false;
    *pid = (pid_t)value;
    return true;
}

static int run(int argc, char **argv) {
    pid_t parent;
    const char *token = argc >= 5 ? argv[3] : "";
    if (argc < 5 || !decimal(argv[2], &parent) || strlen(token) != 64 || strspn(token, "0123456789abcdef") != 64)
        return 125;
    (void)signal(SIGPIPE, SIG_IGN);
    (void)signal(SIGTERM, request_stop);
    (void)signal(SIGHUP, request_stop);
    int maxargs = 0;
    size_t length = sizeof(maxargs);
    if (sysctlbyname("kern.argmax", &maxargs, &length, NULL, 0) < 0 || maxargs < 4096 || maxargs > (16 << 20)) {
        report('N', EIO);
        return 125;
    }
    char *arguments = malloc((size_t)maxargs);
    if (!arguments) { report('N', ENOMEM); return 125; }
    char marker[sizeof(COOKIE_PREFIX) + 64];
    snprintf(marker, sizeof(marker), "%s%s", COOKIE_PREFIX, token);

    int queue = kqueue();
    struct kevent changes[4], event;
    EV_SET(&changes[0], parent, EVFILT_PROC, EV_ADD | EV_ONESHOT, NOTE_EXIT, 0, NULL);
    EV_SET(&changes[1], CONTROL, EVFILT_READ, EV_ADD | EV_CLEAR, 0, 0, NULL);
    EV_SET(&changes[2], SIGTERM, EVFILT_SIGNAL, EV_ADD, 0, 0, NULL);
    EV_SET(&changes[3], SIGHUP, EVFILT_SIGNAL, EV_ADD, 0, 0, NULL);
    struct timespec grant_timeout = { .tv_sec = 15 };
    char grant[2];
    if (queue < 0 || getppid() != parent || kevent(queue, changes, 4, NULL, 0, NULL) < 0 ||
            kevent(queue, NULL, 0, &event, 1, &grant_timeout) != 1 || event.filter != EVFILT_READ ||
            read(CONTROL, grant, sizeof(grant)) != (ssize_t)sizeof(grant) || memcmp(grant, "G\n", sizeof(grant)) ||
            (event.flags & EV_EOF) || getppid() != parent || stop_signal) {
        report('N', ECANCELED);
        return 125;
    }
    // Stable parent descriptors never enter the native target or its descendants.
    posix_spawn_file_actions_t files;
    posix_spawnattr_t attributes;
    int error = posix_spawn_file_actions_init(&files);
    if (!error) error = posix_spawn_file_actions_addclose(&files, CONTROL);
    if (!error) error = posix_spawn_file_actions_addclose(&files, RECEIPT);
    if (!error) error = posix_spawn_file_actions_addclose(&files, queue);
    if (!error) error = posix_spawnattr_init(&attributes);
    sigset_t reset, mask;
    sigemptyset(&reset);
    sigaddset(&reset, SIGTERM); sigaddset(&reset, SIGHUP); sigaddset(&reset, SIGPIPE);
    sigemptyset(&mask);
    if (!error) error = posix_spawnattr_setsigdefault(&attributes, &reset);
    if (!error) error = posix_spawnattr_setsigmask(&attributes, &mask);
    if (!error) error = posix_spawnattr_setpgroup(&attributes, 0);
    if (!error) error = posix_spawnattr_setflags(&attributes, POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK);
    if (!error && setenv("TEAMSWARM_OWNED_GROUP", token, 1) < 0) error = errno;
    pid_t root = 0;
    if (!error) error = posix_spawnp(&root, argv[4], &files, &attributes, &argv[4], environ);
    if (error) { report('N', error); return 125; }
    report_started(root);
    posix_spawn_file_actions_destroy(&files);
    posix_spawnattr_destroy(&attributes);
    EV_SET(&changes[0], root, EVFILT_PROC, EV_ADD | EV_ONESHOT, NOTE_EXIT, 0, NULL);
    bool watching = kevent(queue, changes, 1, NULL, 0, NULL) == 0;
    int status = 0;
    bool reaped = false;
    while (!stop_signal && getppid() == parent) {
        pid_t outcome = waitpid(root, &status, WNOHANG);
        if (outcome == root) { reaped = true; break; }
        if (outcome < 0 && errno != EINTR) break;
        struct timespec tick = { .tv_nsec = watching ? 250000000 : 50000000 };
        int ready = kevent(queue, NULL, 0, &event, 1, &tick);
        if (ready > 0 || (ready < 0 && errno != EINTR)) break;
    }
    bool confirmed = drain(root, &reaped, &status, marker, arguments, (size_t)maxargs);
    free(arguments);
    close(queue);
    report(confirmed ? 'E' : 'U', 0);
    if (!confirmed) return 125;
    return WIFEXITED(status) ? WEXITSTATUS(status) : WIFSIGNALED(status) ? 128 + WTERMSIG(status) : 125;
}

static int sample(pid_t root) {
    uint64_t total = 0;
    size_t size = sizeof(total);
    vm_statistics64_data_t vm = {0};
    mach_msg_type_number_t count = HOST_VM_INFO64_COUNT;
    host_t host = mach_host_self();
    vm_size_t page = 0;
    if (sysctlbyname("hw.memsize", &total, &size, NULL, 0) < 0 || !total ||
            host_page_size(host, &page) != KERN_SUCCESS ||
            host_statistics64(host, HOST_VM_INFO64, (host_info64_t)&vm, &count) != KERN_SUCCESS) return 125;
    mach_port_deallocate(mach_task_self(), host);
    // XNU includes speculative pages in free_count and purgeable pages in the reclaimable queues.
    uint64_t available = ((uint64_t)vm.free_count + vm.inactive_count) * page;
    if (available > total) available = total;
    int level = 0;
    size = sizeof(level);
    bool has_pressure = sysctlbyname("kern.memorystatus_vm_pressure_level", &level, &size, NULL, 0) == 0;
    int process_count = 0;
    pid_t *pids = list_pids(&process_count);
    if (!pids) return 125;
    Process *processes = calloc((size_t)process_count, sizeof(Process));
    bool *include = calloc((size_t)process_count, sizeof(bool));
    if (!processes || !include) return 125;
    for (int i = 0; i < process_count; ++i) if (pids[i] > 0 && pids[i] != getpid() && info(pids[i], &processes[i]))
        include[i] = pids[i] == root;
    bool changed;
    do {
        changed = false;
        for (int i = 0; i < process_count; ++i) if (!include[i] && processes[i].pbi_pid) {
            for (int j = 0; j < process_count; ++j) if (include[j] && processes[i].pbi_ppid == processes[j].pbi_pid &&
                    processes[i].pbi_start_tvsec >= processes[j].pbi_start_tvsec) {
                include[i] = true; changed = true; break;
            }
        }
    } while (changed);
    printf("{\"totalPhysical\":%" PRIu64 ",\"availablePhysical\":%" PRIu64 ",\"systemProcessCount\":%d,\"processCoverage\":\"descendants\",\"supervision\":\"native\"", total, available, process_count);
    if (has_pressure && (level == 1 || level == 2 || level == 4))
        printf(",\"memoryPressure\":\"%s\"", level == 4 ? "critical" : level == 2 ? "warning" : "normal");
    struct xsw_usage swap;
    size = sizeof(swap);
    if (sysctlbyname("vm.swapusage", &swap, &size, NULL, 0) == 0)
        printf(",\"swapTotalBytes\":%" PRIu64 ",\"swapUsedBytes\":%" PRIu64, (uint64_t)swap.xsu_total, (uint64_t)swap.xsu_used);
    printf(",\"processes\":[");
    bool first = true;
    for (int i = 0; i < process_count; ++i) if (include[i]) {
        struct rusage_info_v4 usage;
        Process current;
        if (proc_pid_rusage(pids[i], RUSAGE_INFO_V4, (rusage_info_t *)&usage) < 0 ||
                !info(pids[i], &current) || !same_process(&processes[i], &current)) continue;
        printf("%s{\"pid\":%d,\"parentPid\":%u,\"identity\":\"darwin:%" PRIu64 ".%06" PRIu64 "\",\"workingSet\":%" PRIu64 ",\"privateBytes\":%" PRIu64 ",\"cpuMilliseconds\":%" PRIu64 "}",
            first ? "" : ",", pids[i], current.pbi_ppid, (uint64_t)current.pbi_start_tvsec, (uint64_t)current.pbi_start_tvusec,
            (uint64_t)usage.ri_resident_size, (uint64_t)usage.ri_phys_footprint, (uint64_t)((usage.ri_user_time + usage.ri_system_time) / 1000000));
        first = false;
    }
    puts("]}");
    free(include); free(processes); free(pids);
    return 0;
}

static int sweep(pid_t root, const char *created, const char *token) {
    uint64_t seconds, microseconds;
    char extra;
    if (strlen(token) != 64 || strspn(token, "0123456789abcdef") != 64 ||
            sscanf(created, "%" SCNu64 ".%" SCNu64 "%c", &seconds, &microseconds, &extra) != 2 || microseconds > 999999)
        return 125;
    Process initial, current;
    if (!info(root, &initial) || initial.pbi_uid != geteuid() || initial.pbi_start_tvsec != seconds ||
            initial.pbi_start_tvusec != microseconds) return 125;
    int maxargs = 0;
    size_t size = sizeof(maxargs);
    if (sysctlbyname("kern.argmax", &maxargs, &size, NULL, 0) < 0 || maxargs < 4096 || maxargs > (16 << 20)) return 125;
    char *arguments = malloc((size_t)maxargs);
    if (!arguments) return 125;
    char marker[sizeof(COOKIE_PREFIX) + 64];
    snprintf(marker, sizeof(marker), "%s%s", COOKIE_PREFIX, token);
    if (!has_cookie(root, marker, arguments, (size_t)maxargs) || !info(root, &current) || !same_process(&initial, &current)) {
        free(arguments);
        return 125;
    }
    // A historical PID alone is never authority. The live root above pins this cleanup to its exact journaled group.
    unsigned long started = now_ms();
    int empty = 0;
    while (now_ms() - started < 5000) {
        int found = signal_owned(marker, arguments, (size_t)maxargs, now_ms() - started < 1500 ? SIGTERM : SIGKILL);
        if (found < 0) break;
        empty = found == 0 ? empty + 1 : 0;
        if (empty >= 2) { free(arguments); puts("owned-group-empty"); return 0; }
        pause_ms(50);
    }
    free(arguments);
    return 125;
}

int main(int argc, char **argv) {
    if (argc >= 2 && strcmp(argv[1], "run") == 0) return run(argc, argv);
    pid_t root;
    if (argc == 3 && strcmp(argv[1], "sample") == 0 && decimal(argv[2], &root)) return sample(root);
    if (argc == 5 && strcmp(argv[1], "sweep") == 0 && decimal(argv[2], &root)) return sweep(root, argv[3], argv[4]);
    return 125;
}
