// server.js - SIMPLIFIED AND FIXED
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3000;

// ===== DATABASE =====
const pool = new Pool({
    connectionString: 'postgresql://neondb_owner:npg_0vhrNXQbP5wl@ep-crimson-water-at8rdny1.c-9.us-east-1.aws.neon.tech/neondb?sslmode=require',
    ssl: { rejectUnauthorized: false }
});

// ===== MIDDLEWARE =====
app.use(cors());
app.use(express.json());

// ===== HEALTH CHECKS =====
app.get('/health', (req, res) => {
    res.json({ status: 'healthy', time: new Date().toISOString() });
});

app.get('/health/db', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ database: 'connected' });
    } catch (err) {
        res.json({ database: 'disconnected', error: err.message });
    }
});

// ===== AUTH =====
app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    
    console.log('Login attempt:', email);
    
    try {
        // Get user from database
        const result = await pool.query(
            'SELECT * FROM admins WHERE email = $1',
            [email]
        );
        
        if (result.rows.length === 0) {
            console.log('User not found:', email);
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        const user = result.rows[0];
        console.log('User found:', user.email);
        console.log('Hash in DB:', user.password_hash);
        
        // Compare passwords
        const match = await bcrypt.compare(password, user.password_hash);
        console.log('Password match?', match);
        
        if (!match) {
            console.log('Password mismatch for:', email);
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        // Create token
        const token = jwt.sign(
            { 
                id: user.id, 
                school_id: user.school_id,
                email: user.email,
                role: user.role 
            },
            'my-secret-key-change-this',
            { expiresIn: '24h' }
        );
        
        console.log('Login successful:', email);
        
        res.json({
            success: true,
            token: token,
            admin: {
                id: user.id,
                school_id: user.school_id,
                email: user.email,
                name: user.name,
                role: user.role
            }
        });
        
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ===== TEST ENDPOINT =====
app.get('/api/test', (req, res) => {
    res.json({ 
        message: 'API is working!',
        time: new Date().toISOString(),
        env: process.env.NODE_ENV || 'development'
    });
});

// ===== START =====
app.listen(port, () => {
    console.log(`✅ Server running on port ${port}`);
    console.log(`🌐 http://localhost:${port}`);
});