// daemon.cpp - Hardened background process
#include <iostream>
#include <fstream>
#include <thread>
#include <chrono>
#include <vector>
#include <string>
#include <cstring>
#include <sys/types.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <unistd.h>
#include <signal.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <syslog.h>
#include <cstdlib>
#include <atomic>

#ifdef __linux__
#include <X11/Xlib.h>
#include <X11/Xatom.h>
#include <sys/sysinfo.h>
#include <dirent.h>
#include <pwd.h>
#elif _WIN32
#include <windows.h>
#include <psapi.h>
#include <wininet.h>
#endif

static std::atomic<bool> running(true);

void handleSignal(int sig) {
    if (sig == SIGTERM || sig == SIGINT) {
        syslog(LOG_INFO, "Received shutdown signal %d", sig);
        running = false;
    }
}

class Daemon {
private:
    std::string api_endpoint;
    std::string auth_token;
    Display* display;
    bool has_display;

    struct ProcessInfo {
        std::string name;
        int pid;
        long memory_usage;
    };

    struct WindowInfo {
        std::string title;
        std::string url;
        std::string process_name;
    };

public:
    Daemon() : display(nullptr), has_display(false) {
        // Load config
        loadConfig();

        // Initialize X11 if available
        initDisplay();

        // Daemonize
        daemonize();

        // Setup signal handlers
        setupSignals();
    }

    ~Daemon() {
        if (display) {
            XCloseDisplay(display);
        }
        closelog();
    }

    void run() {
        syslog(LOG_INFO, "Daemon started successfully");

        while (running) {
            try {
                // Collect system data
                auto active_window = getActiveWindow();
                auto processes = getRunningProcesses();

                // Log data
                logActivity(active_window, processes);

                // Check rules
                checkRules(active_window, processes);

                // Sync with server
                syncWithServer();

                // Sleep to reduce CPU usage
                std::this_thread::sleep_for(std::chrono::seconds(5));

            }
            catch (const std::exception& e) {
                // Log error but keep running
                syslog(LOG_ERR, "Runtime error: %s", e.what());
            }
        }

        syslog(LOG_INFO, "Daemon shutting down gracefully");
    }

private:
    void setupSignals() {
        signal(SIGTERM, handleSignal);
        signal(SIGINT, handleSignal);
        signal(SIGHUP, handleSignal);
        signal(SIGPIPE, SIG_IGN);
    }

    void daemonize() {
#ifdef __linux__
        pid_t pid = fork();
        if (pid < 0) {
            syslog(LOG_ERR, "First fork failed");
            exit(EXIT_FAILURE);
        }
        if (pid > 0) exit(EXIT_SUCCESS);

        // Create new session
        if (setsid() < 0) {
            syslog(LOG_ERR, "setsid failed");
            exit(EXIT_FAILURE);
        }

        // Fork again
        pid = fork();
        if (pid < 0) {
            syslog(LOG_ERR, "Second fork failed");
            exit(EXIT_FAILURE);
        }
        if (pid > 0) exit(EXIT_SUCCESS);

        // Change directory
        chdir("/");

        // Reopen standard file descriptors to /dev/null
        int fd = open("/dev/null", O_RDWR);
        if (fd != -1) {
            dup2(fd, STDIN_FILENO);
            dup2(fd, STDOUT_FILENO);
            dup2(fd, STDERR_FILENO);
            if (fd > 2) close(fd);
        }

        // Clear umask
        umask(0);

        // Open syslog
        openlog("sentry", LOG_PID | LOG_NDELAY, LOG_DAEMON);
#endif
    }

    void initDisplay() {
#ifdef __linux__
        const char* display_env = getenv("DISPLAY");
        if (display_env && display_env[0] != '\0') {
            display = XOpenDisplay(nullptr);
            if (display) {
                has_display = true;
                syslog(LOG_INFO, "X11 display initialized: %s", display_env);
            }
            else {
                syslog(LOG_WARNING, "XOpenDisplay failed, running in headless mode");
            }
        }
        else {
            syslog(LOG_INFO, "No X11 display available, running in headless mode");
        }
#endif
    }

    void loadConfig() {
        std::ifstream config("/etc/sentry/config.conf");
        if (config.is_open()) {
            std::string line;
            while (std::getline(config, line)) {
                if (line.empty() || line[0] == '#') continue;

                size_t eq_pos = line.find('=');
                if (eq_pos != std::string::npos) {
                    std::string key = line.substr(0, eq_pos);
                    std::string value = line.substr(eq_pos + 1);

                    if (key == "API_ENDPOINT") {
                        api_endpoint = value;
                    }
                    else if (key == "AUTH_TOKEN") {
                        auth_token = value;
                    }
                }
            }
            config.close();
        }
        else {
            syslog(LOG_WARNING, "Config file not found, using defaults");
        }

        if (api_endpoint.empty()) {
            api_endpoint = "https://api.sentry.local/v1";
            syslog(LOG_WARNING, "Using default API endpoint: %s", api_endpoint.c_str());
        }
    }

    WindowInfo getActiveWindow() {
        WindowInfo info;
        info.url = "";

#ifdef __linux__
        if (!has_display || !display) {
            // Read from /proc or use fallback
            info.title = "Unknown (headless)";
            return info;
        }

        Window window;
        int revert;
        if (XGetInputFocus(display, &window, &revert) != Success) {
            syslog(LOG_DEBUG, "XGetInputFocus failed");
            return info;
        }

        if (window != None) {
            // Get window title
            char* window_name = nullptr;
            if (XFetchName(display, window, &window_name) == Success && window_name) {
                info.title = std::string(window_name);
                XFree(window_name);
            }

            // Try to get URL from Chrome/Firefox
            Atom actual_type;
            int actual_format;
            unsigned long nitems, bytes_after;
            unsigned char* prop = nullptr;

            Atom url_atom = XInternAtom(display, "_NET_WM_URL", False);
            if (XGetWindowProperty(display, window, url_atom, 0, 1024,
                False, XA_STRING, &actual_type, &actual_format,
                &nitems, &bytes_after, &prop) == Success) {
                if (prop) {
                    info.url = std::string(reinterpret_cast<char*>(prop));
                    XFree(prop);
                }
            }
        }
#elif _WIN32
        HWND hwnd = GetForegroundWindow();
        if (hwnd) {
            char window_title[256];
            if (GetWindowTextA(hwnd, window_title, sizeof(window_title))) {
                info.title = std::string(window_title);
            }
        }
#endif

        return info;
    }

    std::vector<ProcessInfo> getRunningProcesses() {
        std::vector<ProcessInfo> processes;

#ifdef __linux__
        DIR* dir = opendir("/proc");
        if (!dir) {
            syslog(LOG_ERR, "Cannot open /proc directory");
            return processes;
        }

        struct dirent* entry;
        while ((entry = readdir(dir)) != nullptr) {
            if (entry->d_type != DT_DIR) continue;

            bool is_number = true;
            for (int i = 0; entry->d_name[i] != '\0'; i++) {
                if (!isdigit(entry->d_name[i])) {
                    is_number = false;
                    break;
                }
            }
            if (!is_number) continue;

            int pid = std::stoi(entry->d_name);

            // Read process name
            std::string cmdline_path = "/proc/" + std::string(entry->d_name) + "/cmdline";
            std::ifstream cmdline(cmdline_path);
            if (cmdline.is_open()) {
                std::string name;
                std::getline(cmdline, name, '\0');
                cmdline.close();

                if (!name.empty()) {
                    // Get memory usage
                    std::string statm_path = "/proc/" + std::string(entry->d_name) + "/statm";
                    std::ifstream statm(statm_path);
                    if (statm.is_open()) {
                        long rss = 0;
                        statm >> rss;
                        statm.close();

                        long page_size = sysconf(_SC_PAGESIZE);
                        long memory_mb = (rss * page_size) / (1024 * 1024);

                        // Limit process list size
                        if (processes.size() < 100) {
                            processes.push_back({ name, pid, memory_mb });
                        }
                    }
                }
            }
        }
        closedir(dir);
#elif _WIN32
        DWORD process_ids[1024];
        DWORD cbNeeded;

        if (EnumProcesses(process_ids, sizeof(process_ids), &cbNeeded)) {
            DWORD count = cbNeeded / sizeof(DWORD);
            for (DWORD i = 0; i < count && i < 100; i++) {
                HANDLE hProcess = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ,
                    FALSE, process_ids[i]);
                if (hProcess) {
                    char process_name[MAX_PATH];
                    HMODULE hMod;
                    DWORD cbNeededMod;

                    if (EnumProcessModules(hProcess, &hMod, sizeof(hMod), &cbNeededMod)) {
                        GetModuleBaseNameA(hProcess, hMod, process_name, sizeof(process_name));

                        PROCESS_MEMORY_COUNTERS_EX pmc;
                        if (GetProcessMemoryInfo(hProcess, (PROCESS_MEMORY_COUNTERS*)&pmc,
                            sizeof(pmc))) {
                            long memory_mb = pmc.WorkingSetSize / (1024 * 1024);
                            processes.push_back({ process_name, (int)process_ids[i], memory_mb });
                        }
                    }
                    CloseHandle(hProcess);
                }
            }
        }
#endif

        return processes;
    }

    void logActivity(const WindowInfo& window, const std::vector<ProcessInfo>& processes) {
        // Write to local log
        std::ofstream log("/var/log/sentry/activity.log", std::ios::app);
        if (log.is_open()) {
            auto now = std::chrono::system_clock::now();
            auto time_t_now = std::chrono::system_clock::to_time_t(now);

            log << std::ctime(&time_t_now) << " | Window: " << window.title;
            if (!window.url.empty()) {
                log << " | URL: " << window.url;
            }
            log << std::endl;

            for (const auto& proc : processes) {
                log << "  Process: " << proc.name << " (PID: " << proc.pid
                    << ", Memory: " << proc.memory_usage << "MB)" << std::endl;
            }
            log.close();
        }
        else {
            syslog(LOG_ERR, "Cannot write to activity log");
        }
    }

    void checkRules(const WindowInfo& window, const std::vector<ProcessInfo>& processes) {
        // Fetch rules from server with cache TTL
        static time_t last_fetch = 0;
        static std::string cached_rules;

        time_t now = time(nullptr);
        if (now - last_fetch > 60) { // Refresh every minute
            cached_rules = fetchRules();
            last_fetch = now;
        }

        if (cached_rules.empty()) return;

        // Parse and apply rules
        // Whitelist check first (override)
        if (isWhitelisted(window.title) || isWhitelisted(window.url)) {
            return;
        }

        // Blacklist check
        if (isBlacklisted(window.title) || isBlacklisted(window.url)) {
            blockWindow(window);
            return;
        }

        // Schedule-based blocking
        if (isBlockedTime()) {
            blockWindow(window);
        }
    }

    bool isBlacklisted(const std::string& target) {
        // Check against local cache
        return false; // Placeholder
    }

    bool isWhitelisted(const std::string& target) {
        return false; // Placeholder
    }

    bool isBlockedTime() {
        auto now = std::chrono::system_clock::now();
        auto time_t_now = std::chrono::system_clock::to_time_t(now);
        struct tm* tm_now = localtime(&time_t_now);

        // Check if within blocking hours
        if (tm_now->tm_hour >= 22 || tm_now->tm_hour < 6) {
            return true;
        }
        return false;
    }

    void blockWindow(const WindowInfo& window) {
#ifdef __linux__
        if (has_display && display) {
            Window window_id;
            int revert;
            if (XGetInputFocus(display, &window_id, &revert) == Success && window_id != None) {
                XIconifyWindow(display, window_id, DefaultScreen(display));
                XFlush(display);
            }
        }
#elif _WIN32
        HWND hwnd = GetForegroundWindow();
        if (hwnd) {
            ShowWindow(hwnd, SW_MINIMIZE);
        }
#endif

        syslog(LOG_WARNING, "Blocked: %s", window.title.c_str());
    }

    std::string fetchRules() {
        // HTTP GET request to API with timeout
        // Implementation with libcurl would go here
        return "{}";
    }

    void syncWithServer() {
        // Upload logs with retry logic
        static int retry_count = 0;
        // Implementation with libcurl
        retry_count = 0;
    }
};

int main() {
    Daemon daemon;
    daemon.run();
    return 0;
}