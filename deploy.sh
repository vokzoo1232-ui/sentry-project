#!/bin/bash
set -e  # Exit on error
set -o pipefail

echo "🚀 Sentry Production Deployment"
echo "================================"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if running as root
if [ "$EUID" -ne 0 ]; then 
    echo -e "${RED}Please run as root${NC}"
    exit 1
fi

# Function to generate random password
generate_password() {
    openssl rand -base64 32 | tr -d '/+=' | cut -c1-24
}

# Create directories
echo -e "${YELLOW}Creating directories...${NC}"
mkdir -p /etc/sentry /var/log/sentry /var/run/sentry /opt/sentry
chmod 755 /etc/sentry /var/log/sentry /var/run/sentry /opt/sentry

# Generate secrets
echo -e "${YELLOW}Generating secrets...${NC}"
JWT_SECRET=$(openssl rand -base64 32)
DB_PASS=$(generate_password)
ADMIN_PASS=$(generate_password)

# Create .env file
cat > /etc/sentry/.env << EOF
# Sentry Environment Configuration
JWT_SECRET=${JWT_SECRET}
DB_PASSWORD=${DB_PASS}
DB_USER=sentry_admin
DB_NAME=sentry_db
DB_HOST=localhost
DB_PORT=5432
NODE_ENV=production
PORT=3000
ALLOWED_ORIGINS=https://sentry.yourdomain.com
EOF

chmod 600 /etc/sentry/.env

# Install system dependencies
echo -e "${YELLOW}Installing system dependencies...${NC}"
apt-get update -qq
apt-get install -y -qq postgresql postgresql-contrib nodejs npm \
    g++ libx11-dev build-essential curl nginx

# Setup PostgreSQL
echo -e "${YELLOW}Setting up PostgreSQL...${NC}"
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='sentry_admin'" | grep -q 1; then
    sudo -u postgres psql -c "CREATE USER sentry_admin WITH PASSWORD '${DB_PASS}';"
fi

if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='sentry_db'" | grep -q 1; then
    sudo -u postgres psql -c "CREATE DATABASE sentry_db OWNER sentry_admin;"
fi

# Run schema
echo -e "${YELLOW}Initializing database schema...${NC}"
sudo -u postgres psql -d sentry_db -f schema.sql

# Create initial admin
ADMIN_EMAIL="admin@${HOSTNAME:-localhost}.com"
echo -e "${YELLOW}Creating admin user: ${ADMIN_EMAIL}${NC}"
ADMIN_HASH=$(node -e "console.log(require('bcrypt').hashSync('${ADMIN_PASS}', 10))")
sudo -u postgres psql -d sentry_db << EOF
INSERT INTO schools (name, domain) VALUES ('Default School', '${HOSTNAME:-localhost}');
INSERT INTO admins (school_id, email, password_hash, name, role) 
VALUES (1, '${ADMIN_EMAIL}', '${ADMIN_HASH}', 'System Admin', 'super_admin')
ON CONFLICT (school_id, email) DO NOTHING;
EOF

# Install Node.js dependencies
echo -e "${YELLOW}Installing Node.js dependencies...${NC}"
cd /opt/sentry
npm init -y
npm install --production \
    express cors bcrypt jsonwebtoken pg helmet express-rate-limit express-validator \
    pm2

# Copy application files
echo -e "${YELLOW}Installing application files...${NC}"
cp server.js /opt/sentry/
cp rule_engine.js /opt/sentry/

# Build C++ daemon
echo -e "${YELLOW}Building C++ daemon...${NC}"
g++ -o /usr/local/bin/sentry_daemon daemon.cpp -lX11 -lpthread -lrt -std=c++17

# Setup daemon config
cat > /etc/sentry/config.conf << EOF
# Sentry Daemon Configuration
API_ENDPOINT=https://localhost:${PORT}/api/v1
AUTH_TOKEN=CHANGE_ME
EOF

# Setup systemd service
echo -e "${YELLOW}Setting up systemd service...${NC}"
cat > /etc/systemd/system/sentry-daemon.service << 'EOF'
[Unit]
Description=Sentry Daemon
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
User=root
EnvironmentFile=/etc/sentry/.env
ExecStart=/usr/local/bin/sentry_daemon
Restart=always
RestartSec=10
StandardOutput=syslog
StandardError=syslog
SyslogIdentifier=sentry

[Install]
WantedBy=multi-user.target
EOF

# Setup PM2 for API
echo -e "${YELLOW}Setting up PM2...${NC}"
cd /opt/sentry
pm2 start server.js --name sentry-api --env production
pm2 save
pm2 startup | tail -1 | bash

# Setup Nginx reverse proxy
echo -e "${YELLOW}Setting up Nginx...${NC}"
cat > /etc/nginx/sites-available/sentry << 'EOF'
server {
    listen 80;
    server_name _;
    
    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    
    # Health check
    location /health {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
    }
    
    # API
    location /api/ {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
EOF

ln -sf /etc/nginx/sites-available/sentry /etc/nginx/sites-enabled/
nginx -t && systemctl restart nginx

# Setup log rotation
echo -e "${YELLOW}Setting up log rotation...${NC}"
cat > /etc/logrotate.d/sentry << 'EOF'
/var/log/sentry/*.log {
    daily
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
    create 0640 root root
    postrotate
        systemctl reload sentry-daemon >/dev/null 2>&1 || true
        pm2 reload sentry-api >/dev/null 2>&1 || true
    endscript
}
EOF

# Setup cron for cleanup
echo -e "${YELLOW}Setting up cleanup cron...${NC}"
cat > /etc/cron.d/sentry << 'EOF'
# Cleanup old logs daily at 3am
0 3 * * * root sudo -u postgres psql -d sentry_db -c "SELECT cleanup_old_logs();"
EOF

# Create database backup script
echo -e "${YELLOW}Creating backup script...${NC}"
cat > /usr/local/bin/backup-sentry.sh << 'EOF'
#!/bin/bash
BACKUP_DIR="/var/backups/sentry"
mkdir -p "${BACKUP_DIR}"
DATE=$(date +%Y%m%d_%H%M%S)
sudo -u postgres pg_dump sentry_db > "${BACKUP_DIR}/sentry_${DATE}.sql"
gzip "${BACKUP_DIR}/sentry_${DATE}.sql"
# Keep last 7 backups
ls -t "${BACKUP_DIR}"/*.sql.gz | tail -n +8 | xargs rm -f
EOF

chmod +x /usr/local/bin/backup-sentry.sh

# Add to crontab
(crontab -l 2>/dev/null | grep -v backup-sentry.sh; echo "0 2 * * * /usr/local/bin/backup-sentry.sh") | crontab -

# Start services
echo -e "${YELLOW}Starting services...${NC}"
systemctl daemon-reload
systemctl enable sentry-daemon
systemctl start sentry-daemon
pm2 save

# Display summary
echo -e "\n${GREEN}✅ Sentry deployed successfully!${NC}"
echo "========================================"
echo "📊 Admin Credentials:"
echo "   Email: ${ADMIN_EMAIL}"
echo "   Password: ${ADMIN_PASS}"
echo ""
echo "🔐 Database Password: ${DB_PASS}"
echo "🔑 JWT Secret: ${JWT_SECRET}"
echo ""
echo "🌐 API Endpoint: https://$(hostname)/api"
echo "📁 Config: /etc/sentry/"
echo "📝 Logs: /var/log/sentry/"
echo "💾 Backups: /var/backups/sentry/"
echo ""
echo -e "${YELLOW}⚠️  IMPORTANT:${NC}"
echo "1. Save these credentials securely"
echo "2. Change the admin password immediately"
echo "3. Configure ALLOWED_ORIGINS in /etc/sentry/.env"
echo "4. Set up SSL certificate for production"
echo "5. Test the API: curl http://localhost:3000/health"
echo ""
echo "📖 Next steps:"
echo "   - Configure firewall (ufw)"
echo "   - Set up SSL (Let's Encrypt)"
echo "   - Monitor logs: journalctl -u sentry-daemon -f"
echo "   - PM2 status: pm2 status"

# Save credentials to secure file
cat > /root/sentry-credentials.txt << EOF
SENTRY CREDENTIALS - $(date)
========================================
Admin Email: ${ADMIN_EMAIL}
Admin Password: ${ADMIN_PASS}
Database Password: ${DB_PASS}
JWT Secret: ${JWT_SECRET}
========================================
Store this file securely and delete after saving!
EOF

chmod 600 /root/sentry-credentials.txt

echo -e "${RED}⚠️  Credentials saved to /root/sentry-credentials.txt${NC}"
echo -e "${RED}   Delete this file after saving credentials securely!${NC}"

# Final health check
echo -e "\n${YELLOW}Running health check...${NC}"
sleep 2
if curl -s http://localhost:3000/health | grep -q "healthy"; then
    echo -e "${GREEN}✅ API is healthy${NC}"
else
    echo -e "${RED}❌ API health check failed${NC}"
    echo "Check logs: journalctl -u sentry-daemon -n 50"
fi

echo -e "\n${GREEN}Deployment complete!${NC}"