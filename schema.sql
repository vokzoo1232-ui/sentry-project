-- PostgreSQL Schema with fixes

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Schools table
CREATE TABLE schools (
    id SERIAL PRIMARY KEY,
    uuid UUID DEFAULT uuid_generate_v4() UNIQUE,
    name VARCHAR(255) NOT NULL,
    domain VARCHAR(255) UNIQUE NOT NULL,
    settings JSONB DEFAULT '{}'::jsonb,
    subscription_type VARCHAR(50) DEFAULT 'free',
    subscription_expires TIMESTAMP WITH TIME ZONE,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Admins table
CREATE TABLE admins (
    id SERIAL PRIMARY KEY,
    school_id INTEGER REFERENCES schools(id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    role VARCHAR(50) DEFAULT 'admin',
    last_login TIMESTAMP WITH TIME ZONE,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(school_id, email)
);

-- Teachers table
CREATE TABLE teachers (
    id SERIAL PRIMARY KEY,
    school_id INTEGER REFERENCES schools(id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    department VARCHAR(100),
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(school_id, email)
);

-- Students table
CREATE TABLE students (
    id SERIAL PRIMARY KEY,
    school_id INTEGER REFERENCES schools(id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    grade_level INTEGER,
    class_section VARCHAR(50),
    device_id VARCHAR(255),
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(school_id, email)
);

-- Rules table
CREATE TABLE rules (
    id SERIAL PRIMARY KEY,
    school_id INTEGER REFERENCES schools(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    type VARCHAR(50) NOT NULL CHECK (type IN ('blacklist', 'whitelist', 'schedule')),
    pattern TEXT NOT NULL,
    action VARCHAR(50) NOT NULL CHECK (action IN ('block', 'allow', 'warn')),
    priority INTEGER DEFAULT 0,
    schedule JSONB CHECK (
        (type != 'schedule' OR schedule IS NOT NULL) AND
        (type = 'schedule' OR schedule IS NULL)
    ),
    is_active BOOLEAN DEFAULT true,
    created_by INTEGER REFERENCES admins(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Logs table with proper foreign keys
CREATE TABLE logs (
    id BIGSERIAL PRIMARY KEY,
    school_id INTEGER REFERENCES schools(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES students(id) ON DELETE SET NULL,
    window_title TEXT,
    url TEXT,
    process_name VARCHAR(255),
    blocked BOOLEAN DEFAULT false,
    rule_triggered INTEGER REFERENCES rules(id) ON DELETE SET NULL,
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    metadata JSONB DEFAULT '{}'::jsonb
);

-- Sessions table
CREATE TABLE sessions (
    id BIGSERIAL PRIMARY KEY,
    school_id INTEGER REFERENCES schools(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES students(id) ON DELETE CASCADE,
    started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    ended_at TIMESTAMP WITH TIME ZONE,
    duration_seconds INTEGER,
    device_info JSONB,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Alerts table
CREATE TABLE alerts (
    id SERIAL PRIMARY KEY,
    school_id INTEGER REFERENCES schools(id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL,
    severity VARCHAR(20) DEFAULT 'info',
    message TEXT NOT NULL,
    data JSONB,
    is_resolved BOOLEAN DEFAULT false,
    resolved_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_logs_school_timestamp ON logs(school_id, timestamp DESC);
CREATE INDEX idx_logs_user_id ON logs(user_id);
CREATE INDEX idx_logs_blocked ON logs(blocked);
CREATE INDEX idx_logs_url ON logs(url) WHERE url IS NOT NULL;
CREATE INDEX idx_sessions_school_active ON sessions(school_id, is_active);
CREATE INDEX idx_rules_school_active ON rules(school_id, is_active);
CREATE INDEX idx_alerts_school_resolved ON alerts(school_id, is_resolved);
CREATE INDEX idx_admins_school ON admins(school_id);
CREATE INDEX idx_students_school ON students(school_id);

-- Views
CREATE VIEW active_sessions_view AS
SELECT 
    s.id,
    s.school_id,
    s.user_id,
    st.name as student_name,
    st.email as student_email,
    s.started_at,
    s.device_info,
    EXTRACT(EPOCH FROM (NOW() - s.started_at)) as seconds_active
FROM sessions s
JOIN students st ON st.id = s.user_id
WHERE s.is_active = true;

-- Cleanup function
CREATE OR REPLACE FUNCTION cleanup_old_logs() RETURNS void AS $$
BEGIN
    DELETE FROM logs WHERE timestamp < NOW() - INTERVAL '90 days';
    DELETE FROM sessions WHERE ended_at < NOW() - INTERVAL '90 days';
    DELETE FROM alerts WHERE created_at < NOW() - INTERVAL '180 days' AND is_resolved = true;
END;
$$ LANGUAGE plpgsql;

-- Updated at triggers
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_schools_updated_at BEFORE UPDATE ON schools FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_admins_updated_at BEFORE UPDATE ON admins FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_rules_updated_at BEFORE UPDATE ON rules FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_teachers_updated_at BEFORE UPDATE ON teachers FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_students_updated_at BEFORE UPDATE ON students FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();