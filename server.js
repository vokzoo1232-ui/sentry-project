// server.js - Hardened REST API
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { body, validationResult, param, query } = require('express-validator');

// Environment validation
if (!process.env.JWT_SECRET || !process.env.DB_PASSWORD) {
    console.error('❌ Missing required environment variables');
    console.error('Required: JWT_SECRET, DB_PASSWORD');
    process.exit(1);
}

const app = express();
const port = process.env.PORT || 3000;

// Database connection with error handling
const pool = new Pool({
    user: process.env.DB_USER || 'sentry_admin',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'sentry_db',
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT || 5432,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
    console.error('Unexpected database error:', err);
    // Don't exit - let the app try to recover
});

// Security middleware
app.use(helmet({
    contentSecurityPolicy: false, // Disable for API
}));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per windowMs
    message: 'Too many requests from this IP, please try again later.',
});
app.use('/api/', limiter);

// More strict limiter for auth endpoints
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    skipSuccessfulRequests: true,
});

app.use(cors({
    origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*',
    credentials: true,
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Request logging middleware
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
    next();
});

// Authentication middleware
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) {
        return res.status(401).json({ error: 'Unauthorized - No token provided' });
    }
    
    try {
        const user = jwt.verify(token, process.env.JWT_SECRET);
        req.user = user;
        next();
    } catch (err) {
        if (err.name === 'TokenExpiredError') {
            return res.status(401).json({ error: 'Token expired' });
        }
        return res.status(403).json({ error: 'Invalid token' });
    }
}

// Validation helpers
const validateSchoolId = param('school_id').isInt().withMessage('School ID must be an integer');
const validateRuleId = param('rule_id').isInt().withMessage('Rule ID must be an integer');

// Error handler
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// ===== AUTH ENDPOINTS =====

// Login with rate limiting
app.post('/api/auth/login', authLimiter, [
    body('email').isEmail().normalizeEmail(),
    body('password').isLength({ min: 8 }),
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }
    
    const { email, password } = req.body;
    
    try {
        const result = await pool.query(
            'SELECT id, school_id, password_hash, role, name FROM admins WHERE email = $1 AND is_active = true',
            [email]
        );
        
        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        const admin = result.rows[0];
        const valid = await bcrypt.compare(password, admin.password_hash);
        
        if (!valid) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        // Update last_login
        await pool.query(
            'UPDATE admins SET last_login = NOW() WHERE id = $1',
            [admin.id]
        );
        
        const token = jwt.sign(
            { id: admin.id, school_id: admin.school_id, role: admin.role },
            process.env.JWT_SECRET,
            { expiresIn: '24h' }
        );
        
        res.json({
            token,
            admin: {
                id: admin.id,
                school_id: admin.school_id,
                role: admin.role,
                name: admin.name,
                email: email
            }
        });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Refresh token
app.post('/api/auth/refresh', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, school_id, role FROM admins WHERE id = $1 AND is_active = true',
            [req.user.id]
        );
        
        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'User not found or inactive' });
        }
        
        const admin = result.rows[0];
        const newToken = jwt.sign(
            { id: admin.id, school_id: admin.school_id, role: admin.role },
            process.env.JWT_SECRET,
            { expiresIn: '24h' }
        );
        
        res.json({ token: newToken });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ===== RULE ENDPOINTS =====

// Get rules for a school
app.get('/api/schools/:school_id/rules', 
    authenticateToken, 
    validateSchoolId,
    async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }
        
        const { school_id } = req.params;
        
        // Check permission
        if (req.user.school_id !== parseInt(school_id) && req.user.role !== 'super_admin') {
            return res.status(403).json({ error: 'Access denied' });
        }
        
        try {
            const result = await pool.query(
                `SELECT * FROM rules 
                 WHERE school_id = $1 AND is_active = true
                 ORDER BY priority DESC`,
                [school_id]
            );
            
            res.json(result.rows);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    }
);

// Create rule with validation
app.post('/api/schools/:school_id/rules', 
    authenticateToken,
    validateSchoolId,
    [
        body('name').isString().notEmpty().isLength({ max: 255 }),
        body('type').isIn(['blacklist', 'whitelist', 'schedule']),
        body('pattern').isString().notEmpty(),
        body('action').isIn(['block', 'allow', 'warn']),
        body('priority').optional().isInt({ min: 0, max: 100 }),
        body('schedule').optional().isObject(),
    ],
    async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }
        
        const { school_id } = req.params;
        const { name, type, pattern, action, priority, schedule } = req.body;
        
        if (req.user.school_id !== parseInt(school_id) && req.user.role !== 'super_admin') {
            return res.status(403).json({ error: 'Access denied' });
        }
        
        try {
            const result = await pool.query(
                `INSERT INTO rules (school_id, name, type, pattern, action, priority, schedule, created_by, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
                 RETURNING *`,
                [school_id, name, type, pattern, action, priority || 0, schedule || null, req.user.id]
            );
            
            res.status(201).json(result.rows[0]);
        } catch (err) {
            if (err.code === '23505') {
                res.status(409).json({ error: 'Rule with this name already exists' });
            } else {
                res.status(500).json({ error: err.message });
            }
        }
    }
);

// ===== LOG ENDPOINTS =====

// Upload logs with validation
app.post('/api/schools/:school_id/logs', 
    authenticateToken,
    validateSchoolId,
    [
        body('logs').isArray({ min: 1, max: 1000 }),
        body('logs.*.window_title').optional().isString().trim(),
        body('logs.*.url').optional().isURL().trim(),
        body('logs.*.process_name').optional().isString().trim(),
        body('logs.*.timestamp').optional().isISO8601(),
    ],
    async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }
        
        const { school_id } = req.params;
        const logs = req.body.logs;
        
        if (req.user.school_id !== parseInt(school_id) && req.user.role !== 'super_admin') {
            return res.status(403).json({ error: 'Access denied' });
        }
        
        try {
            const values = [];
            const placeholders = logs.map((log, i) => {
                const offset = i * 5;
                values.push(
                    school_id,
                    log.window_title || null,
                    log.url || null,
                    log.process_name || null,
                    log.timestamp || new Date().toISOString()
                );
                return `($1, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5})`;
            });
            
            const query = `
                INSERT INTO logs (school_id, window_title, url, process_name, timestamp)
                VALUES ${placeholders.join(',')}
                RETURNING id
            `;
            
            const result = await pool.query(query, values);
            res.status(201).json({ success: true, count: result.rows.length });
        } catch (err) {
            console.error('Log upload error:', err);
            res.status(500).json({ error: 'Failed to upload logs' });
        }
    }
);

// Get logs with filters and pagination
app.get('/api/schools/:school_id/logs',
    authenticateToken,
    validateSchoolId,
    [
        query('start_date').optional().isISO8601(),
        query('end_date').optional().isISO8601(),
        query('user_id').optional().isInt(),
        query('limit').optional().isInt({ min: 1, max: 1000 }),
        query('offset').optional().isInt({ min: 0 }),
        query('search').optional().isString().trim(),
    ],
    async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }
        
        const { school_id } = req.params;
        const { 
            start_date, end_date, user_id, 
            limit = 100, offset = 0, search 
        } = req.query;
        
        if (req.user.school_id !== parseInt(school_id) && req.user.role !== 'super_admin') {
            return res.status(403).json({ error: 'Access denied' });
        }
        
        try {
            let query = 'SELECT * FROM logs WHERE school_id = $1';
            const params = [school_id];
            let paramCount = 2;
            
            if (start_date) {
                query += ` AND timestamp >= $${paramCount}`;
                params.push(start_date);
                paramCount++;
            }
            
            if (end_date) {
                query += ` AND timestamp <= $${paramCount}`;
                params.push(end_date);
                paramCount++;
            }
            
            if (user_id) {
                query += ` AND user_id = $${paramCount}`;
                params.push(user_id);
                paramCount++;
            }
            
            if (search) {
                query += ` AND (window_title ILIKE $${paramCount} OR url ILIKE $${paramCount})`;
                params.push(`%${search}%`);
                paramCount++;
            }
            
            query += ` ORDER BY timestamp DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
            params.push(limit, offset);
            
            const result = await pool.query(query, params);
            
            // Get total count
            const countQuery = `
                SELECT COUNT(*) FROM logs 
                WHERE school_id = $1
                ${start_date ? 'AND timestamp >= $2' : ''}
                ${end_date ? 'AND timestamp <= $3' : ''}
            `;
            const countParams = [school_id];
            if (start_date) countParams.push(start_date);
            if (end_date) countParams.push(end_date);
            
            const countResult = await pool.query(countQuery, countParams);
            
            res.json({
                data: result.rows,
                pagination: {
                    total: parseInt(countResult.rows[0].count),
                    limit: parseInt(limit),
                    offset: parseInt(offset),
                }
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    }
);

// ===== ADMIN ENDPOINTS =====

// Get school admins
app.get('/api/schools/:school_id/admins',
    authenticateToken,
    validateSchoolId,
    async (req, res) => {
        const { school_id } = req.params;
        
        if (req.user.school_id !== parseInt(school_id) && req.user.role !== 'super_admin') {
            return res.status(403).json({ error: 'Access denied' });
        }
        
        try {
            const result = await pool.query(
                'SELECT id, email, name, role, last_login, is_active FROM admins WHERE school_id = $1',
                [school_id]
            );
            
            res.json(result.rows);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    }
);

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// Database health check
app.get('/health/db', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ database: 'connected' });
    } catch (err) {
        res.status(503).json({ database: 'disconnected', error: err.message });
    }
});

// Start server
const server = app.listen(port, () => {
    console.log(`✅ Sentry API running on port ${port}`);
    console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    server.close(() => {
        console.log('HTTP server closed');
        pool.end(() => {
            console.log('Database pool closed');
            process.exit(0);
        });
    });
});

module.exports = app;