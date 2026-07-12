const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ===== HARDCODED LOGIN (NO DATABASE) =====
app.post('/api/auth/login', (req, res) => {
    const { email, password } = req.body;
    
    console.log('📧 Login attempt:', email);
    console.log('🔑 Password:', password);
    
    // HARDCODED - Accepts ONLY this email and password
    if (email === 'admin@school.com' && password === 'password123') {
        console.log('✅ Login successful!');
        
        const token = jwt.sign(
            { id: 1, school_id: 1, role: 'super_admin', email: 'admin@school.com' },
            'my-secret-key',
            { expiresIn: '24h' }
        );
        
        return res.json({
            token: token,
            admin: {
                id: 1,
                school_id: 1,
                email: 'admin@school.com',
                name: 'Admin',
                role: 'super_admin'
            }
        });
    }
    
    console.log('❌ Invalid credentials');
    res.status(401).json({ error: 'Invalid credentials' });
});

// ===== HEALTH =====
app.get('/health', (req, res) => {
    res.json({ status: 'healthy', time: new Date().toISOString() });
});

app.get('/api/test', (req, res) => {
    res.json({ message: 'API is working!' });
});

app.listen(port, () => {
    console.log(`✅ Server running on port ${port}`);
});