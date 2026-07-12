// rule_engine.js - Hardened rule engine with caching
const crypto = require('crypto');

class RuleEngine {
    constructor(options = {}) {
        this.blacklist = new Set();
        this.whitelist = new Set();
        this.schedules = [];
        this.patterns = [];
        this.cacheTTL = options.cacheTTL || 60000; // 1 minute default
        this.lastLoadTime = 0;
        this.rulesHash = null;
        this.options = options;
    }
    
    loadRules(rules) {
        // Validate rules before loading
        if (!Array.isArray(rules)) {
            console.warn('Invalid rules format - expected array');
            return;
        }
        
        // Hash rules for change detection
        const rulesString = JSON.stringify(rules);
        const newHash = crypto.createHash('md5').update(rulesString).digest('hex');
        
        if (newHash === this.rulesHash) {
            return; // No changes
        }
        
        this.blacklist.clear();
        this.whitelist.clear();
        this.schedules = [];
        this.patterns = [];
        
        for (const rule of rules) {
            if (!rule.is_active) continue;
            
            switch(rule.type) {
                case 'blacklist':
                    this.blacklist.add(this.normalizePattern(rule.pattern));
                    break;
                case 'whitelist':
                    this.whitelist.add(this.normalizePattern(rule.pattern));
                    break;
                case 'schedule':
                    if (rule.schedule) {
                        this.schedules.push({
                            pattern: this.normalizePattern(rule.pattern),
                            schedule: rule.schedule,
                            action: rule.action
                        });
                    }
                    break;
                default:
                    this.patterns.push({
                        ...rule,
                        pattern: this.normalizePattern(rule.pattern)
                    });
            }
        }
        
        this.rulesHash = newHash;
        this.lastLoadTime = Date.now();
        
        console.log(`✅ Loaded ${rules.length} rules (${this.blacklist.size} blacklist, ${this.whitelist.size} whitelist)`);
    }
    
    normalizePattern(pattern) {
        if (typeof pattern !== 'string') return pattern;
        
        // Normalize URL patterns
        try {
            const url = new URL(pattern);
            return url.hostname + url.pathname;
        } catch {
            return pattern.toLowerCase().trim();
        }
    }
    
    shouldReload() {
        return Date.now() - this.lastLoadTime > this.cacheTTL;
    }
    
    evaluate(context) {
        // Check if cache expired
        if (this.shouldReload() && this.options.onReload) {
            this.options.onReload();
        }
        
        // Context: { window_title, url, process_name, timestamp }
        const results = [];
        
        // 1. Check whitelist first (override)
        let whitelisted = false;
        for (const pattern of this.whitelist) {
            if (this.matchPattern(pattern, context)) {
                whitelisted = true;
                results.push({
                    matched: true,
                    type: 'whitelist',
                    pattern: pattern,
                    action: 'allow'
                });
                break;
            }
        }
        
        // 2. If whitelisted, skip blacklist
        if (whitelisted) {
            return results;
        }
        
        // 3. Check blacklist
        for (const pattern of this.blacklist) {
            if (this.matchPattern(pattern, context)) {
                results.push({
                    matched: true,
                    type: 'blacklist',
                    pattern: pattern,
                    action: 'block'
                });
                return results; // Block immediately
            }
        }
        
        // 4. Check schedules
        const scheduleMatches = this.checkSchedules(context);
        if (scheduleMatches.length > 0) {
            results.push(...scheduleMatches);
            return results;
        }
        
        // 5. Pattern matching (regex or wildcard)
        for (const rule of this.patterns) {
            if (this.matchPattern(rule.pattern, context)) {
                results.push({
                    matched: true,
                    type: rule.type,
                    pattern: rule.pattern,
                    action: rule.action
                });
            }
        }
        
        return results;
    }
    
    matchPattern(pattern, context) {
        if (!pattern) return false;
        
        try {
            // Handle regex patterns
            if (typeof pattern === 'string') {
                // Check if it's a regex pattern
                if (pattern.startsWith('/') && pattern.endsWith('/')) {
                    const regex = new RegExp(pattern.slice(1, -1), 'i');
                    return this.checkAllFields(regex, context);
                }
                
                // Wildcard
                if (pattern.includes('*')) {
                    const regexPattern = pattern.replace(/\*/g, '.*');
                    const regex = new RegExp(`^${regexPattern}$`, 'i');
                    return this.checkAllFields(regex, context);
                }
                
                // Exact match
                return this.checkAllFields(pattern, context);
            }
        } catch (e) {
            console.warn('Invalid regex pattern:', pattern, e.message);
            return false;
        }
        
        return false;
    }
    
    checkAllFields(pattern, context) {
        const fields = ['window_title', 'url', 'process_name'];
        
        for (const field of fields) {
            const value = context[field];
            if (!value) continue;
            
            if (typeof pattern === 'string') {
                if (value.toLowerCase().includes(pattern.toLowerCase())) {
                    return true;
                }
            } else if (pattern instanceof RegExp) {
                // Reset lastIndex for regex
                const regex = new RegExp(pattern.source, pattern.flags);
                if (regex.test(value)) {
                    return true;
                }
            }
        }
        
        return false;
    }
    
    checkSchedules(context) {
        const now = context.timestamp ? new Date(context.timestamp) : new Date();
        const dayOfWeek = now.getDay(); // 0 = Sunday
        const time = now.getHours() * 60 + now.getMinutes();
        const matches = [];
        
        for (const schedule of this.schedules) {
            try {
                const { days, start, end } = schedule.schedule;
                
                // Check day
                if (days && !days.includes(dayOfWeek)) continue;
                
                // Check time
                const startMinutes = this.timeToMinutes(start);
                const endMinutes = this.timeToMinutes(end);
                
                if (time >= startMinutes && time <= endMinutes) {
                    // Check pattern
                    if (this.matchPattern(schedule.pattern, context)) {
                        matches.push({
                            matched: true,
                            type: 'schedule',
                            pattern: schedule.pattern,
                            action: schedule.action
                        });
                    }
                }
            } catch (e) {
                console.warn('Schedule evaluation error:', e.message);
            }
        }
        
        return matches;
    }
    
    timeToMinutes(timeStr) {
        if (!timeStr) return 0;
        const [hours, minutes] = timeStr.split(':').map(Number);
        return hours * 60 + minutes;
    }
    
    getActions(context) {
        const evaluations = this.evaluate(context);
        const actions = [];
        
        for (const evalResult of evaluations) {
            if (evalResult.action === 'block') {
                actions.push({
                    type: 'block',
                    rule: evalResult.pattern,
                    severity: 'high',
                    details: evalResult
                });
            } else if (evalResult.action === 'allow') {
                actions.push({
                    type: 'allow',
                    rule: evalResult.pattern,
                    severity: 'low',
                    details: evalResult
                });
            } else if (evalResult.action === 'warn') {
                actions.push({
                    type: 'warn',
                    rule: evalResult.pattern,
                    severity: 'medium',
                    details: evalResult
                });
            }
        }
        
        // If no actions, default allow
        if (actions.length === 0) {
            actions.push({
                type: 'allow',
                rule: 'default',
                severity: 'none'
            });
        }
        
        return actions;
    }
    
    // Stats
    getStats() {
        return {
            blacklist: this.blacklist.size,
            whitelist: this.whitelist.size,
            schedules: this.schedules.length,
            patterns: this.patterns.length,
            lastLoadTime: this.lastLoadTime,
            rulesHash: this.rulesHash,
            cacheAge: Date.now() - this.lastLoadTime
        };
    }
}

module.exports = RuleEngine;