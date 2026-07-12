// ============================================
// SENTRY API SERVER - COMPLETE & WORKING
// ============================================

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

// ============================================
// CONFIGURATION
// ============================================

const app = express();
const port = process.env.PORT || 3000;

// ============================================
// DATABASE CONNECTION
// ============================================

const pool = new Pool({
    connectionString: 'postgresql://neondb_owner:npg_0vhrNXQbP5wl@ep-crimson-water-at8rdny1.c-9.us-east-1.aws.neon.tech/neondb?sslmode=require',
    ssl: { rejectUnauthorized: false }
});

// Test database connection
pool.connect((err, client, release) => {
    if (err) {
        console.error('❌ Database connection error:', err.message);
    } else {
        console.log('✅ Database connected successfully!');
        release();
    }
});

// ============================================
// MIDDLEWARE
// ============================================

app.use(cors());                          // Allow frontend to talk to backend
app.use(express.json());                  // Parse JSON requests

// ============================================
// HEALTH CHECKS
// ============================================

// Basic health check
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
        res.status(503).json({
            database: 'disconnected',
            error: err.message
        });
    }
});

// Test endpoint
app.get('/api/test', (req, res) => {
    res.json({
        message: 'API is working!',
        time: new Date().toISOString()
    });
});

// ============================================
// AUTHENTICATION
// ============================================

// LOGIN - Uses database with bcrypt
app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;

    console.log(`🔍 Login attempt: ${email}`);

    // Validate input
    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password required' });
    }

    try {
        // Find user in database
        const result = await pool.query(
            'SELECT id, school_id, password_hash, role, name FROM admins WHERE email = $1 AND is_active = true',
            [email]
        );

        // Check if user exists
        if (result.rows.length === 0) {
            console.log(`❌ User not found: ${email}`);
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const admin = result.rows[0];
        console.log(`👤 User found: ${admin.email}`);

        // Compare password with hash
        const valid = await bcrypt.compare(password, admin.password_hash);
        console.log(`🔐 Password match: ${valid}`);

        if (!valid) {
            console.log(`❌ Invalid password for: ${email}`);
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        // Update last login time
        await pool.query(
            'UPDATE admins SET last_login = NOW() WHERE id = $1',
            [admin.id]
        );

        // Generate JWT token
        const token = jwt.sign(
            {
                id: admin.id,
                school_id: admin.school_id,
                role: admin.role,
                email: admin.email
            },
            process.env.JWT_SECRET || 'fallback-secret-key-change-this',
            { expiresIn: '24h' }
        );

        console.log(`✅ Login successful: ${email}`);

        // Send response
        res.json({
            token: token,
            admin: {
                id: admin.id,
                school_id: admin.school_id,
                role: admin.role,
                name: admin.name,
                email: admin.email
            }
        });

    } catch (err) {
        console.error('💥 Login error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================
// STUDENTS ENDPOINTS
// ============================================

// Get all students for a school
app.get('/api/schools/:school_id/students', async (req, res) => {
    const { school_id } = req.params;

    try {
        const result = await pool.query(
            'SELECT id, name, email, grade_level, class_section, is_active FROM students WHERE school_id = $1',
            [school_id]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching students:', err);
        res.status(500).json({ error: 'Failed to fetch students' });
    }
});

// ============================================
// RULES ENDPOINTS
// ============================================

// Get all rules for a school
app.get('/api/schools/:school_id/rules', async (req, res) => {
    const { school_id } = req.params;

    try {
        const result = await pool.query(
            'SELECT id, name, type, pattern, action, priority, is_active FROM rules WHERE school_id = $1 AND is_active = true ORDER BY priority DESC',
            [school_id]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching rules:', err);
        res.status(500).json({ error: 'Failed to fetch rules' });
    }
});

// Create a new rule
app.post('/api/schools/:school_id/rules', async (req, res) => {
    const { school_id } = req.params;
    const { name, type, pattern, action, priority } = req.body;

    try {
        const result = await pool.query(
            `INSERT INTO rules (school_id, name, type, pattern, action, priority, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, NOW())
             RETURNING *`,
            [school_id, name, type, pattern, action, priority || 0]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('Error creating rule:', err);
        res.status(500).json({ error: 'Failed to create rule' });
    }
});

// Delete a rule
app.delete('/api/schools/:school_id/rules/:rule_id', async (req, res) => {
    const { school_id, rule_id } = req.params;

    try {
        await pool.query(
            'DELETE FROM rules WHERE id = $1 AND school_id = $2',
            [rule_id, school_id]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('Error deleting rule:', err);
        res.status(500).json({ error: 'Failed to delete rule' });
    }
});

// ============================================
// LOGS ENDPOINTS
// ============================================

// Upload logs from daemon
app.post('/api/schools/:school_id/logs', async (req, res) => {
    const { school_id } = req.params;
    const { logs } = req.body;

    if (!logs || !Array.isArray(logs) || logs.length === 0) {
        return res.status(400).json({ error: 'No logs provided' });
    }

    try {
        const values = [];
        const placeholders = logs.map((log, i) => {
            const offset = i * 4;
            values.push(
                school_id,
                log.window_title || null,
                log.url || null,
                log.timestamp || new Date().toISOString()
            );
            return `($1, $${offset + 2}, $${offset + 3}, $${offset + 4})`;
        });

        const query = `
            INSERT INTO logs (school_id, window_title, url, timestamp)
            VALUES ${placeholders.join(',')}
            RETURNING id
        `;

        const result = await pool.query(query, values);
        res.json({ success: true, count: result.rows.length });
    } catch (err) {
        console.error('Error uploading logs:', err);
        res.status(500).json({ error: 'Failed to upload logs' });
    }
});

// Get logs for a school
app.get('/api/schools/:school_id/logs', async (req, res) => {
    const { school_id } = req.params;
    const { limit = 50 } = req.query;

    try {
        const result = await pool.query(
            'SELECT id, window_title, url, timestamp, blocked FROM logs WHERE school_id = $1 ORDER BY timestamp DESC LIMIT $2',
            [school_id, limit]
        );
        res.json({ data: result.rows });
    } catch (err) {
        console.error('Error fetching logs:', err);
        res.status(500).json({ error: 'Failed to fetch logs' });
    }
});

// ============================================
// ADMIN ENDPOINTS
// ============================================

// Get all admins for a school
app.get('/api/schools/:school_id/admins', async (req, res) => {
    const { school_id } = req.params;

    try {
        const result = await pool.query(
            'SELECT id, email, name, role, last_login, is_active FROM admins WHERE school_id = $1',
            [school_id]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching admins:', err);
        res.status(500).json({ error: 'Failed to fetch admins' });
    }
});

// ============================================
// START SERVER
// ============================================

app.listen(port, () => {
    console.log(`✅ Sentry API running on port ${port}`);
    console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🌐 Health check: http://localhost:${port}/health`);
});

// ============================================
// GRACEFUL SHUTDOWN
// ============================================

process.on('SIGTERM', () => {
    console.log('🛑 Shutting down...');
    pool.end(() => {
        console.log('Database pool closed');
        process.exit(0);
    });
});

module.exports = app;