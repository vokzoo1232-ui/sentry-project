// daemon.hpp - Header file for your daemon
#ifndef DAEMON_HPP
#define DAEMON_HPP

#include <string>
#include <vector>
#include <atomic>

class Daemon {
public:
    Daemon();
    ~Daemon();
    void run();

private:
    void setupSignals();
    void daemonize();
    void initDisplay();
    void loadConfig();
    void logActivity();
    void checkRules();
    void syncWithServer();
    std::string fetchRules();
    void blockWindow();

    std::string api_endpoint;
    std::string auth_token;
    void* display;  // X11 display
    bool has_display;
};

#endif